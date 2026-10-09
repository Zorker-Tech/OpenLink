/**
 * Asking the backend to classify a conversation for the platform's smart mode.
 *
 * What is sent is the conversation and the attempt it belongs to; what comes back is the classification, and a
 * classification that is missing is a failure rather than an empty answer. The mode the attempt runs under comes from
 * the context, and a request that could not be classified is refused with the name a caller can act on.
 */

import type { MethodInfoUnary } from "@bufbuild/protobuf";
import type { Context } from "../../../packages/context/context.ts";
import { SmartModeClassifierArgs, type SmartModeClassifierResult } from "../../../packages/proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts";
import { DashboardService } from "../../../packages/proto/generated/aiserver/v1/dashboard_connect.ts";
import { ClassifySlateAutoReviewRequest, type ClassifySlateAutoReviewResponse } from "../../../packages/proto/generated/aiserver/v1/dashboard_pb.ts";
import { createSlateCursorBackendClient, type SlateInferenceOptions } from "../../../shared/node/cursor-backend/cursor-inference.ts";
import { smartModeClassifierAttemptIndexKey, smartModeClassifierModeKey } from "../../../packages/agent/utils/smart-mode-classifier-measurement.ts";

export class SlateSmartModeClassifierError extends Error {}

/** The one backend call this executor makes; a caller may hand one in instead of building it. */
export interface SmartModeClassifierClient {
  classifySlateAutoReview(request: ClassifySlateAutoReviewRequest, options?: { signal?: AbortSignal }): Promise<ClassifySlateAutoReviewResponse>;
}

export interface SlateBackendSmartModeClassifierOptions extends Omit<SlateInferenceOptions, "backendUrl"> {
  readonly client?: SmartModeClassifierClient;
}

export function createSlateBackendSmartModeClassifierExecutor(options: SlateBackendSmartModeClassifierOptions) {
  const client = options.client ?? (() => {
    // The generated service type does not carry this method, though the backend serves it.
    const service = DashboardService as typeof DashboardService & {
      readonly methods: typeof DashboardService.methods & { readonly classifySlateAutoReview: MethodInfoUnary<ClassifySlateAutoReviewRequest, ClassifySlateAutoReviewResponse> };
    };
    return createSlateCursorBackendClient(service, options);
  })();
  return {
    async execute(ctx: Context, args: SmartModeClassifierArgs): Promise<SmartModeClassifierResult> {
      const attemptIndex = ctx.get(smartModeClassifierAttemptIndexKey);
      const mode = ctx.get(smartModeClassifierModeKey) ?? "enforce";
      const response = await client.classifySlateAutoReview(
        new ClassifySlateAutoReviewRequest({
          // The turn this classification belongs to goes with it, so the backend's own dumps group with the
          // transcript; the tool call id stays here, where it is only ever used for measurement.
          args: new SmartModeClassifierArgs({ target: args.target!, conversationContext: args.conversationContext, parentConversationId: args.parentConversationId! }),
          attemptIndex: attemptIndex!,
          mode,
        }),
        { signal: ctx.signal },
      );
      if (response.result === undefined) throw new SlateSmartModeClassifierError("ClassifySlateAutoReview returned no result");
      return response.result;
    },
  };
}
