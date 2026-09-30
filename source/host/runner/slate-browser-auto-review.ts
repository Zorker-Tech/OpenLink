/**
 * Reviewing what an agent did in the browser.
 *
 * The pages it visited and what it read are summarized into what a reader needs to judge the visit, and a page that was
 * not what it claimed to be is called out rather than passed over.
 */
import { Struct } from "@bufbuild/protobuf";
import type { Context } from "../../packages/context/context.ts";
import type { RemoteExecManager } from "../../packages/agent-exec/executor-resources.ts";
import type { ResourceAccessor } from "../../packages/agent-exec/resource-provider.ts";
import { tryExtractSlateAutoReviewClassifierConversationContext } from "../../packages/agent/smart-mode-classifier-context.ts";
import { withToolExecutionTimeoutSuspended } from "../../packages/agent/tools/tool-timeout-suspension.ts";
import { SmartModeRiskTarget, type SmartModeClassifierConversationMessage } from "../../packages/proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts";
import { fingerprintSlateAutoReviewTarget, type SlateAutoReviewController, type SlateAutoReviewMode } from "./slate-auto-review.ts";
import type { AutoReviewClassifierDecision } from "./slate-auto-review-classifier-run.ts";
import { runSlateAutoReviewClassifier } from "./slate-auto-review-classifier-run.ts";
import { summarizeSlateBrowserAutoReviewAction } from "./slate-auto-review-summaries.ts";
import { buildProjectPermissionsContext, SLATE_COMPUTER_CLASSIFIER_TARGET_ACTION, type BoxIdentity } from "./slate-computer-auto-review.ts";
export const SLATE_BROWSER_AUTO_REVIEW_MAX_ELEMENT_CHARS = 500, SLATE_BROWSER_AUTO_REVIEW_MAX_TEXT_CHARS = 2_000, SLATE_BROWSER_AUTO_REVIEW_MAX_URL_CHARS = 2_000, SLATE_BROWSER_AUTO_REVIEW_MAX_KEY_CHARS = 256, SLATE_BROWSER_AUTO_REVIEW_MAX_CDP_PARAMS_CHARS = 2_000;
const BYPASS = new Set(["snapshot", "screenshot", "get_bounding_box", "highlight", "scroll"]);
export class SlateBrowserAutoReviewBlockedError extends Error { override readonly name = "SlateBrowserAutoReviewBlockedError"; }
export interface BrowserAction { readonly op: string; readonly tabsAction?: string | undefined; readonly element?: string | undefined; readonly url?: string | undefined; readonly text?: string | undefined; readonly value?: string | undefined; readonly values?: readonly string[] | undefined; readonly key?: string | undefined; readonly cdpMethod?: string | undefined; readonly cdpParams?: string | undefined; readonly tabIndex?: number | undefined; readonly [key: string]: unknown }
export function isSlateBrowserAutoReviewMutatingAction(action: BrowserAction): boolean { return action.op === "tabs" ? action.tabsAction === "new" || action.tabsAction === "close" : !BYPASS.has(action.op); }
function bounded(value: string | undefined, field: string, max: number): void { if ((value?.length ?? 0) > max) throw new SlateBrowserAutoReviewBlockedError(`Browser Auto-review rejected oversized ${field} (max ${max} characters).`); }
export function normalizeSlateBrowserExactActionArgs<T extends BrowserAction>(action: T): T { bounded(action.url, "url", 2_000); bounded(action.text, "text", 2_000); bounded(action.value, "value", 2_000); bounded(action.key, "key", 256); bounded(action.cdpParams, "params", 2_000); if ((action.values?.join(", ").length ?? 0) > 2_000) bounded("x".repeat(2_001), "values", 2_000); return action; }
export function normalizeSlateBrowserElement(element?: string): string | undefined { const trimmed = element?.trim(); if (!trimmed) return undefined; bounded(trimmed, "element", 500); return trimmed; }
export function buildSlateBrowserAutoReviewCanonicalTarget(args: { exactAction: BrowserAction; boxIdentity: BoxIdentity; reviewState: { displayStateIdentity: string; targetPageUrl?: string } }) { const action = normalizeSlateBrowserExactActionArgs(args.exactAction), element = normalizeSlateBrowserElement(action.element); return { exactAction: { ...action, ...(element == null ? {} : { element }) }, boxIdentity: args.boxIdentity, displayStateIdentity: args.reviewState.displayStateIdentity, ...(args.reviewState.targetPageUrl == null ? {} : { targetPageUrl: args.reviewState.targetPageUrl }) }; }
export function fingerprintSlateBrowserAutoReviewTarget(target: ReturnType<typeof buildSlateBrowserAutoReviewCanonicalTarget>): string { return fingerprintSlateAutoReviewTarget({ exact_action: target.exactAction, window_generation: target.boxIdentity.windowGeneration, box_id: target.boxIdentity.boxId, display_state_identity: target.displayStateIdentity, target_page_url: target.targetPageUrl }); }
export function buildSlateBrowserClassifierRiskTarget(args: { canonicalTarget: ReturnType<typeof buildSlateBrowserAutoReviewCanonicalTarget>; personalInstructions?: { allowInstructions?: readonly string[]; blockInstructions?: readonly string[] }; userAutoRunInstructions?: { allowInstructions?: readonly string[]; blockInstructions?: readonly string[] }; projectAutoRunInstructions?: { allowInstructions?: readonly string[]; blockInstructions?: readonly string[] } }): unknown {
  const action: BrowserAction = args.canonicalTarget.exactAction;
  const argumentsJson = JSON.parse(JSON.stringify({
    surface: "browser",
    action_kind: `browser_${action.op}`,
    view_id: action.viewId,
    target_page_url: args.canonicalTarget.targetPageUrl,
    url: action.url,
    ref: action.ref,
    text: action.text,
    value: action.value,
    values: action.values,
    key: action.key,
    cdp_method: action.cdpMethod,
    cdp_params: action.cdpParams,
    tabs_action: action.tabsAction,
    tab_index: action.tabIndex,
    coordinates: action.x == null || action.y == null ? undefined : { x: action.x, y: action.y },
    drag_source_ref: action.sourceRef,
    drag_target_ref: action.targetRef,
    drag_target_coordinates: action.targetX == null || action.targetY == null ? undefined : { x: action.targetX, y: action.targetY },
    new_tab: action.newTab,
    submit: action.submit,
    clear: action.clear,
    double_click: action.doubleClick,
    button: action.button,
    modifiers: action.modifiers,
    declared_purpose: action.element,
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

export interface SlateBrowserAutoReviewOptions {
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
}

export async function runSlateBrowserAutoReviewPreflight(args: {
  readonly ctx: Context;
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
  readonly exactAction: BrowserAction;
  readonly toolCallId: string;
  readonly stateHandler?: unknown;
  readonly workspacePaths?: readonly string[];
  readonly signal?: AbortSignal;
  readonly options: SlateBrowserAutoReviewOptions & {
    readonly captureReviewState: (ctx: Context, toolCallId: string) => Promise<{ displayStateIdentity: string; targetPageUrl?: string }>;
  };
}): Promise<void> {
  const { options } = args, op = args.exactAction.op;
  if (options.mode === "off" || !isSlateBrowserAutoReviewMutatingAction(args.exactAction)) return;
  if (options.mode === "enforce" && ["click", "mouse_click_xy", "drag"].includes(op) && normalizeSlateBrowserElement(args.exactAction.element) == null) throw new SlateBrowserAutoReviewBlockedError("Browser click and drag actions require an element field: a concise description of the intended target and purpose.");
  const classifierMode = options.mode === "shadow" ? "shadow" : "enforce";
  const canonical = buildSlateBrowserAutoReviewCanonicalTarget({ exactAction: args.exactAction, boxIdentity: options.boxIdentity, reviewState: await options.captureReviewState(args.ctx, args.toolCallId) }), fingerprint = fingerprintSlateBrowserAutoReviewTarget(canonical);
  const recheck = async (): Promise<void> => { if ((await options.captureReviewState(args.ctx, args.toolCallId)).displayStateIdentity !== canonical.displayStateIdentity) { options.autoReviewController?.reportDisplayRecheckFailed(options.agentId); throw new SlateBrowserAutoReviewBlockedError("The page changed after review; take a fresh browser_snapshot and retry the action."); } };
  const runClassifier = () => runSlateAutoReviewClassifier({
    ctx: args.ctx,
    resourceAccessor: args.resourceAccessor,
    toolCallId: args.toolCallId,
    mode: classifierMode,
    buildTarget: () => buildSlateBrowserClassifierRiskTarget({ canonicalTarget: canonical, ...(options.personalInstructions === undefined ? {} : { personalInstructions: options.personalInstructions }), ...(options.userAutoRunInstructions === undefined ? {} : { userAutoRunInstructions: options.userAutoRunInstructions }), ...(options.projectAutoRunInstructions === undefined ? {} : { projectAutoRunInstructions: options.projectAutoRunInstructions }) }) as SmartModeRiskTarget,
    loadConversationContext: async () => {
      if (args.stateHandler === undefined) return [];
      if (options.extractConversationContext !== undefined) return [...await options.extractConversationContext(args.ctx, args.stateHandler)];
      return [...await tryExtractSlateAutoReviewClassifierConversationContext(args.ctx, args.stateHandler as never)];
    },
    ...(args.workspacePaths === undefined ? {} : { workspacePaths: args.workspacePaths }),
    errorReason: "An error occurred while classifying this action. Please review manually.",
  });
  if (options.mode === "shadow") {
    void runClassifier().catch((error: unknown) => {
      if (!(error instanceof Error && error.name === "AbortError")) throw error;
    });
    return;
  }
  const decision = await runClassifier();
  if (decision.kind === "allow") { await recheck(); return; }
  if (decision.kind === "block" && options.autoReviewController != null) {
    const action = canonical.exactAction;
    const summary = summarizeSlateBrowserAutoReviewAction({
      op: action.op,
      ...(action.element === undefined ? {} : { element: action.element }),
      ...(canonical.targetPageUrl === undefined ? {} : { targetPageUrl: canonical.targetPageUrl }),
      ...(action.url === undefined ? {} : { url: action.url }),
      ...(action.text === undefined ? {} : { text: action.text }),
      ...(action.value === undefined ? {} : { value: action.value }),
      ...(action.values === undefined ? {} : { values: action.values }),
      ...(action.key === undefined ? {} : { key: action.key }),
      ...(action.cdpMethod === undefined ? {} : { cdpMethod: action.cdpMethod }),
      ...(action.cdpParams === undefined ? {} : { cdpParams: action.cdpParams }),
      ...(action.tabsAction === undefined ? {} : { tabsAction: action.tabsAction }),
      ...(action.tabIndex === undefined ? {} : { tabIndex: action.tabIndex }),
    });
    const approval = await withToolExecutionTimeoutSuspended(args.ctx, () => options.autoReviewController!.requestApproval({ agentId: options.agentId, surface: "computer", fingerprint, reason: decision.reason, summary, ...(decision.proposedRule == null ? {} : { proposedRule: decision.proposedRule }), ...(args.signal == null ? {} : { signal: args.signal }), ...(options.getApprovalExpiryPolicy == null ? {} : { expiryPolicy: options.getApprovalExpiryPolicy() }) })); if (args.signal?.aborted === true) throw new SlateBrowserAutoReviewBlockedError("The browser action was cancelled."); if (approval.approved) { await recheck(); return; } throw new SlateBrowserAutoReviewBlockedError(approval.reason ?? decision.reason); }
  throw new SlateBrowserAutoReviewBlockedError(decision.reason);
}
