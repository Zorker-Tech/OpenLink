/** Continue a non-empty assistant turn that ended before the response finished. */
import { BaseMiddleware, type PromptExecutor, type PromptMessage } from "../base.ts";
import { isEmptyAssistantMessage } from "./prompt-message-policy.ts";

export { isEmptyAssistantMessage } from "./prompt-message-policy.ts";

const logger = {
  name: "@slate/chat-inference/continuation-injector-middleware",
  info(_ctx: unknown, message: string, metadata: unknown): void { console.info(message, metadata); },
};
export const CONTINUATION_MESSAGE = "The previous answer ended before it was complete. Continue from the point where it stopped, without repeating completed work.";

export function needsContinuationMessage(messages: readonly PromptMessage[]): boolean {
  const latest = messages[messages.length - 1];
  if (latest === undefined || latest.role !== "assistant") return false;
  return !isEmptyAssistantMessage(latest);
}

export class ContinuationInjectorMiddleware extends BaseMiddleware<PromptMessage> {
  override stream(...args: readonly unknown[]): unknown {
    const messages = this.innerExecutor.getMessages();
    if (needsContinuationMessage(messages)) this.appendContinuation(messages.length, args[0]);
    return this.innerExecutor.stream(...args);
  }

  private appendContinuation(messageCount: number, context: unknown): void {
    logger.info(context, "[continuation-injector] final assistant message is incomplete; continuing the turn", { messageCount });
    this.innerExecutor.appendMessages({ role: "user", content: CONTINUATION_MESSAGE });
  }
}

export function createContinuationInjectorMiddleware() {
  return (executor: PromptExecutor<PromptMessage>): ContinuationInjectorMiddleware =>
    new ContinuationInjectorMiddleware(executor);
}

export const continuationInjectorMiddleware = createContinuationInjectorMiddleware();
