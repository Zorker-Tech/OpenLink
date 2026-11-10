/** A middleware stage that forwards every operation unchanged. */
import { BaseMiddleware, type PromptExecutor, type PromptMessage } from "../base.ts";

export class PassThroughMiddleware<TMessage = PromptMessage> extends BaseMiddleware<TMessage> {}

export function createPassThroughMiddleware<TMessage = PromptMessage>() {
  return (executor: PromptExecutor<TMessage>): PassThroughMiddleware<TMessage> =>
    new PassThroughMiddleware(executor);
}

export function passThroughMiddleware<TMessage = PromptMessage>(
  executor: PromptExecutor<TMessage>,
): PassThroughMiddleware<TMessage> {
  return new PassThroughMiddleware(executor);
}
