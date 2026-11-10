import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_EARLY_RESULT_REMINDER_THRESHOLD,
  DEFAULT_SEND_MESSAGE_REMINDER_THRESHOLD,
  EARLY_RESULT_REMINDER_MESSAGE,
  SEND_MESSAGE_REMINDER_MESSAGE,
  SLATE_SEND_MESSAGE_TOOL_NAME,
  countToolCallsSinceLastSendMessage,
  createDiskPressureReminderMiddleware,
  createSendMessageReminderMiddleware,
  countNonSendMessageToolCalls,
  getUserMessageText,
  hasReminderFiredThisSilentStreak,
  hasSendMessageCall,
  hasSendMessageSinceRealTurnStart,
  isInjectedReminderMessage,
  isSendMessageReminderMessage,
} from "../../source/host/runner/send-message-reminder-middleware.ts";

type Message = Parameters<typeof getUserMessageText>[0];

const user = (text: string): Message => ({ role: "user", content: text });
const textOnly = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const toolCall = (toolName: string): Message => ({ role: "assistant", content: [{ type: "tool-call", toolName }] });
const marked = (mark: string): Message => ({ role: "user", content: "a reminder", providerOptions: { slate: { [mark]: true } } });

describe("reading a message", () => {
  it("takes the text a user wrote, and nothing from a message that is not theirs", () => {
    assert.equal(getUserMessageText(user("hello")), "hello");
    assert.equal(getUserMessageText(textOnly("hello")), "hello");
    assert.equal(getUserMessageText({ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "ab");
    assert.equal(getUserMessageText({ role: "assistant", content: "hello" }), undefined);
  });

  it("knows which messages a reminder this build injected", () => {
    for (const mark of ["slateSendMessageReminder", "slateEarlyResultReminder", "slateOpeningMessageReminder", "slateStartOfTurnAckReminder", "slateDiskPressureReminder"]) {
      assert.equal(isInjectedReminderMessage(marked(mark)), true, mark);
    }
    assert.equal(isInjectedReminderMessage(textOnly(SEND_MESSAGE_REMINDER_MESSAGE)), true, "by its text, too");
    assert.equal(isInjectedReminderMessage(textOnly(EARLY_RESULT_REMINDER_MESSAGE)), true);
    assert.equal(isInjectedReminderMessage(user("hello")), false);
    assert.equal(isSendMessageReminderMessage(textOnly(EARLY_RESULT_REMINDER_MESSAGE)), false, "the early reminder is not the quiet one");
  });

  it("knows whether the agent has spoken, and how many calls it made without doing so", () => {
    assert.equal(SLATE_SEND_MESSAGE_TOOL_NAME, "SendMessage");
    assert.equal(hasSendMessageCall(toolCall("SendMessage")), true);
    assert.equal(hasSendMessageCall(toolCall("Read")), false);
    assert.equal(hasSendMessageCall(user("SendMessage")), false, "a user message is not a tool call");
    assert.equal(countToolCallsSinceLastSendMessage([toolCall("Read"), toolCall("Bash")]), 2);
    assert.equal(countToolCallsSinceLastSendMessage([toolCall("Read"), toolCall("SendMessage"), toolCall("Bash")]), 1);
    // The walk stops at the user message, so only the calls after it are counted.
    assert.equal(countToolCallsSinceLastSendMessage([user("go"), toolCall("Read")]), 1);
    // The walk stops at the user message: a call made before it is not in this turn's silence.
    assert.equal(countToolCallsSinceLastSendMessage([toolCall("Read"), user("go"), toolCall("Bash")]), 1);
    assert.equal(countNonSendMessageToolCalls({ role: "assistant", content: [{ type: "tool-call", toolName: "Read" }, { type: "tool-call", toolName: "SendMessage" }] }), 1, "the agent's own message is not a quiet call");
  });

  it("knows whether the agent has spoken since the turn really started, and whether a reminder already fired", () => {
    assert.equal(hasSendMessageSinceRealTurnStart([user("go"), toolCall("Read"), toolCall("SendMessage")]), true);
    assert.equal(hasSendMessageSinceRealTurnStart([user("go"), toolCall("Read")]), false);
    assert.equal(hasSendMessageSinceRealTurnStart([marked("slateSendMessageReminder"), toolCall("SendMessage")]), true, "a reminder is not the turn start");
    // A reminder newer than the send is stepped over, and the send behind it still counts.
    assert.equal(hasSendMessageSinceRealTurnStart([toolCall("SendMessage"), marked("slateSendMessageReminder"), toolCall("Read")]), true);
    assert.equal(hasReminderFiredThisSilentStreak([toolCall("Read"), marked("slateEarlyResultReminder")]), true);
    // The walk stops at the first reminder it meets, whatever came before it.
    assert.equal(hasReminderFiredThisSilentStreak([toolCall("Read"), toolCall("SendMessage"), marked("slateEarlyResultReminder")]), true);
    // Only a user message, a system message or a send ends the walk: a reminder behind the silence still counts.
    assert.equal(hasReminderFiredThisSilentStreak([marked("slateEarlyResultReminder"), user("go"), toolCall("Read")]), false, "a reminder before a user message is another streak");
  });
});

describe("reminding an agent that has gone quiet", () => {
  /** A middleware over a conversation, and what it appended before the turn ran. */
  function run(messages: readonly Message[], options: { threshold?: number; earlyResultThreshold?: number } = {}) {
    const appended: Message[] = [];
    const executor = {
      getMessages: () => messages,
      getState: () => messages,
      clearMessages: () => {},
      appendMessages: (message: Message | readonly Message[]) => {
        for (const one of Array.isArray(message) ? message : [message]) appended.push(one);
      },
      stream: () => "streamed",
    };
    const middleware = createSendMessageReminderMiddleware(options)(executor);
    assert.equal(middleware.stream(), "streamed");
    return appended;
  }

  it("reminds after more tool calls than the threshold, and the reminder is marked hidden", () => {
    assert.equal(DEFAULT_SEND_MESSAGE_REMINDER_THRESHOLD, 6);
    assert.equal(DEFAULT_EARLY_RESULT_REMINDER_THRESHOLD, 0);
    const quiet = Array.from({ length: 7 }, () => toolCall("Read"));
    const appended = run(quiet);
    assert.equal(appended.length, 1);
    assert.equal(appended[0]?.content, SEND_MESSAGE_REMINDER_MESSAGE);
    assert.equal(isInjectedReminderMessage(appended[0]!), true);
    assert.deepEqual(run(quiet.slice(0, 6)), [], "six calls is not more than six");
  });

  it("does not repeat a reminder that is already the last thing said", () => {
    assert.deepEqual(run([...Array.from({ length: 7 }, () => toolCall("Read")), textOnly(SEND_MESSAGE_REMINDER_MESSAGE)]), []);
  });

  it("reminds early when there is a result to deliver, once per run of silence", () => {
    const withResult = [user("go"), toolCall("SendMessage"), toolCall("Read")];
    const appended = run(withResult, { threshold: 6, earlyResultThreshold: 0 });
    assert.equal(appended[0]?.content, EARLY_RESULT_REMINDER_MESSAGE);
    assert.equal(isInjectedReminderMessage(appended[0]!), true);
    assert.deepEqual(run([...withResult, textOnly(EARLY_RESULT_REMINDER_MESSAGE)], { threshold: 6, earlyResultThreshold: 0 }), [], "already reminded in this streak");
  });

  it("holds the early reminder back until the early threshold is passed", () => {
    assert.deepEqual(run([user("go"), toolCall("SendMessage"), toolCall("Read")], { threshold: 6, earlyResultThreshold: 5 }), []);
    assert.equal(run([user("go"), toolCall("SendMessage"), toolCall("Read")], { threshold: 6, earlyResultThreshold: 0 }).length, 1);
  });

  it("does not remind early twice in one run of silence", () => {
    const already = [user("go"), toolCall("SendMessage"), toolCall("Read"), textOnly(EARLY_RESULT_REMINDER_MESSAGE), toolCall("Read")];
    assert.deepEqual(run(already, { threshold: 6, earlyResultThreshold: 0 }), []);
  });

  it("warns about disk pressure once per episode, not on every turn", () => {
    const warn = (messages: readonly Message[]) => {
      const appended: Message[] = [];
      const executor = {
        getMessages: () => messages,
        getState: () => messages,
        clearMessages: () => {},
        appendMessages: (message: Message | readonly Message[]) => {
          for (const one of Array.isArray(message) ? message : [message]) appended.push(one);
        },
        stream: () => "streamed",
      };
      createDiskPressureReminderMiddleware("episode-1")(executor).stream();
      return appended;
    };
    assert.equal(warn([user("hello")]).length, 1);
    const warned = { role: "user", content: "a warning", providerOptions: { slate: { slateDiskPressureReminder: true, slateDiskPressureReminderEpisodeId: "episode-1" } } };
    assert.deepEqual(warn([user("hello"), warned]), [], "this episode was already warned");
    const otherEpisode = { ...warned, providerOptions: { slate: { slateDiskPressureReminder: true, slateDiskPressureReminderEpisodeId: "episode-2" } } };
    assert.equal(warn([user("hello"), otherEpisode]).length, 1, "another episode has not been");
  });

  it("does not remind early when the agent has not spoken at all", () => {
    assert.deepEqual(run([user("go"), toolCall("Read")], { threshold: 6, earlyResultThreshold: 0 }), []);
  });
});
