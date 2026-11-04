import type { RequestContext } from "../proto/generated/agent/v1/request_context_exec_pb.ts"
import type { SmartModeClassifierControls } from "../../../packages/agent/tools/dev-smart-mode-classifier-block.ts"

/** Project the counterpart request-context environment into the classifier controls Slate understands. */
export function smartModeClassifierControlsFromRequestContext(
  requestContext: Pick<RequestContext, "env"> | undefined,
  options: { readonly development?: boolean } = {},
): SmartModeClassifierControls {
  const environment = requestContext?.env
  const development = options.development ?? (
    typeof process !== "undefined" && process.env.NODE_ENV === "development"
  )

  return {
    automaticModeEnabled: environment?.smartModeClassifierAutoModeEnabled === true,
    ...(development && environment?.devForceNextSmartModeClassifierBlockToken !== undefined
      ? { blockNextToken: environment.devForceNextSmartModeClassifierBlockToken }
      : {}),
    ...(development && environment?.devDelayNextSmartModeClassifierToken !== undefined
      ? { delayNextToken: environment.devDelayNextSmartModeClassifierToken }
      : {}),
  }
}
