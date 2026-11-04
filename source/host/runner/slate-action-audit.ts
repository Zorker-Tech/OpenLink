/**
 * Auditing what an agent did.
 *
 * Every action a turn takes is recorded with what it was and what it touched, in the order it happened, so what an agent
 * did can be read back after the fact rather than reconstructed from the transcript.
 */
import { delay } from "../../packages/utils/promise-tools.ts";
import {
  requestIdFromInteropContext,
  runNavigationProbeShellThroughInterop,
  type NavigationProbeShellOutcome,
} from "../../adapters/interop/agent/navigation-probe-shell-adapter.ts";
import type { HostShellArgsInput } from "../boxes/box-shell-command.ts";
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
  readonly executeShell?: ((ctx: Context, args: HostShellArgsInput) => Promise<NavigationProbeShellOutcome>) | undefined;
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

  const probeWithShell = async (context: Context, displayNumber: number, mode: "baseline" | "report"): Promise<void> => {
    if (deps.executeShell === undefined) return;
    const result = await deps.executeShell(context, navigationProbeShellInput(displayNumber));
    if (result.case !== "success" || result.exitCode !== 0) return;
    auditProbeAnswer(result.stdout, mode);
  };

  const runProbe = async (context: Context, remoteAccessor: unknown, displayNumber: number, mode: "baseline" | "report"): Promise<void> => {
    if (!Number.isInteger(displayNumber) || displayNumber < 0) return
    const interopResult = await runNavigationProbeShellThroughInterop(context, remoteAccessor, navigationProbeShellInput(displayNumber))
    if (interopResult !== undefined) {
      if (interopResult.case === "success" && interopResult.exitCode === 0) auditProbeAnswer(interopResult.stdout, mode)
      return
    }
    await probeWithShell(context, displayNumber, mode)
  }

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
    requestedTurnId = deps.getTurnId?.(context) ?? requestIdFromInteropContext(context);
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
