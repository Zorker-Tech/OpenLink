/**
 * Reviewing what a cloud agent did.
 *
 * What the agent was asked for, what it changed and what it reported are gathered into the review's turnContext, bounded in
 * how much travels, so a review can judge work that happened on another machine.
 */
import { createHash } from "node:crypto";
import {
  fingerprintSlateAutoReviewTarget,
  type SlateAutoReviewController,
  type SlateAutoReviewExpiryPolicy,
  type SlateAutoReviewMode,
} from "./slate-auto-review.ts";
import type { AutoReviewClassifierDecision } from "./slate-auto-review-classifier-run.ts";
import {
  summarizeSlateCloudAgentAction,
  summarizeSlateCloudAgentLifecycleAction,
  type CloudLifecycleAction,
} from "./slate-auto-review-summaries.ts";
import { buildProjectPermissionsContext } from "./slate-computer-auto-review.ts";
import type { InstructionPermissions } from "./slate-subagent-auto-review.ts";
import { createSlateAutoReviewRiskTarget, type SlateAutoReviewRiskTarget } from "./auto-review-classifier-contracts.ts";

export const SLATE_CLOUD_AGENT_CLASSIFIER_TARGET_ACTION = "slate_cloud_agent";
export const SLATE_CLOUD_AGENT_CLASSIFIER_ERROR_REASON =
  "An error occurred while reviewing this cloud agent action. Please review manually.";
export const SLATE_CLOUD_AGENT_AUTO_REVIEW_ACTIONS = ["launch", "reply"] as const;
export const SLATE_CLOUD_AGENT_LIFECYCLE_REVIEW_ACTIONS = [
  "rename",
  "cancel",
  "archive",
  "unarchive",
  "delete",
] as const;

const REVIEWABLE_ACTIONS = new Set<string>(SLATE_CLOUD_AGENT_AUTO_REVIEW_ACTIONS);
const LIFECYCLE_REVIEW_ACTIONS = new Set<string>(SLATE_CLOUD_AGENT_LIFECYCLE_REVIEW_ACTIONS);

export type CloudAgentReviewAction = typeof SLATE_CLOUD_AGENT_AUTO_REVIEW_ACTIONS[number];

