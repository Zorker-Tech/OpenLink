/**
 * Reminding an agent that has been working without saying anything to the room.
 *
 * A turn that has made several tool calls without sending a message is reminded to deliver what it has, and an early
 * result is reminded sooner; the reminder is marked as hidden so the reader is not shown it as a message.
 */
export const SLATE_SEND_MESSAGE_TOOL_NAME = "SendMessage";
export const DEFAULT_SEND_MESSAGE_REMINDER_THRESHOLD = 6;
export const DEFAULT_EARLY_RESULT_REMINDER_THRESHOLD = 0;

export const SEND_MESSAGE_REMINDER_MESSAGE = `<system_reminder>
You have made several tool calls without a SendMessage, so the user is currently watching silence. Actually invoke the SendMessage tool now. Send a brief, specific update on what you are doing or what you just found before continuing.
</system_reminder>`;

export const EARLY_RESULT_REMINDER_MESSAGE = `<system_reminder>
Remember: the user cannot see tool output or your thinking — only SendMessage reaches them. If you have produced a result or finished what they asked, send it now with SendMessage tool call before continuing or ending the turn. If you are still mid-task, keep working and send the result once you have it.
</system_reminder>`;

export const DISK_PRESSURE_REMINDER_MESSAGE = `<system_reminder>
The box is near disk capacity. Avoid disk-heavy work and do not fill the remaining capacity.
</system_reminder>`;

export interface MessageLike {
  readonly role: string;
  readonly content: string | readonly { readonly type?: string; readonly text?: string; readonly toolName?: string }[];
  readonly providerOptions?: { readonly cursor?: Readonly<Record<string, unknown>> };
}

/** The mark a reminder carries in the provider options, so a reader can tell it from something the user wrote. */
type ReminderMark = "slateSendMessageReminder" | "slateEarlyResultReminder" | "slateStartOfTurnAckReminder" | "slateDiskPressureReminder";

/** The text of a message the user wrote, or nothing when the message is not one of theirs. */
export function getUserMessageText(message: MessageLike): string | undefined {
  if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/** Whether a message carries this reminder's text. */
function carriesReminderText(message: MessageLike, text: string): boolean {
  return getUserMessageText(message)?.includes(text) ?? false;
}

/** Whether a message is marked with this reminder. */
function isMarked(message: MessageLike, mark: ReminderMark): boolean {
  return message.providerOptions?.cursor?.[mark] === true;
}

/** Whether a message is a reminder this build injected, rather than something the user or the agent said. */
export function isInjectedReminderMessage(message: MessageLike): boolean {
  const marks: readonly ReminderMark[] = ["slateSendMessageReminder", "slateEarlyResultReminder", "slateStartOfTurnAckReminder", "slateDiskPressureReminder"];
  if (marks.some((mark) => isMarked(message, mark))) return true;
  return carriesReminderText(message, SEND_MESSAGE_REMINDER_MESSAGE) || carriesReminderText(message, EARLY_RESULT_REMINDER_MESSAGE);
}

export function isSendMessageReminderMessage(message: MessageLike): boolean {
  return carriesReminderText(message, SEND_MESSAGE_REMINDER_MESSAGE);
}

/** The tool calls a message made that were not the agent speaking to the room. */
function nonSendMessageToolCalls(message: MessageLike): readonly { readonly type?: string; readonly toolName?: string }[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.filter((part) => part.type === "tool-call" && part.toolName !== SLATE_SEND_MESSAGE_TOOL_NAME);
}

/** Whether the agent has spoken to the room in this message. */
export function hasSendMessageCall(message: MessageLike): boolean {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
  return message.content.some((part) => part.type === "tool-call" && part.toolName === SLATE_SEND_MESSAGE_TOOL_NAME);
}

export function countNonSendMessageToolCalls(message: MessageLike): number {
  return nonSendMessageToolCalls(message).length;
}

/** How many tool calls the agent has made since it last spoke, walking back from the newest message. */
export function countToolCallsSinceLastSendMessage(messages: readonly MessageLike[]): number {
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message == null || message.role === "user" || message.role === "system" || hasSendMessageCall(message)) break;
    count += countNonSendMessageToolCalls(message);
  }
  return count;
}

/** Whether the agent has spoken to the room since the turn actually started, reminders not counting as a turn start. */
export function hasSendMessageSinceRealTurnStart(messages: readonly MessageLike[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message == null) continue;
    if (isInjectedReminderMessage(message)) continue;
    if (message.role === "user" || message.role === "system") return false;
    if (hasSendMessageCall(message)) return true;
  }
  return false;
}

