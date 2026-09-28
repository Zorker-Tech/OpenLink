/**
 * Dropping an assistant turn that said nothing.
 *
 * A model that answered with nothing at the end of a prompt leaves a turn with no content; it is removed before the
 * prompt goes out, since a provider rejects it and it carries no meaning anyway.
 */
import { BaseMiddleware, type PromptExecutor, type PromptMessage } from "../base.ts";

export const isEmptyAssistantMessage = (message: PromptMessage): boolean => message.role === "assistant" && message.content.length === 0;
export function removeTrailingEmptyAssistantMessages(messages: readonly PromptMessage[]): { cleanedMessages: PromptMessage[]; removedMessageCount: number } {
  const cleanedMessages = [...messages];
  let removedMessageCount = 0;
  while (cleanedMessages.length > 0 && isEmptyAssistantMessage(cleanedMessages.at(-1)!)) { cleanedMessages.pop(); removedMessageCount += 1; }
  return { cleanedMessages, removedMessageCount };
}

export class TrailingEmptyAssistantRemovalMiddleware extends BaseMiddleware<PromptMessage> {
  override stream(...args: readonly unknown[]): unknown {
    const { cleanedMessages, removedMessageCount } = removeTrailingEmptyAssistantMessages(this.innerExecutor.getMessages());
    if (removedMessageCount > 0) {
      this.innerExecutor.clearMessages();
      if (cleanedMessages.length > 0) this.innerExecutor.appendMessages(cleanedMessages);
    }
    return this.innerExecutor.stream(...args);
  }
}
export const createTrailingEmptyAssistantRemovalMiddleware = () => (executor: PromptExecutor<PromptMessage>): TrailingEmptyAssistantRemovalMiddleware => new TrailingEmptyAssistantRemovalMiddleware(executor);
export const trailingEmptyAssistantRemovalMiddleware = createTrailingEmptyAssistantRemovalMiddleware();
