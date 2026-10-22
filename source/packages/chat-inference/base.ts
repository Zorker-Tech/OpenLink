/**
 * The messages a prompt is built from, and the small pieces that carry them around.
 *
 * A builder collects messages, hands them over and can be reset, so a caller composes a prompt without caring where it
 * ends up being sent. An executor and a middleware only forward that surface: they exist so a caller can layer one
 * behaviour on top of another without knowing whether it is talking to the builder itself.
 */
export interface PromptMessage { role: string; content: string | readonly unknown[] }

/** What a prompt surface accepts: one message, or a list of them. */
type MessageInput<TMessage> = TMessage | readonly TMessage[]

/** Reading messages as a list, and copying them so the caller keeps ownership of its own array. */
const asMessageList = <TMessage>(input: MessageInput<TMessage>): TMessage[] => Array.isArray(input) ? [...input] : [input as TMessage]

/** The four message calls every prompt surface answers. */
interface PromptMessages<TMessage> {
  appendMessages(messages: MessageInput<TMessage>): unknown
  getState(): unknown
  getMessages(): TMessage[]
  clearMessages(): void
}

/** A layer over a prompt surface: the four calls are passed through unchanged, so they are written once. */
class ForwardingPromptMessages<TMessage, TSurface extends PromptMessages<TMessage>> implements PromptMessages<TMessage> {
  constructor(protected readonly innerExecutor: TSurface) {}
  appendMessages(messages: MessageInput<TMessage>): this { this.innerExecutor.appendMessages(messages); return this }
  getState(): unknown { return this.innerExecutor.getState() }
  getMessages(): TMessage[] { return this.innerExecutor.getMessages() }
  clearMessages(): void { this.innerExecutor.clearMessages() }
}

export class BasePromptBuilder<TMessage = PromptMessage> implements PromptMessages<TMessage> {
  protected messages: TMessage[] = []
  constructor(initialMessages?: MessageInput<TMessage>) {
    if (initialMessages !== undefined) this.messages = asMessageList(initialMessages)
  }
  appendMessages(newMessages: MessageInput<TMessage>): this {
    this.messages.push(...asMessageList(newMessages))
    return this
  }
  getState(): TMessage[] { return this.getMessages() }
  getMessages(): TMessage[] { return [...this.messages] }
  clearMessages(): void { this.messages = [] }
}

export class BasePromptExecutor<TMessage = PromptMessage> extends ForwardingPromptMessages<TMessage, BasePromptBuilder<TMessage>> {
  constructor(protected readonly builder: BasePromptBuilder<TMessage>) { super(builder) }
}

export interface PromptExecutor<TMessage = PromptMessage> extends PromptMessages<TMessage> {
  getState(): unknown
  getMessages(): TMessage[]
  stream(...args: readonly unknown[]): unknown
}

export class BaseMiddleware<TMessage = PromptMessage> extends ForwardingPromptMessages<TMessage, PromptExecutor<TMessage>> implements PromptExecutor<TMessage> {
  constructor(innerExecutor: PromptExecutor<TMessage>) { super(innerExecutor) }
  stream(...args: readonly unknown[]): unknown { return this.innerExecutor.stream(...args) }
}
