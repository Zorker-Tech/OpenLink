/** Compatibility exports for the classifier executor, implemented at its backend boundary. */

export {
  createSlateBackendSmartModeClassifierExecutor,
  SlateSmartModeClassifierError,
} from "../../../adapters/interop/agent/auto-review-backend-executor-adapter.ts"
export type {
  SmartModeClassifierClient,
  SlateBackendSmartModeClassifierOptions,
} from "../../../adapters/interop/agent/auto-review-backend-executor-adapter.ts"
