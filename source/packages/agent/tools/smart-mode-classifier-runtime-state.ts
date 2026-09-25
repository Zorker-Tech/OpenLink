/**
 * Whether the smart-mode classifier is judging anything this turn, and in what capacity.
 *
 * Three answers are possible and they are different things: the classifier is deciding (enabled), it is
 * deciding without its answer being acted on (shadow), or it is not running at all. A background run
 * never uses it — nobody is watching an approval prompt — and a session only opts in when both the mode
 * and the environment say so.
 *
 * The development switches travel with the answer so a caller has one object to pass around rather than
 * three, and they are created here when the caller did not bring its own.
 */

import type { RequestContext } from "../../proto/generated/agent/v1/request_context_exec_pb.ts"
import { AgentType } from "../utils/agent-config.ts"
import {
  createDevSmartModeClassifierBlockState,
  createDevSmartModeClassifierDelayState,
  type OneShotState,
} from "./dev-smart-mode-classifier-block.ts"

export interface SmartModeClassifierRuntimeState {
  readonly autoModeSelected: boolean
  readonly enabled: boolean
  readonly shadowEnabled: boolean
  readonly devBlockState: OneShotState | undefined
  readonly devDelayState: OneShotState | undefined
}

export function getSmartModeClassifierRuntimeState({
  agentType,
  requestContext,
  smartModeClassifierMode,
  smartModeClassifierShadowMode,
  devBlockState,
  devDelayState,
}: {
  readonly agentType: AgentType
  readonly requestContext?: Pick<RequestContext, "env"> | undefined
  readonly smartModeClassifierMode: boolean
  readonly smartModeClassifierShadowMode: boolean
  readonly devBlockState?: OneShotState | undefined
  readonly devDelayState?: OneShotState | undefined
}): SmartModeClassifierRuntimeState {
  const isBackgroundAgent = agentType === AgentType.BACKGROUND
  const autoModeSelected = smartModeClassifierMode === true &&
    requestContext?.env?.smartModeClassifierAutoModeEnabled === true
  const enabled = !isBackgroundAgent && autoModeSelected
  return {
    autoModeSelected,
    enabled,
    shadowEnabled: !isBackgroundAgent && !enabled && smartModeClassifierShadowMode === true,
    devBlockState: devBlockState ?? createDevSmartModeClassifierBlockState(requestContext),
    devDelayState: devDelayState ?? createDevSmartModeClassifierDelayState(requestContext),
  }
}
