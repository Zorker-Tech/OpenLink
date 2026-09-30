/**
 * Reviewing what an agent did on the desktop.
 *
 * What was done — the clicks, the typing, the pages it visited — is summarized into what a reader needs to judge it, and
 * a review that finds nothing worth asking about says so rather than staying silent.
 */
import { createHash } from "node:crypto";
import { Struct } from "@bufbuild/protobuf";
import type { Context } from "../../packages/context/context.ts";
import type { RemoteExecManager } from "../../packages/agent-exec/executor-resources.ts";
import type { ResourceAccessor } from "../../packages/agent-exec/resource-provider.ts";
import { tryExtractSlateAutoReviewClassifierConversationContext } from "../../packages/agent/smart-mode-classifier-context.ts";
import { withToolExecutionTimeoutSuspended } from "../../packages/agent/tools/tool-timeout-suspension.ts";
import { SmartModeRiskTarget, type SmartModeClassifierConversationMessage } from "../../packages/proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts";
import { fingerprintSlateAutoReviewTarget, type SlateAutoReviewController, type SlateAutoReviewMode } from "./slate-auto-review.ts";
import { summarizeSlateComputerTypedText } from "./slate-auto-review-summaries.ts";
import { runSlateAutoReviewClassifier, type AutoReviewClassifierDecision } from "./slate-auto-review-classifier-run.ts";
export const SLATE_COMPUTER_CLASSIFIER_TARGET_ACTION = "slate_computer";
export const SLATE_COMPUTER_AUTO_REVIEW_MAX_DESCRIPTION_CHARS = 500;
export const SLATE_COMPUTER_AUTO_REVIEW_MAX_TEXT_CHARS = 2_000;
export const SLATE_COMPUTER_AUTO_REVIEW_MAX_KEY_CHARS = 256;
export const SLATE_COMPUTER_AUTO_REVIEW_MAX_PATH_POINTS = 64;
export const SLATE_COMPUTER_AUTO_REVIEW_CLASSIFIER_ERROR_REASON = "An error occurred while classifying this action. Please review manually.";
export const SLATE_COMPUTER_PAGE_STATE_CHROME_UNREACHABLE = "chrome-unreachable";
export const SLATE_COMPUTER_AUTO_REVIEW_BYPASS_ACTIONS = ["screenshot", "move", "wait", "scroll"] as const;
const BYPASS = new Set<string>(SLATE_COMPUTER_AUTO_REVIEW_BYPASS_ACTIONS);
export class SlateComputerAutoReviewBlockedError extends Error { override readonly name = "SlateComputerAutoReviewBlockedError"; }
export type SlateComputerReviewActionKind =
  | "screenshot"
  | "click"
  | "move"
  | "drag"
  | "type"
  | "key"
  | "scroll"
  | "wait";
export interface ComputerAction { readonly action: SlateComputerReviewActionKind; readonly x?: number; readonly y?: number; readonly x2?: number; readonly y2?: number; readonly text?: string; readonly key?: string; readonly path?: readonly unknown[]; readonly [key: string]: unknown }
export interface BoxIdentity { readonly boxId: string; readonly windowGeneration: string }

