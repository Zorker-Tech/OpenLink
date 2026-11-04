/**
 * Reviewing what an agent did in the browser.
 *
 * The pages it visited and what it read are summarized into what a reader needs to judge the visit, and a page that was
 * not what it claimed to be is called out rather than passed over.
 */
import type { Context } from "../../packages/context/context.ts";
import type { RemoteExecManager } from "../../packages/agent-exec/executor-resources.ts";
import type { ResourceAccessor } from "../../packages/agent-exec/resource-provider.ts";
import { tryExtractSlateAutoReviewClassifierConversationContext } from "../../packages/agent/smart-mode-classifier-context.ts";
import { withToolExecutionTimeoutSuspended } from "../../packages/agent/tools/tool-timeout-suspension.ts";
import type { SlateClassifierConversationMessage } from "../../packages/agent/smart-mode-classifier-context.ts";
import { fingerprintSlateAutoReviewTarget, type SlateAutoReviewController, type SlateAutoReviewMode } from "./slate-auto-review.ts";
import type { AutoReviewClassifierDecision } from "./slate-auto-review-classifier-run.ts";
import { runSlateAutoReviewClassifier } from "./slate-auto-review-classifier-run.ts";
import { summarizeSlateBrowserAutoReviewAction } from "./slate-auto-review-summaries.ts";
import { createSlateAutoReviewRiskTarget, type SlateAutoReviewRiskTarget } from "./auto-review-classifier-contracts.ts";
import {
  buildProjectPermissionsContext,
  SLATE_COMPUTER_CLASSIFIER_TARGET_ACTION,
  type BoxIdentity,
} from "./slate-computer-auto-review.ts";

export const SLATE_BROWSER_AUTO_REVIEW_MAX_ELEMENT_CHARS = 500;
export const SLATE_BROWSER_AUTO_REVIEW_MAX_TEXT_CHARS = 2_000;
export const SLATE_BROWSER_AUTO_REVIEW_MAX_URL_CHARS = 2_000;
export const SLATE_BROWSER_AUTO_REVIEW_MAX_KEY_CHARS = 256;
export const SLATE_BROWSER_AUTO_REVIEW_MAX_CDP_PARAMS_CHARS = 2_000;

const BROWSER_OBSERVATIONS_WITHOUT_WRITE = new Set(["snapshot", "screenshot", "get_bounding_box", "highlight", "scroll"]);

export class SlateBrowserAutoReviewBlockedError extends Error {
  override readonly name = "SlateBrowserAutoReviewBlockedError";
}

export interface BrowserAction {
  readonly op: string;
  readonly tabsAction?: string | undefined;
  readonly element?: string | undefined;
  readonly url?: string | undefined;
  readonly text?: string | undefined;
  readonly value?: string | undefined;
  readonly values?: readonly string[] | undefined;
  readonly key?: string | undefined;
  readonly cdpMethod?: string | undefined;
  readonly cdpParams?: string | undefined;
  readonly tabIndex?: number | undefined;
  readonly [key: string]: unknown;
}

type RiskInstructions = { readonly allowInstructions?: readonly string[]; readonly blockInstructions?: readonly string[] };

function assertBrowserFieldBound(value: string | undefined, field: string, max: number): void {
  if ((value?.length ?? 0) > max) {
    throw new SlateBrowserAutoReviewBlockedError(`Browser Auto-review rejected oversized ${field} (max ${max} characters).`);
  }
}

function changesBrowserSession(action: BrowserAction): boolean {
  return action.tabsAction === "new" || action.tabsAction === "close";
}

export function isSlateBrowserAutoReviewMutatingAction(action: BrowserAction): boolean {
  if (action.op === "tabs") return changesBrowserSession(action);
  return !BROWSER_OBSERVATIONS_WITHOUT_WRITE.has(action.op);
}

interface BoundedBrowserInput {
  readonly field: string;
  readonly value: string | undefined;
  readonly limit: number;
}

function checkBrowserActionText(action: BrowserAction): void {
  const boundedFields: readonly BoundedBrowserInput[] = [
    { field: "url", value: action.url, limit: SLATE_BROWSER_AUTO_REVIEW_MAX_URL_CHARS },
    { field: "text", value: action.text, limit: SLATE_BROWSER_AUTO_REVIEW_MAX_TEXT_CHARS },
    { field: "value", value: action.value, limit: SLATE_BROWSER_AUTO_REVIEW_MAX_TEXT_CHARS },
    { field: "key", value: action.key, limit: SLATE_BROWSER_AUTO_REVIEW_MAX_KEY_CHARS },
    { field: "params", value: action.cdpParams, limit: SLATE_BROWSER_AUTO_REVIEW_MAX_CDP_PARAMS_CHARS },
  ];
  for (const { field, value, limit } of boundedFields) assertBrowserFieldBound(value, field, limit);

  const combinedValuesLength = action.values?.join(", ").length ?? 0;
  if (combinedValuesLength > SLATE_BROWSER_AUTO_REVIEW_MAX_TEXT_CHARS) {
    assertBrowserFieldBound("x".repeat(SLATE_BROWSER_AUTO_REVIEW_MAX_TEXT_CHARS + 1), "values", SLATE_BROWSER_AUTO_REVIEW_MAX_TEXT_CHARS);
  }
}