/** Whether a reminder has already fired in this run of silence. */
export function hasReminderFiredThisSilentStreak(messages: readonly MessageLike[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message == null) continue;
    if (isInjectedReminderMessage(message)) return true;
    if (message.role === "user" || message.role === "system" || hasSendMessageCall(message)) return false;
  }
  return false;
}

/** A reminder as the message that carries it: written as the user, and marked so no reader shows it. */
function reminderMessage(text: string, mark: ReminderMark): MessageLike {
  return { role: "user", content: text, providerOptions: { cursor: { [mark]: true } } };
}

export function createSendMessageReminderMessage(): MessageLike {
  return reminderMessage(SEND_MESSAGE_REMINDER_MESSAGE, "slateSendMessageReminder");
}

export function createEarlyResultReminderMessage(): MessageLike {
  return reminderMessage(EARLY_RESULT_REMINDER_MESSAGE, "slateEarlyResultReminder");
}

export interface PromptExecutor {
  getMessages(): readonly MessageLike[];
  getState(): readonly MessageLike[];
  clearMessages(): void;
  appendMessages(messages: MessageLike | readonly MessageLike[]): void;
  stream(...args: any[]): unknown;
}

/** A middleware that holds another executor and passes everything through to it. */
abstract class WrappingMiddleware {
  constructor(readonly innerExecutor: PromptExecutor) {}

  getMessages(): readonly MessageLike[] {
    return this.innerExecutor.getMessages();
  }

  getState(): readonly MessageLike[] {
    return this.innerExecutor.getState();
  }

  clearMessages(): void {
    this.innerExecutor.clearMessages();
  }

  appendMessages(messages: MessageLike | readonly MessageLike[]): void {
    this.innerExecutor.appendMessages(messages);
  }

  /** What to append before the turn runs, if anything. */
  protected abstract reminderFor(messages: readonly MessageLike[]): MessageLike | undefined;

  stream(...args: any[]): unknown {
    const reminder = this.reminderFor(this.innerExecutor.getMessages());
    if (reminder !== undefined) this.innerExecutor.appendMessages(reminder);
    return this.innerExecutor.stream(...args);
  }
}

/** Warns once per episode that the box is running out of room. */
export class DiskPressureReminderMiddleware extends WrappingMiddleware {
  constructor(innerExecutor: PromptExecutor, readonly episodeId: string) {
    super(innerExecutor);
  }

  protected reminderFor(messages: readonly MessageLike[]): MessageLike | undefined {
    const alreadyWarned = messages.some((message) => message.providerOptions?.cursor?.slateDiskPressureReminderEpisodeId === this.episodeId);
    if (alreadyWarned) return undefined;
    return {
      role: "user",
      content: DISK_PRESSURE_REMINDER_MESSAGE,
      providerOptions: { cursor: { slateDiskPressureReminder: true, slateDiskPressureReminderEpisodeId: this.episodeId } },
    };
  }
}

export function createDiskPressureReminderMiddleware(episodeId: string) {
  return (executor: PromptExecutor) => new DiskPressureReminderMiddleware(executor, episodeId);
}

/** Reminds an agent that has gone quiet, and reminds it sooner when it has a result to deliver. */
export class SendMessageReminderMiddleware extends WrappingMiddleware {
  constructor(innerExecutor: PromptExecutor, readonly thresholds: { threshold: number; earlyResultThreshold: number }) {
    super(innerExecutor);
  }

  protected reminderFor(messages: readonly MessageLike[]): MessageLike | undefined {
    // A reminder already at the end of the conversation is not repeated.
    const last = messages.at(-1);
    if (last != null && isSendMessageReminderMessage(last)) return undefined;
    const quietCalls = countToolCallsSinceLastSendMessage(messages);
    if (quietCalls > this.thresholds.threshold) return createSendMessageReminderMessage();
    if (quietCalls <= this.thresholds.earlyResultThreshold) return undefined;
    // An early reminder only makes sense when there is a result behind it, and only once per run of silence.
    if (!hasSendMessageSinceRealTurnStart(messages) || hasReminderFiredThisSilentStreak(messages)) return undefined;
    return createEarlyResultReminderMessage();
  }
}

export function createSendMessageReminderMiddleware(options: { threshold?: number; earlyResultThreshold?: number } = {}) {
  return (executor: PromptExecutor) =>
    new SendMessageReminderMiddleware(executor, {
      threshold: options.threshold ?? DEFAULT_SEND_MESSAGE_REMINDER_THRESHOLD,
      earlyResultThreshold: options.earlyResultThreshold ?? DEFAULT_EARLY_RESULT_REMINDER_THRESHOLD,
    });
}
