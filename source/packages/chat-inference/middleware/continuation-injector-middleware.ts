/**
 * Telling a model that a turn was cut off.
 *
 * A turn that ended because it hit its limit is continued rather than restarted: what is injected says so, so the model
 * picks up where it stopped instead of repeating the work.
 */
import { BaseMiddleware, type PromptExecutor, type PromptMessage } from "../base.ts";

const logger = {
  name: "@slate/chat-inference/continuation-injector-middleware",
  info(_ctx: unknown, message: string, metadata: unknown): void { console.info(message, metadata); },
};
export const CONTINUATION_MESSAGE = "Your previous response was interrupted. Continue from where you left off.";
export const isEmptyAssistantMessage = (message: PromptMessage): boolean => message.role === "assistant" && message.content.length === 0;
export function needsContinuationMessage(messages: readonly PromptMessage[]): boolean {
  const lastMessage = messages.at(-1);
  return lastMessage !== undefined && lastMessage.role === "assistant" && !isEmptyAssistantMessage(lastMessage);
}

export class ContinuationInjectorMiddleware extends BaseMiddleware<PromptMessage> {
  override stream(...args: readonly unknown[]): unknown {
    const messages = this.innerExecutor.getMessages();
    if (needsContinuationMessage(messages)) {
      logger.info(args[0], "[continuation-injector] last message is assistant; injecting continuation prompt", { messageCount: messages.length });
      this.innerExecutor.appendMessages({ role: "user", content: CONTINUATION_MESSAGE });
    }
    return this.innerExecutor.stream(...args);
  }
}
export const createContinuationInjectorMiddleware = () => (executor: PromptExecutor<PromptMessage>): ContinuationInjectorMiddleware => new ContinuationInjectorMiddleware(executor);
export const continuationInjectorMiddleware = createContinuationInjectorMiddleware();