export function normalizeSlateBrowserExactActionArgs<T extends BrowserAction>(action: T): T {
  checkBrowserActionText(action);
  return action;
}

export function normalizeSlateBrowserElement(element?: string): string | undefined {
  const trimmed = element?.trim();
  if (!trimmed) return undefined;
  assertBrowserFieldBound(trimmed, "element", SLATE_BROWSER_AUTO_REVIEW_MAX_ELEMENT_CHARS);
  return trimmed;
}

interface SlateBrowserCanonicalTarget {
  readonly exactAction: BrowserAction;
  readonly boxIdentity: BoxIdentity;
  readonly displayStateIdentity: string;
  readonly targetPageUrl?: string;
}

export function buildSlateBrowserAutoReviewCanonicalTarget(args: {
  readonly exactAction: BrowserAction;
  readonly boxIdentity: BoxIdentity;
  readonly reviewState: { readonly displayStateIdentity: string; readonly targetPageUrl?: string };
}): SlateBrowserCanonicalTarget {
  const exactAction = normalizeSlateBrowserExactActionArgs(args.exactAction);
  const element = normalizeSlateBrowserElement(exactAction.element);
  return {
    exactAction: { ...exactAction, ...(element == null ? {} : { element }) },
    boxIdentity: args.boxIdentity,
    displayStateIdentity: args.reviewState.displayStateIdentity,
    ...(args.reviewState.targetPageUrl == null ? {} : { targetPageUrl: args.reviewState.targetPageUrl }),
  };
}

type CanonicalBrowserTarget = SlateBrowserCanonicalTarget;

export function fingerprintSlateBrowserAutoReviewTarget(target: CanonicalBrowserTarget): string {
  return fingerprintSlateAutoReviewTarget({
    exact_action: target.exactAction,
    window_generation: target.boxIdentity.windowGeneration,
    box_id: target.boxIdentity.boxId,
    display_state_identity: target.displayStateIdentity,
    target_page_url: target.targetPageUrl,
  });
}

function toClassifierArguments(args: {
  readonly canonicalTarget: CanonicalBrowserTarget;
  readonly personalInstructions?: RiskInstructions;
  readonly userAutoRunInstructions?: RiskInstructions;
  readonly projectAutoRunInstructions?: RiskInstructions;
}): SlateAutoReviewRiskTarget {
  const action = args.canonicalTarget.exactAction;
  const plainArguments = JSON.parse(JSON.stringify({
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
  })) as Record<string, unknown>;

  return createSlateAutoReviewRiskTarget(SLATE_COMPUTER_CLASSIFIER_TARGET_ACTION, plainArguments);
}

export function buildSlateBrowserClassifierRiskTarget(args: {
  readonly canonicalTarget: CanonicalBrowserTarget;
  readonly personalInstructions?: RiskInstructions;
  readonly userAutoRunInstructions?: RiskInstructions;
  readonly projectAutoRunInstructions?: RiskInstructions;
}): SlateAutoReviewRiskTarget {
  return toClassifierArguments(args);
}

export interface SlateBrowserAutoReviewOptions {
  readonly mode: SlateAutoReviewMode;
  readonly agentId: string;
  readonly boxIdentity: BoxIdentity;
  readonly autoReviewController?: SlateAutoReviewController;
  readonly resolveDisplayNumber: (ctx: Context) => Promise<number | undefined>;
  readonly personalInstructions?: RiskInstructions;
  readonly userAutoRunInstructions?: RiskInstructions;
  readonly projectAutoRunInstructions?: RiskInstructions;
  readonly extractConversationContext?: (ctx: Context, stateHandler: unknown) => Promise<readonly SlateClassifierConversationMessage[]>;
  readonly getApprovalExpiryPolicy?: () => "park" | "ttl";
}

interface BrowserReviewPreflightArgs {
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
}

function purposeIsRequired(action: BrowserAction): boolean {
  return action.op === "click" || action.op === "mouse_click_xy" || action.op === "drag";
}

async function readClassifierConversation(args: BrowserReviewPreflightArgs): Promise<SlateClassifierConversationMessage[]> {
  if (args.stateHandler === undefined) return [];
  if (args.options.extractConversationContext !== undefined) {
    return [...await args.options.extractConversationContext(args.ctx, args.stateHandler)];
  }
  return [...await tryExtractSlateAutoReviewClassifierConversationContext(args.ctx, args.stateHandler as never)];
}

