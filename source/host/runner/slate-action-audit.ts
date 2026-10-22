/**
 * Auditing what an agent did.
 *
 * Every action a turn takes is recorded with what it was and what it touched, in the order it happened, so what an agent
 * did can be read back after the fact rather than reconstructed from the transcript.
 */
import { requestIdKey } from "../../packages/chat-inference-proto/client.ts";
import { shellExecutorResource } from "../../packages/agent-exec/shell.ts";
import { delay } from "../../packages/utils/promise-tools.ts";
import {
  buildHostShellArgs,
  type HostShellArgsInput,
} from "../boxes/box-shell-command.ts";
import type { ShellArgs, ShellResult } from "../../packages/proto/generated/agent/v1/shell_exec_pb.ts";
import type { ActionAuditor } from "./site-visit-tracking.ts";

/** Whether an MCP call's answer counts as a success or a failure for the audit. */
export function mcpAuditStatus(result: any): "ok" | "error" {
  if (result.result.case === "success") {
    return result.result.value.isError ? "error" : "ok";
  }
  return result.result.case === "approved" ? "ok" : "error";
}

export function wrapMcpExecutorForAudit<
  Context,
  Args extends { providerIdentifier: string; toolCallId?: string; name: string },
  Result,
>(
  inner: { execute(ctx: Context, args: Args, options?: unknown): Promise<Result> },
  deps: {
    agentId: string;
    auditor: ActionAuditor;
    resolveTransport(server: string): Promise<string>;
    getTurnId?(ctx: Context): string | undefined;
    now?: () => number;
  },
) {
  return {
    async execute(ctx: Context, args: Args, options?: unknown): Promise<Result> {
      const clock = deps.now ?? Date.now;
      const startedAtMs = clock();
      const transport = deps.resolveTransport(args.providerIdentifier).catch(() => "unknown");
      const report = (status: "ok" | "error"): void => {
        const durationMs = clock() - startedAtMs;
        void transport.then(resolved => deps.auditor.record({
          agentId: deps.agentId,
          ...(deps.getTurnId?.(ctx) == null ? {} : { turnId: deps.getTurnId?.(ctx) }),
          occurredAtMs: startedAtMs,
          action: {
            kind: "mcpToolCall",
            toolCallId: args.toolCallId ?? "",
            serverIdentifier: args.providerIdentifier,
            serverName: args.providerIdentifier,
            toolName: args.name,
            transport: resolved,
            status,
            durationMs,
          },
        })).catch(() => {});
      };
      try {
        const result = await inner.execute(ctx, args, options);
        report(mcpAuditStatus(result));
        return result;
      } catch (error) {
        report("error");
        throw error;
      }
    },
  };
}

export const NAVIGATION_PROBE_CDP_BASE_PORT = 9_222;
export const NAVIGATION_PROBE_MIN_INTERVAL_MS = 2_000;
export const IGNORED_URL_PREFIXES = [
  "about:",
  "chrome://",
  "chrome-extension://",
  "chrome-untrusted://",
  "devtools://",
];

export function navigationProbeCommand(displayNumber: number): string {
  const port = NAVIGATION_PROBE_CDP_BASE_PORT + displayNumber;
  return `curl -sf --max-time 2 "http://127.0.0.1:${port}/json/list"`;
}

