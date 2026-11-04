export const SLATE_AGENT_MODE = "slate-agent";

export interface LabelMessage {
  readonly providerOptions?: { readonly cursor?: { readonly inferenceReason?: string } };
  readonly [key: string]: unknown;
}

export interface FollowupClassificationInput {
  readonly requestId: string;
  readonly replyingToRequestId: string;
  readonly messages: readonly LabelMessage[];
  readonly conversationId: string;
  readonly agentMode: string;
  readonly modelName: string;
}

export interface PostTurnLabelingInput {
  readonly requestId: string;
  readonly messages: readonly LabelMessage[];
  readonly conversationId: string;
  readonly agentMode: string;
  readonly modelName: string;
}

export interface LabelingClient {
  recordFollowupClassification(request: FollowupClassificationInput): Promise<unknown>;
  recordPostTurnLabeling(request: PostTurnLabelingInput): Promise<unknown>;
}

export interface PromptExecutor {
  appendMessages(messages: LabelMessage | readonly LabelMessage[]): unknown;
  getState(): unknown;
  getMessages(): readonly LabelMessage[];
  clearMessages(): void;
  stream(...args: readonly unknown[]): unknown;
}
