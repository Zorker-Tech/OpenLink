import type { LabelingClient, LabelMessage } from "./slate-labeling-contracts.ts";
import { SLATE_AGENT_MODE } from "./slate-labeling-contracts.ts";
import { reportSlateLabelingFailure } from "./slate-labeling-diagnostics.ts";

export function recordSlatePostTurnLabeling(
  client: LabelingClient,
  args: { readonly conversationId: string; readonly requestId: string; readonly modelName: string; readonly messages: readonly LabelMessage[] },
): void {
  if (args.messages.length === 0 || args.requestId.trim().length === 0 || args.conversationId.trim().length === 0) return;
  try {
    const request = {
      requestId: args.requestId,
      messages: args.messages,
      conversationId: args.conversationId,
      agentMode: SLATE_AGENT_MODE,
      modelName: args.modelName,
    };
    void client.recordPostTurnLabeling(request).catch((error) => reportSlateLabelingFailure("post_turn_labeling", error));
  } catch (error) {
    reportSlateLabelingFailure("post_turn_labeling_prepare", error);
  }
}