export function normalizeNavigationUrl(rawUrl: string): string | undefined {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return undefined;
  for (const prefix of IGNORED_URL_PREFIXES) {
    if (trimmed.startsWith(prefix)) return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.origin === "null") return undefined;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/** Every JSON array the probe's output contains, as its object entries. */
export function parseNavigationProbeOutput(stdout: string): Record<string, unknown>[] {
  const targets: Record<string, unknown>[] = [];
  let depth = 0;
  let arrayStart = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < stdout.length; index += 1) {
    const character = stdout[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") inString = true;
    else if (character === "[" || character === "{") {
      if (depth === 0 && character === "[") arrayStart = index;
      depth += 1;
    } else if (character === "]" || character === "}") {
      depth -= 1;
      if (depth === 0 && arrayStart >= 0) {
        try {
          const parsed: unknown = JSON.parse(stdout.slice(arrayStart, index + 1));
          if (Array.isArray(parsed)) {
            for (const entry of parsed) {
              if (typeof entry === "object" && entry != null) targets.push(entry as Record<string, unknown>);
            }
          }
        } catch {}
        arrayStart = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return targets;
}

export interface NavigationProbeDependencies<Context> {
  readonly agentId: string;
  readonly auditor: ActionAuditor;
  readonly now?: () => number;
  readonly getBoxId?: () => string;
  readonly getTurnId?: (ctx: Context) => string | undefined;
  /** Exact immutable path: generated ShellArgs plus the bound Shell resource. */
  readonly buildShellArgs?: ((input: HostShellArgsInput) => ShellArgs) | undefined;
  /** Legacy coordinator input retained until its production consumer flips. */
  readonly executeShell?: ((ctx: Context, args: HostShellArgsInput) => Promise<ShellResult>) | undefined;
}

interface GeneratedShellAccessor<Context> {
  get(resource: typeof shellExecutorResource): {
    execute(context: Context, args: ShellArgs): Promise<ShellResult>;
  };
}

/** Whether a value is the generated resource accessor a shell is run through. */
function isGeneratedShellAccessor<Context>(value: unknown): value is GeneratedShellAccessor<Context> {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "get") === "function";
}

/** The request id a context carries, when it carries one. */
function requestIdFromContext(value: unknown): string | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  const get = Reflect.get(value, "get");
  if (typeof get !== "function") return undefined;
  const requestId: unknown = get.call(value, requestIdKey);
  return typeof requestId === "string" ? requestId : undefined;
}

/** The shell call the navigation probe makes on one display. */
function navigationProbeShellInput(displayNumber: number): HostShellArgsInput {
  return {
    command: navigationProbeCommand(displayNumber),
    name: "curl",
    workingDirectory: "/workspace",
    toolCallId: "slate-navigation-probe",
  };
}

/** A browser target the probe reported: its page id, its URL and its title. */
interface NavigationTarget { readonly pageId: string; readonly url: string; readonly title: string }

/** The page targets in a probe answer that are worth recording. */
function navigationTargetsIn(stdout: string): NavigationTarget[] {
  const found: NavigationTarget[] = [];
  for (const target of parseNavigationProbeOutput(stdout)) {
    if (target.type !== "page") continue;
    const pageId = typeof target.id === "string" ? target.id : "";
    if (pageId.length === 0) continue;
    const url = normalizeNavigationUrl(typeof target.url === "string" ? target.url : "");
    if (url === undefined) continue;
    found.push({ pageId, url, title: typeof target.title === "string" ? target.title : "" });
  }
  return found;
}

export function createSlateNavigationProbe<Context>(deps: NavigationProbeDependencies<Context>) {
  const clock = deps.now ?? Date.now;
  const lastUrlByPage = new Map<string, string>();
  let lastProbeAtMs = 0;
  let probing = false;
  let trailingQueued = false;
  let baselineRunning = false;
  let queuedWhileBaseline: {
    readonly ctx: Context;
    readonly remoteAccessor: unknown;
    readonly displayNumber: number;
  } | null = null;
  let requestedTurnId: string | undefined;

  const recordNavigation = (target: NavigationTarget, occurredAtMs: number): void => {
    deps.auditor.record({
      agentId: deps.agentId,
      ...(requestedTurnId === undefined ? {} : { turnId: requestedTurnId }),
      ...(deps.getBoxId?.() === undefined ? {} : { boxId: deps.getBoxId?.() }),
      occurredAtMs,
      action: { kind: "browserNavigation", url: target.url, pageTitle: target.title },
    });
  };

  const auditProbeAnswer = (stdout: string, mode: "baseline" | "report"): void => {
    const occurredAtMs = clock();
    for (const target of navigationTargetsIn(stdout)) {
      if (lastUrlByPage.get(target.pageId) === target.url) continue;
      lastUrlByPage.set(target.pageId, target.url);
      if (mode === "baseline") continue;
      recordNavigation(target, occurredAtMs);
    }
  };

  const probeWithAccessor = async (
    context: Context,
    remoteAccessor: unknown,
    displayNumber: number,
    mode: "baseline" | "report",
  ): Promise<void> => {
    if (!Number.isInteger(displayNumber) || displayNumber < 0) return;
    if (!isGeneratedShellAccessor<Context>(remoteAccessor)) return;
    const result = await remoteAccessor.get(shellExecutorResource).execute(
      context,
      (deps.buildShellArgs ?? buildHostShellArgs)(navigationProbeShellInput(displayNumber)),
    );
    if (result.result.case !== "success" || result.result.value.exitCode !== 0) return;
    auditProbeAnswer(result.result.value.stdout, mode);
  };

  const probeWithShell = async (context: Context, displayNumber: number, mode: "baseline" | "report"): Promise<void> => {
    if (deps.executeShell === undefined) return;
    const result = await deps.executeShell(context, navigationProbeShellInput(displayNumber));
    if (result.result.case !== "success" || result.result.value?.exitCode !== 0) return;
    auditProbeAnswer(result.result.value.stdout ?? "", mode);
  };

  const runProbe = (context: Context, remoteAccessor: unknown, displayNumber: number, mode: "baseline" | "report") =>
    isGeneratedShellAccessor<Context>(remoteAccessor)
      ? probeWithAccessor(context, remoteAccessor, displayNumber, mode)
      : probeWithShell(context, displayNumber, mode);

  const queueProbe = (context: Context, remoteAccessor: unknown, displayNumber: number): void => {
    if (baselineRunning) {
      queuedWhileBaseline = { ctx: context, remoteAccessor, displayNumber };
      return;
    }
    const at = clock();
    if (probing || at - lastProbeAtMs < NAVIGATION_PROBE_MIN_INTERVAL_MS) {
      if (!trailingQueued) {
        trailingQueued = true;
        void delay(NAVIGATION_PROBE_MIN_INTERVAL_MS).then(() => {
          trailingQueued = false;
          queueProbe(context, remoteAccessor, displayNumber);
        });
      }
      return;
    }
    lastProbeAtMs = at;
    probing = true;
    void runProbe(context, remoteAccessor, displayNumber, "report").catch(() => {}).finally(() => { probing = false; });
  };

  const probe = (context: Context, remoteAccessor: unknown, displayNumber: number): void => {
    requestedTurnId = deps.getTurnId?.(context) ?? requestIdFromContext(context);
    queueProbe(context, remoteAccessor, displayNumber);
  };

  let baselinePass: Promise<void> | undefined;
  const captureBaseline = (
    context: Context,
    remoteAccessor: unknown,
    displayNumber: number,
  ): Promise<void> => {
    if (baselinePass !== undefined) return baselinePass;
    probing = true;
    baselineRunning = true;
    baselinePass = runProbe(context, remoteAccessor, displayNumber, "baseline").catch(() => {}).finally(() => {
      probing = false;
      baselineRunning = false;
      const queued = queuedWhileBaseline;
      queuedWhileBaseline = null;
      if (queued !== null) queueProbe(queued.ctx, queued.remoteAccessor, queued.displayNumber);
    });
    return baselinePass;
  };

  return { probe, captureBaseline };
}

/** The audit kind a computer-use action case is recorded as. */
const COMPUTER_USE_AUDIT_KINDS = new Map<string, string>([
  ["screenshot", "screenshot"],
  ["click", "click"],
  ["mouseMove", "mouse_move"],
  ["drag", "drag"],
  ["type", "type"],
  ["key", "key"],
  ["scroll", "scroll"],
  ["wait", "wait"],
]);

export function computerUseAuditKind(actionCase: string): string | undefined {
  return COMPUTER_USE_AUDIT_KINDS.get(actionCase);
}