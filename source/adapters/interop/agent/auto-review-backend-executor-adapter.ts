/** Binds Slate's smart-mode classifier executor to the backend protocol. */

import type { MethodInfoUnary } from "@bufbuild/protobuf"
import type { Context } from "../../../packages/context/context.ts"
import { SmartModeClassifierArgs, type SmartModeClassifierResult } from "../proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts"
import { DashboardService } from "../proto/generated/aiserver/v1/dashboard_connect.ts"
import { ClassifySlateAutoReviewRequest, type ClassifySlateAutoReviewResponse } from "../proto/generated/aiserver/v1/dashboard_pb.ts"
import { createSlateBackendClient, type SlateInferenceOptions } from "../slate-backend/slate-backend-client.ts"
import { smartModeClassifierAttemptIndexKey, smartModeClassifierModeKey } from "../../../packages/agent/utils/smart-mode-classifier-measurement.ts"

export class SlateSmartModeClassifierError extends Error {}

export interface SmartModeClassifierClient {
  classifySlateAutoReview(
    request: ClassifySlateAutoReviewRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ClassifySlateAutoReviewResponse>
}

export interface SlateBackendSmartModeClassifierOptions extends Omit<SlateInferenceOptions, "backendUrl"> {
  readonly client?: SmartModeClassifierClient
}

export function createSlateBackendSmartModeClassifierExecutor(options: SlateBackendSmartModeClassifierOptions) {
  const client = options.client ?? (() => {
    const service = DashboardService as typeof DashboardService & {
      readonly methods: typeof DashboardService.methods & {
        readonly classifySlateAutoReview: MethodInfoUnary<ClassifySlateAutoReviewRequest, ClassifySlateAutoReviewResponse>
      }
    }
    return createSlateBackendClient(service, options)
  })()

  return {
    async execute(ctx: Context, args: SmartModeClassifierArgs): Promise<SmartModeClassifierResult> {
      const response = await client.classifySlateAutoReview(
        new ClassifySlateAutoReviewRequest({
          args: new SmartModeClassifierArgs({
            target: args.target!,
            conversationContext: args.conversationContext,
            parentConversationId: args.parentConversationId!,
          }),
          attemptIndex: ctx.get(smartModeClassifierAttemptIndexKey)!,
          mode: ctx.get(smartModeClassifierModeKey) ?? "enforce",
        }),
        { signal: ctx.signal },
      )
      if (response.result === undefined) throw new SlateSmartModeClassifierError("ClassifySlateAutoReview returned no result")
      return response.result
    },
  }
}