export function computeSlateComputerPageStateIdentity(stdout: string): string {
  const lines: string[] = [];
  try { const parsed = JSON.parse(stdout) as unknown; if (Array.isArray(parsed)) for (const target of parsed) if (typeof target === "object" && target != null && (target as Record<string, unknown>).type === "page" && typeof (target as Record<string, unknown>).id === "string") lines.push(`${(target as Record<string, unknown>).id}\t${typeof (target as Record<string, unknown>).url === "string" ? String((target as Record<string, unknown>).url).trim() : ""}`); }
  catch { for (const line of stdout.split("\n")) if (line.trim()) lines.push(line.trim()); }
  return createHash("sha256").update(lines.sort().join("\n")).digest("hex");
}
export const isSlateComputerAutoReviewBypassAction = (action: string): boolean => BYPASS.has(action);
export const isSlateComputerAutoReviewMutatingAction = (action: string): boolean => !BYPASS.has(action);
export const requiresSlateComputerDeclaredDescription = (action: string): boolean => action === "click" || action === "drag";
function reject(field: string, max: number): never { throw new SlateComputerAutoReviewBlockedError(`Computer Auto-review rejected oversized ${field} (max ${max} characters).`); }
export function normalizeSlateComputerExactActionArgs<T extends ComputerAction>(raw: T): T { if ((raw.text?.length ?? 0) > 2_000) reject("text", 2_000); if ((raw.key?.length ?? 0) > 256) reject("key", 256); if ((raw.path?.length ?? 0) > 64) reject("path", 64); return raw; }
export function normalizeSlateComputerDescription(description?: string): string | undefined { const trimmed = description?.trim(); if (!trimmed) return undefined; if (trimmed.length > 500) reject("description", 500); return trimmed; }
export function buildSlateComputerAutoReviewCanonicalTarget(args: { exactAction: ComputerAction; description?: string; boxIdentity: BoxIdentity; displayStateIdentity: string }) { return { exactAction: normalizeSlateComputerExactActionArgs(args.exactAction), ...(normalizeSlateComputerDescription(args.description) == null ? {} : { description: normalizeSlateComputerDescription(args.description) }), boxIdentity: args.boxIdentity, displayStateIdentity: args.displayStateIdentity }; }
export function fingerprintSlateComputerAutoReviewTarget(target: ReturnType<typeof buildSlateComputerAutoReviewCanonicalTarget>): string { return fingerprintSlateAutoReviewTarget({ exact_action: target.exactAction, description: target.description ?? "", window_generation: target.boxIdentity.windowGeneration, box_id: target.boxIdentity.boxId, display_state_identity: target.displayStateIdentity }); }
export function buildProjectPermissionsContext(args: { personalInstructions?: { allowInstructions?: readonly string[]; blockInstructions?: readonly string[] }; userAutoRunInstructions?: { allowInstructions?: readonly string[]; blockInstructions?: readonly string[] }; projectAutoRunInstructions?: { allowInstructions?: readonly string[]; blockInstructions?: readonly string[] } }): unknown {
  const collect = (kind: "allowInstructions" | "blockInstructions") => [...new Set([...(args.personalInstructions?.[kind] ?? []), ...(args.userAutoRunInstructions?.[kind] ?? []), ...(args.projectAutoRunInstructions?.[kind] ?? [])].map((value) => value.trim()).filter(Boolean))];
  const allow = collect("allowInstructions"), block = collect("blockInstructions");
  return allow.length === 0 && block.length === 0 ? undefined : { auto_run: { allow_instructions: allow, block_instructions: block } };
}
export function buildSlateComputerClassifierRiskTarget(args: { canonicalTarget: ReturnType<typeof buildSlateComputerAutoReviewCanonicalTarget>; personalInstructions?: { allowInstructions?: readonly string[]; blockInstructions?: readonly string[] }; userAutoRunInstructions?: { allowInstructions?: readonly string[]; blockInstructions?: readonly string[] }; projectAutoRunInstructions?: { allowInstructions?: readonly string[]; blockInstructions?: readonly string[] } }): unknown {
  const action = args.canonicalTarget.exactAction;
  const argumentsJson = JSON.parse(JSON.stringify({
    surface: "computer",
    action_kind: action.action,
    coordinates: action.x == null || action.y == null ? undefined : { x: action.x, y: action.y },
    end_coordinates: action.x2 == null || action.y2 == null ? undefined : { x: action.x2, y: action.y2 },
    path: action.path,
    button: action.button,
    count: action.count,
    text: action.text,
    key: action.key,
    direction: action.direction,
    amount: action.amount,
    duration_ms: action.durationMs,
    declared_purpose: args.canonicalTarget.description,
    box: {
      box_id: args.canonicalTarget.boxIdentity.boxId,
      window_generation: args.canonicalTarget.boxIdentity.windowGeneration,
      display_state_identity: args.canonicalTarget.displayStateIdentity,
    },
    project_permissions: buildProjectPermissionsContext(args),
  }));
  return new SmartModeRiskTarget({
    action: SLATE_COMPUTER_CLASSIFIER_TARGET_ACTION,
    arguments: Struct.fromJson(argumentsJson),
  });
}
export function summarizeBlockedAction(target: ReturnType<typeof buildSlateComputerAutoReviewCanonicalTarget>, fingerprint: string, reason: string) {
  const action = target.exactAction, purpose = target.description == null ? "" : ` to ${target.description.slice(0, 160)}`;
  const summary = action.action === "click" ? `Click at (${action.x}, ${action.y}) on Slate's computer${purpose}` : action.action === "drag" ? `Drag from (${action.x}, ${action.y}) to (${action.x2}, ${action.y2}) on Slate's computer${purpose}` : action.action === "type" ? summarizeSlateComputerTypedText(action.text ?? "") : `Press ${action.key?.slice(0, 80) ?? "a key"} on Slate's computer`;
  return { surface: "computer", fingerprint, reason, summary };
}

