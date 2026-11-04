/**
 * Dropping an assistant turn that said nothing.
 *
 * A model that answered with nothing at the end of a prompt leaves a turn with no content; it is removed before the
 * prompt goes out, since a provider rejects it and it carries no meaning anyway.
 */
import { BaseMiddleware, type PromptExecutor, type PromptMessage } from "../base.ts";
import { isEmptyAssistantMessage } from "./prompt-message-policy.ts";

export { isEmptyAssistantMessage } from "./prompt-message-policy.ts";

export function removeTrailingEmptyAssistantMessages(messages: readonly PromptMessage[]): { cleanedMessages: PromptMessage[]; removedMessageCount: number } {
  let lastMessageToKeep = messages.length;
  while (lastMessageToKeep > 0 && isEmptyAssistantMessage(messages[lastMessageToKeep - 1]!)) lastMessageToKeep -= 1;
  return {
    cleanedMessages: messages.slice(0, lastMessageToKeep),
    removedMessageCount: messages.length - lastMessageToKeep,
  };
}

export class TrailingEmptyAssistantRemovalMiddleware extends BaseMiddleware<PromptMessage> {
  override stream(...args: readonly unknown[]): unknown {
    const { cleanedMessages, removedMessageCount } = removeTrailingEmptyAssistantMessages(this.innerExecutor.getMessages());
    if (removedMessageCount > 0) this.rewriteBuffer(cleanedMessages);
    return this.innerExecutor.stream(...args);
  }

  private rewriteBuffer(messages: readonly PromptMessage[]): void {
    this.innerExecutor.clearMessages();
    if (messages.length > 0) this.innerExecutor.appendMessages(messages);
  }
}

export function createTrailingEmptyAssistantRemovalMiddleware() {
  return (executor: PromptExecutor<PromptMessage>): TrailingEmptyAssistantRemovalMiddleware =>
    new TrailingEmptyAssistantRemovalMiddleware(executor);
}

export const trailingEmptyAssistantRemovalMiddleware = createTrailingEmptyAssistantRemovalMiddleware();
