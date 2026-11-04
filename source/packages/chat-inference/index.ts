/** The chat-inference package's door: the shared runtime owners are initialized before anything else is imported from it. */
// The retained provider-specific modules only re-initialize these two shared
// runtime owners after tree shaking. Import them first to preserve that exact
// package-root initialization boundary without inventing erased provider APIs.
export * from "./base.ts";
export * from "./prompt-executor.ts";

export {
  CONTINUATION_MESSAGE,
  ContinuationInjectorMiddleware,
  continuationInjectorMiddleware,
  createContinuationInjectorMiddleware,
  needsContinuationMessage,
} from "./middleware/continuation-injector-middleware.ts";
export * from "./middleware/image-resizing-middleware.ts";
export * from "./middleware/noop-middleware.ts";
export * from "./middleware/tracing-middleware.ts";
export {
  TrailingEmptyAssistantRemovalMiddleware,
  createTrailingEmptyAssistantRemovalMiddleware,
  removeTrailingEmptyAssistantMessages,
  trailingEmptyAssistantRemovalMiddleware,
} from "./middleware/trailing-empty-assistant-removal-middleware.ts";
export * from "./mock-prompt-executor.ts";