export interface SlateComputerAutoReviewOptions {
  readonly mode: SlateAutoReviewMode;
  readonly agentId: string;
  readonly boxIdentity: BoxIdentity;
  readonly autoReviewController?: SlateAutoReviewController;
  readonly resolveDisplayNumber: (ctx: Context) => Promise<number | undefined>;
  readonly personalInstructions?: { readonly allowInstructions?: readonly string[]; readonly blockInstructions?: readonly string[] };
  readonly userAutoRunInstructions?: { readonly allowInstructions?: readonly string[]; readonly blockInstructions?: readonly string[] };
  readonly projectAutoRunInstructions?: { readonly allowInstructions?: readonly string[]; readonly blockInstructions?: readonly string[] };
  readonly extractConversationContext?: (ctx: Context, stateHandler: unknown) => Promise<readonly SmartModeClassifierConversationMessage[]>;
  readonly getApprovalExpiryPolicy?: () => "park" | "ttl";
  readonly devBlockState?: { consume(): boolean };
}

async function runComputerClassifier(
  ctx: Context,
  args: {
    readonly options: SlateComputerAutoReviewOptions;
    readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
    readonly toolCallId: string;
    readonly stateHandler?: unknown;
    readonly workspacePaths?: readonly string[];
  },
  mode: "shadow" | "enforce",
  canonicalTarget: ReturnType<typeof buildSlateComputerAutoReviewCanonicalTarget>,
): Promise<AutoReviewClassifierDecision> {
  if (args.options.devBlockState?.consume() === true) {
    return { kind: "block", reason: "This is a dev block whatever just retry it" };
  }
  return runSlateAutoReviewClassifier({
    ctx,
    resourceAccessor: args.resourceAccessor,
    toolCallId: args.toolCallId,
    mode,
    buildTarget: () => buildSlateComputerClassifierRiskTarget({
      canonicalTarget,
      ...(args.options.personalInstructions === undefined ? {} : { personalInstructions: args.options.personalInstructions }),
      ...(args.options.userAutoRunInstructions === undefined ? {} : { userAutoRunInstructions: args.options.userAutoRunInstructions }),
      ...(args.options.projectAutoRunInstructions === undefined ? {} : { projectAutoRunInstructions: args.options.projectAutoRunInstructions }),
    }) as SmartModeRiskTarget,
    loadConversationContext: async () => {
      if (args.stateHandler === undefined) return [];
      if (args.options.extractConversationContext !== undefined) {
        return [...await args.options.extractConversationContext(ctx, args.stateHandler)];
      }
      return [...await tryExtractSlateAutoReviewClassifierConversationContext(ctx, args.stateHandler as never)];
    },
    ...(args.workspacePaths === undefined ? {} : { workspacePaths: args.workspacePaths }),
    errorReason: SLATE_COMPUTER_AUTO_REVIEW_CLASSIFIER_ERROR_REASON,
  });
}

