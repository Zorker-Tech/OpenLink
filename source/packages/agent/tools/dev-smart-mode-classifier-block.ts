/**
 * The switches that make the smart-mode classifier fail on purpose, in development.
 *
 * The classifier's failure paths — a block, a timeout — are the ones that matter and the ones that are
 * hard to reach, so a development session can ask for them: a token in the environment makes the next
 * classification fail once, and the state that decides "once" is consumed by the attempt that uses it.
 *
 * Nothing here is reachable outside development: the environment is only read when the process says it is
 * a development one, so a production session with the variable set still behaves normally.
 */

import type { RequestContext } from "../../proto/generated/agent/v1/request_context_exec_pb.ts"
import { DEV_SMART_MODE_CLASSIFIER_DELAY_MS } from "../../constants/smart-mode-classifier.ts"
import { delay } from "../../utils/promise-tools.ts"

export const DEV_SMART_MODE_CLASSIFIER_BLOCK_REASON = "This is a dev block whatever just retry it"

export interface OneShotState {
  consume(): boolean
}

function createDevSmartModeClassifierOneShotState(token: string | undefined): OneShotState | undefined {
  const trimmedToken = token?.trim()
  if (trimmedToken === undefined || trimmedToken.length === 0) return undefined
  let consumed = false
  return {
    consume(): boolean {
      if (consumed) return false
      consumed = true
      return true
    },
  }
}

function getDevSmartModeClassifierEnv(
  requestContext: Pick<RequestContext, "env"> | undefined,
): RequestContext["env"] {
  if (typeof process === "undefined" || process.env.NODE_ENV !== "development") return undefined
  return requestContext?.env
}

export function createDevSmartModeClassifierBlockState(
  requestContext: Pick<RequestContext, "env"> | undefined,
): OneShotState | undefined {
  return createDevSmartModeClassifierOneShotState(
    getDevSmartModeClassifierEnv(requestContext)?.devForceNextSmartModeClassifierBlockToken,
  )
}

export function createDevSmartModeClassifierDelayState(
  requestContext: Pick<RequestContext, "env"> | undefined,
): OneShotState | undefined {
  return createDevSmartModeClassifierOneShotState(
    getDevSmartModeClassifierEnv(requestContext)?.devDelayNextSmartModeClassifierToken,
  )
}

export async function delayDevSmartModeClassifierIfRequested(state: OneShotState | undefined): Promise<void> {
  const consumed = state?.consume() === true
  if (consumed) await delay(DEV_SMART_MODE_CLASSIFIER_DELAY_MS)
}