export interface CloudAgentReviewImage {
  readonly url: string;
  readonly mimeType?: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface CloudAgentReviewTarget {
  readonly action: CloudAgentReviewAction;
  readonly prompt: string;
  readonly repoUrl?: string;
  readonly startingRef?: string;
  readonly model?: string;
  readonly modelParams?: unknown;
  readonly title?: string;
  readonly environment?: unknown;
  readonly agentId?: string;
  readonly interrupt?: boolean;
  readonly images: readonly CloudAgentReviewImage[];
}

export interface CloudAgentLifecycleReviewTarget {
  readonly action: CloudLifecycleAction;
  readonly agentId: string;
  readonly title?: string;
}

export function isSlateCloudAgentAutoReviewAction(
  action: string,
): action is CloudAgentReviewAction {
  return REVIEWABLE_ACTIONS.has(action);
}

export function isSlateCloudAgentLifecycleReviewAction(
  action: string,
): action is CloudLifecycleAction {
  return LIFECYCLE_REVIEW_ACTIONS.has(action);
}

/** The digest an image is described by. */
function imageDigest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function describeSlateCloudAgentReviewImages(
  fallbackUrls: readonly string[],
  images: readonly { readonly path?: string; readonly mimeType?: string; readonly data: Uint8Array }[],
): CloudAgentReviewImage[] {
  return images.map((picture, position) => ({
    url: picture.path ?? fallbackUrls[position] ?? `image-${position}`,
    ...(picture.mimeType == null ? {} : { mimeType: picture.mimeType }),
    byteLength: picture.data.byteLength,
    sha256: imageDigest(picture.data),
  }));
}

export function buildSlateCloudAgentReviewTarget(
  input: {
    readonly action: string;
    readonly prompt?: string;
    readonly repo_url?: string;
    readonly starting_ref?: string;
    readonly model?: string;
    readonly model_params?: unknown;
    readonly title?: string;
    readonly environment?: unknown;
    readonly agent_id?: string;
    readonly interrupt?: boolean;
  },
  pictures: readonly CloudAgentReviewImage[] = [],
): CloudAgentReviewTarget | undefined {
  if (!isSlateCloudAgentAutoReviewAction(input.action)) return undefined;
  const requestedPrompt = input.prompt?.trim() ?? "";
  if (requestedPrompt.length === 0) return undefined;
  return {
    action: input.action,
    prompt: requestedPrompt,
    ...(input.repo_url == null ? {} : { repoUrl: input.repo_url }),
    ...(input.starting_ref == null ? {} : { startingRef: input.starting_ref }),
    ...(input.model == null ? {} : { model: input.model }),
    ...(input.model_params == null ? {} : { modelParams: input.model_params }),
    ...(input.title == null ? {} : { title: input.title }),
    ...(input.environment == null ? {} : { environment: input.environment }),
    ...(input.agent_id == null ? {} : { agentId: input.agent_id }),
    ...(input.interrupt == null ? {} : { interrupt: input.interrupt }),
    images: pictures,
  };
}

/** The arguments a cloud-agent review is classified on, as the classifier reads them. */
function cloudAgentArguments(target: CloudAgentReviewTarget, reviewOptions: { readonly personalInstructions?: InstructionPermissions; readonly userAutoRunInstructions?: InstructionPermissions; readonly projectAutoRunInstructions?: InstructionPermissions }): Record<string, unknown> {
  return JSON.parse(JSON.stringify({
    surface: "cloud_agent",
    action: target.action,
    prompt: target.prompt,
    repo_url: target.repoUrl,
    starting_ref: target.startingRef,
    model: target.model,
    model_params: target.modelParams,
    title: target.title,
    environment: target.environment,
    agent_id: target.agentId,
    interrupt: target.interrupt,
    image_count: target.images.length,
    images: target.images.map((picture) => ({
      url: picture.url,
      mime_type: picture.mimeType,
      byte_length: picture.byteLength,
      sha256: picture.sha256,
    })),
    project_permissions: buildProjectPermissionsContext(reviewOptions),
  })) as Record<string, unknown>;
}

export function buildSlateCloudAgentRiskTarget(input: {
  readonly target: CloudAgentReviewTarget;
  readonly personalInstructions?: InstructionPermissions;
  readonly userAutoRunInstructions?: InstructionPermissions;
  readonly projectAutoRunInstructions?: InstructionPermissions;
}): SlateAutoReviewRiskTarget {
  return createSlateAutoReviewRiskTarget(
    SLATE_CLOUD_AGENT_CLASSIFIER_TARGET_ACTION,
    cloudAgentArguments(input.target, input),
  );
}

export interface CloudAgentReviewOptions<Context> {
  readonly mode: SlateAutoReviewMode;
  readonly agentId: string;
  readonly autoReviewController?: Pick<SlateAutoReviewController, "requestApproval">;
  readonly personalInstructions?: InstructionPermissions;
  readonly userAutoRunInstructions?: InstructionPermissions;
  readonly projectAutoRunInstructions?: InstructionPermissions;
  readonly getApprovalExpiryPolicy?: () => SlateAutoReviewExpiryPolicy;
  classify(
    turnContext: Context,
    target: CloudAgentReviewTarget,
    mode: "shadow" | "enforce",
    toolCallId: string,
  ): Promise<AutoReviewClassifierDecision>;
  reportShadowFailure?(error: unknown): void;
  suspendToolExecutionTimeout?<T>(turnContext: Context, operation: () => Promise<T>): Promise<T>;
}

const CANCELLED_CLOUD_AGENT_REVIEW = {
  allowed: false,
  reason: "The cloud agent action was cancelled.",
} as const;

/** Whether the caller has gone away since the review started. */
function reviewCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** The approval request fields both review paths share. */
function approvalExtras(reviewOptions: { readonly getApprovalExpiryPolicy?: () => SlateAutoReviewExpiryPolicy }, signal: AbortSignal | undefined): Record<string, unknown> {
  return {
    ...(signal == null ? {} : { signal }),
    ...(reviewOptions.getApprovalExpiryPolicy == null ? {} : { expiryPolicy: reviewOptions.getApprovalExpiryPolicy() }),
  };
}

/** Runs an answer ask, keeping the tool-execution timeout suspended while it waits when the host can. */
async function awaitApproval<Context, Answer>(
  turnContext: Context,
  reviewOptions: { readonly suspendToolExecutionTimeout?: <T>(turnContext: Context, operation: () => Promise<T>) => Promise<T> },
  ask: () => Promise<Answer>,
): Promise<Answer> {
  return reviewOptions.suspendToolExecutionTimeout == null
    ? await ask()
    : await reviewOptions.suspendToolExecutionTimeout(turnContext, ask);
}

export async function reviewSlateCloudAgentAction<Context>(input: {
  readonly ctx: Context;
  readonly target: CloudAgentReviewTarget;
  readonly options: CloudAgentReviewOptions<Context>;
  readonly toolCallId: string;
  readonly signal?: AbortSignal;
}): Promise<{ readonly allowed: boolean; readonly reason?: string }> {
  const { ctx, target, options, toolCallId } = input;
  if (options.mode === "off") return { allowed: true };
  if (options.mode === "shadow") {
    void options.classify(ctx, target, "shadow", toolCallId)
      .catch((error: unknown) => options.reportShadowFailure?.(error));
    return { allowed: true };
  }
  if (reviewCancelled(input.signal)) return CANCELLED_CLOUD_AGENT_REVIEW;
  const verdict = await options.classify(ctx, target, "enforce", toolCallId);
  if (reviewCancelled(input.signal)) return CANCELLED_CLOUD_AGENT_REVIEW;
  if (verdict.kind === "allow") return { allowed: true };
  const approvals = options.autoReviewController;
  if (verdict.kind !== "block" || approvals == null) {
    return { allowed: false, reason: verdict.reason };
  }
  const ask = () => approvals.requestApproval({
    agentId: options.agentId,
    surface: "cloud_agent",
    fingerprint: fingerprintSlateAutoReviewTarget({
      action: target.action,
      prompt: target.prompt,
      repoUrl: target.repoUrl,
      startingRef: target.startingRef,
      model: target.model,
      modelParams: target.modelParams,
      title: target.title,
      environment: target.environment,
      agentId: target.agentId,
      interrupt: target.interrupt,
      images: target.images,
    }),
    reason: verdict.reason,
    summary: summarizeSlateCloudAgentAction({
      ...target,
      imageCount: target.images.length,
    }),
    ...(verdict.proposedRule == null ? {} : { proposedRule: verdict.proposedRule }),
    ...approvalExtras(options, input.signal),
  });
  const answer = await awaitApproval(ctx, options, ask);
  if (reviewCancelled(input.signal)) return CANCELLED_CLOUD_AGENT_REVIEW;
  return answer.approved
    ? { allowed: true }
    : { allowed: false, reason: answer.reason ?? verdict.reason };
}

export function buildSlateCloudAgentLifecycleReviewTarget(input: {
  readonly action: string;
  readonly agent_id?: string;
  readonly title?: string;
}): CloudAgentLifecycleReviewTarget | undefined {
  if (!isSlateCloudAgentLifecycleReviewAction(input.action)) return undefined;
  const agentId = input.agent_id?.trim() ?? "";
  if (agentId.length === 0) return undefined;
  const title = input.title?.trim();
  return {
    action: input.action,
    agentId,
    ...(title == null || title.length === 0 ? {} : { title }),
  };
}

export const LIFECYCLE_REVIEW_UNAVAILABLE_REASON =
  "This action needs Auto-review approval, which isn't available in this conversation. Run it from a direct chat with the assistant.";

/** What the user is told about a lifecycle action, and why it needs their answer. */
const LIFECYCLE_REVIEW_REASONS: Readonly<Record<CloudLifecycleAction, string>> = {
  delete: "Deleting a cloud agent is permanent and cannot be undone, so it needs your approval.",
  cancel: "Cancelling a cloud agent's active run stops its work, so it needs your approval.",
  archive: "Archiving a cloud agent needs your approval.",
  unarchive: "Unarchiving a cloud agent needs your approval.",
  rename: "Renaming a cloud agent changes how it appears everywhere, so it needs your approval.",
};

export function slateCloudAgentLifecycleReason(action: CloudLifecycleAction): string {
  return LIFECYCLE_REVIEW_REASONS[action];
}

export async function reviewSlateCloudAgentLifecycleAction<Context>(input: {
  readonly ctx: Context;
  readonly target: CloudAgentLifecycleReviewTarget;
  readonly options: Pick<CloudAgentReviewOptions<Context>,
    "mode" | "agentId" | "autoReviewController" | "getApprovalExpiryPolicy" | "suspendToolExecutionTimeout">;
  readonly signal?: AbortSignal;
}): Promise<{ readonly allowed: boolean; readonly reason?: string }> {
  const { ctx, target, options } = input;
  if (options.mode !== "enforce") return { allowed: true };
  if (reviewCancelled(input.signal)) return CANCELLED_CLOUD_AGENT_REVIEW;
  const approvals = options.autoReviewController;
  if (approvals == null) return { allowed: false, reason: LIFECYCLE_REVIEW_UNAVAILABLE_REASON };
  const reason = slateCloudAgentLifecycleReason(target.action);
  const ask = () => approvals.requestApproval({
    agentId: options.agentId,
    surface: "cloud_agent",
    fingerprint: fingerprintSlateAutoReviewTarget({
      kind: "cloud_agent_lifecycle",
      action: target.action,
      agentId: target.agentId,
      title: target.title,
    }),
    reason,
    summary: summarizeSlateCloudAgentLifecycleAction({
      action: target.action,
      agentId: target.agentId,
      ...(target.title == null ? {} : { title: target.title }),
    }),
    ...approvalExtras(options, input.signal),
  });
  const answer = await awaitApproval(ctx, options, ask);
  if (reviewCancelled(input.signal)) return CANCELLED_CLOUD_AGENT_REVIEW;
  return answer.approved
    ? { allowed: true }
    : { allowed: false, reason: answer.reason ?? reason };
}