export async function runSlateComputerAutoReviewPreflight(args: {
  readonly ctx: Context;
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
  readonly exactAction: ComputerAction;
  readonly description?: string;
  readonly toolCallId: string;
  readonly stateHandler?: unknown;
  readonly workspacePaths?: readonly string[];
  readonly signal?: AbortSignal;
  readonly options: SlateComputerAutoReviewOptions & {
    readonly captureDisplayStateIdentity: (ctx: Context, toolCallId: string) => Promise<string>;
  };
}): Promise<void> {
  const { options } = args, action = args.exactAction.action;
  if (options.mode === "off" || !isSlateComputerAutoReviewMutatingAction(action)) return;
  if (options.mode === "enforce" && requiresSlateComputerDeclaredDescription(action) && normalizeSlateComputerDescription(args.description) == null) throw new SlateComputerAutoReviewBlockedError("Computer click and drag actions require a concise description field stating the intended UI target and purpose.");
  const canonical = buildSlateComputerAutoReviewCanonicalTarget({ exactAction: args.exactAction, ...(args.description == null ? {} : { description: args.description }), boxIdentity: options.boxIdentity, displayStateIdentity: await options.captureDisplayStateIdentity(args.ctx, args.toolCallId) });
  const recheck = async (): Promise<void> => { if (await options.captureDisplayStateIdentity(args.ctx, args.toolCallId) !== canonical.displayStateIdentity) { options.autoReviewController?.reportDisplayRecheckFailed(options.agentId); throw new SlateComputerAutoReviewBlockedError("The page changed after review; inspect the latest screenshot and retry the action."); } };
  const classifierArgs = {
    options,
    resourceAccessor: args.resourceAccessor,
    toolCallId: args.toolCallId,
    ...(args.stateHandler === undefined ? {} : { stateHandler: args.stateHandler }),
    ...(args.workspacePaths === undefined ? {} : { workspacePaths: args.workspacePaths }),
  };
  if (options.mode === "shadow") { void runComputerClassifier(args.ctx, classifierArgs, "shadow", canonical).catch(() => {}); return; }
  const decision = await runComputerClassifier(args.ctx, classifierArgs, "enforce", canonical);
  if (decision.kind === "allow") { await recheck(); return; }
  if (decision.kind === "block" && options.autoReviewController != null) {
    const fingerprint = fingerprintSlateComputerAutoReviewTarget(canonical), blocked = summarizeBlockedAction(canonical, fingerprint, decision.reason);
    const approval = await withToolExecutionTimeoutSuspended(args.ctx, () => options.autoReviewController!.requestApproval({ agentId: options.agentId, surface: "computer", fingerprint, reason: decision.reason, summary: blocked.summary, ...(decision.proposedRule == null ? {} : { proposedRule: decision.proposedRule }), ...(args.signal == null ? {} : { signal: args.signal }), ...(options.getApprovalExpiryPolicy == null ? {} : { expiryPolicy: options.getApprovalExpiryPolicy() }) }));
    if (args.signal?.aborted === true) throw new SlateComputerAutoReviewBlockedError("The Computer action was cancelled.");
    if (approval.approved) { await recheck(); return; }
    throw new SlateComputerAutoReviewBlockedError(approval.reason ?? decision.reason);
  }
  throw new SlateComputerAutoReviewBlockedError(decision.reason);
}
export const slateComputerDeclaredPurposeParameter = { type: "string", optional: true, description: "Concise model-facing intent for this action. Required for click and drag in Auto-review enforce mode; include for type/key when it clarifies purpose." };