function classifierTarget(args: BrowserReviewPreflightArgs, canonical: CanonicalBrowserTarget): SlateAutoReviewRiskTarget {
  const options = args.options;
  return buildSlateBrowserClassifierRiskTarget({
    canonicalTarget: canonical,
    ...(options.personalInstructions === undefined ? {} : { personalInstructions: options.personalInstructions }),
    ...(options.userAutoRunInstructions === undefined ? {} : { userAutoRunInstructions: options.userAutoRunInstructions }),
    ...(options.projectAutoRunInstructions === undefined ? {} : { projectAutoRunInstructions: options.projectAutoRunInstructions }),
  });
}

function classifierFor(args: BrowserReviewPreflightArgs, canonical: CanonicalBrowserTarget, mode: "shadow" | "enforce") {
  return () => runSlateAutoReviewClassifier({
    ctx: args.ctx,
    resourceAccessor: args.resourceAccessor,
    toolCallId: args.toolCallId,
    mode,
    buildTarget: () => classifierTarget(args, canonical),
    loadConversationContext: () => readClassifierConversation(args),
    ...(args.workspacePaths === undefined ? {} : { workspacePaths: args.workspacePaths }),
    errorReason: "An error occurred while classifying this action. Please review manually.",
  });
}

function recheckDisplay(args: BrowserReviewPreflightArgs, canonical: CanonicalBrowserTarget): () => Promise<void> {
  return async () => {
    const current = await args.options.captureReviewState(args.ctx, args.toolCallId);
    if (current.displayStateIdentity === canonical.displayStateIdentity) return;
    args.options.autoReviewController?.reportDisplayRecheckFailed(args.options.agentId);
    throw new SlateBrowserAutoReviewBlockedError("The page changed after review; take a fresh browser_snapshot and retry the action.");
  };
}

function approvalSummary(target: CanonicalBrowserTarget): string {
  const action = target.exactAction;
  return summarizeSlateBrowserAutoReviewAction({
    op: action.op,
    ...(action.element === undefined ? {} : { element: action.element }),
    ...(target.targetPageUrl === undefined ? {} : { targetPageUrl: target.targetPageUrl }),
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
}

async function requestBrowserApproval(
  args: BrowserReviewPreflightArgs,
  canonical: CanonicalBrowserTarget,
  fingerprint: string,
  decision: Extract<AutoReviewClassifierDecision, { kind: "block" }>,
  recheck: () => Promise<void>,
): Promise<void> {
  const controller = args.options.autoReviewController;
  if (controller == null) throw new SlateBrowserAutoReviewBlockedError(decision.reason);

  const approval = await withToolExecutionTimeoutSuspended(args.ctx, () => controller.requestApproval({
    agentId: args.options.agentId,
    surface: "computer",
    fingerprint,
    reason: decision.reason,
    summary: approvalSummary(canonical),
    ...(decision.proposedRule == null ? {} : { proposedRule: decision.proposedRule }),
    ...(args.signal == null ? {} : { signal: args.signal }),
    ...(args.options.getApprovalExpiryPolicy == null ? {} : { expiryPolicy: args.options.getApprovalExpiryPolicy() }),
  }));

  if (args.signal?.aborted === true) throw new SlateBrowserAutoReviewBlockedError("The browser action was cancelled.");
  if (approval.approved) {
    await recheck();
    return;
  }
  throw new SlateBrowserAutoReviewBlockedError(approval.reason ?? decision.reason);
}

export async function runSlateBrowserAutoReviewPreflight(args: BrowserReviewPreflightArgs): Promise<void> {
  const options = args.options;
  if (options.mode === "off" || !isSlateBrowserAutoReviewMutatingAction(args.exactAction)) return;
  if (options.mode === "enforce" && purposeIsRequired(args.exactAction) && normalizeSlateBrowserElement(args.exactAction.element) == null) {
    throw new SlateBrowserAutoReviewBlockedError("Browser click and drag actions require an element field: a concise description of the intended target and purpose.");
  }

  const classifierMode = options.mode === "shadow" ? "shadow" : "enforce";
  const initialState = await options.captureReviewState(args.ctx, args.toolCallId);
  const canonical = buildSlateBrowserAutoReviewCanonicalTarget({
    exactAction: args.exactAction,
    boxIdentity: options.boxIdentity,
    reviewState: initialState,
  });
  const fingerprint = fingerprintSlateBrowserAutoReviewTarget(canonical);
  const recheck = recheckDisplay(args, canonical);
  const runClassifier = classifierFor(args, canonical, classifierMode);

  if (options.mode === "shadow") {
    void runClassifier().catch((error: unknown) => {
      if (!(error instanceof Error && error.name === "AbortError")) throw error;
    });
    return;
  }

  const decision = await runClassifier();
  if (decision.kind === "allow") {
    await recheck();
    return;
  }
  if (decision.kind === "block") {
    await requestBrowserApproval(args, canonical, fingerprint, decision, recheck);
    return;
  }
  throw new SlateBrowserAutoReviewBlockedError(decision.reason);
}
