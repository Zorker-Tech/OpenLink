/** Inputs needed to estimate and report the prompt size for one model call. */

import type { Context } from "../../context/context.ts";
import type { CoreMessageLike } from "../../redaction/message-redaction.ts";

export interface PromptTokenRequestDetails {
  readonly applicableRules?: readonly unknown[] | undefined;
  readonly availableSkills?: readonly unknown[] | undefined;
  readonly workspaceContext?: unknown;
  readonly toolDiscoverySettings?: unknown;
  readonly fileSystemSettings?: unknown;
}

export interface TrackPromptTokenUsageInput {
  readonly ctx: Context;
  readonly availableTools: readonly unknown[];
  readonly requestDetails: PromptTokenRequestDetails;
  readonly promptMessages: readonly CoreMessageLike[];
  readonly attachedContext: unknown;
  readonly userInfoDisplayOptions: unknown;
  readonly tokenBudget: number | undefined;
  readonly fileReadToolName: string | undefined;
  readonly invocationId: string;
  readonly modelCapabilities: unknown;
  readonly behaviorFlags: unknown;
  readonly conversationState: {
    skillCatalogBudgetChoice?: string | undefined;
  };
}

export type TrackPromptTokenUsage = (input: TrackPromptTokenUsageInput) => void;
