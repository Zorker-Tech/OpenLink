/**
 * The switches that make the smart-mode classifier fail on purpose, in development.
 *
 * The classifier's failure paths — a block, a timeout — are the ones that matter and the ones that are
 * hard to reach, so a development session can ask for them: a token makes the next classification fail
 * once, and the state that decides "once" is consumed by the attempt that uses it.
 *
 * The request envelope is translated at the interop boundary; this module only handles the one-shot behavior.
 */

import { DEV_SMART_MODE_CLASSIFIER_DELAY_MS } from "../../constants/smart-mode-classifier.ts"
import { delay } from "../../utils/promise-tools.ts"

export const DEV_SMART_MODE_CLASSIFIER_BLOCK_REASON = "This is a dev block whatever just retry it"

export interface OneShotState {
  consume(): boolean
}

export interface SmartModeClassifierControls {
  readonly automaticModeEnabled: boolean
  readonly blockNextToken?: string | undefined
  readonly delayNextToken?: string | undefined
}

function createOneShotState(token: string | undefined): OneShotState | undefined {
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

export function createDevSmartModeClassifierBlockState(
  token: string | undefined,
  isDevelopment = typeof process !== "undefined" && process.env.NODE_ENV === "development",
): OneShotState | undefined {
  if (!isDevelopment) return undefined
  return createOneShotState(token)
}

export function createDevSmartModeClassifierDelayState(
  token: string | undefined,
  isDevelopment = typeof process !== "undefined" && process.env.NODE_ENV === "development",
): OneShotState | undefined {
  if (!isDevelopment) return undefined
  return createOneShotState(token)
}

export async function delayDevSmartModeClassifierIfRequested(state: OneShotState | undefined): Promise<void> {
  const consumed = state?.consume() === true
  if (consumed) await delay(DEV_SMART_MODE_CLASSIFIER_DELAY_MS)
}
