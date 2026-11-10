/**
 * Talking on a channel: what an outbound message becomes, the cue that wakes the agent, the system-prompt section
 * describing channels, and the notices for a delivery that failed.
 */
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHANNEL_CONFIG_FILENAME,
  CHANNEL_CREDENTIAL_FIELD,
  CHANNEL_DELIVERY_FAILED_WAKE_CUE,
  CHANNEL_INBOUND_WAKE_CUE,
  CHANNEL_MAX_LABEL_LENGTH,
  buildChannelDeliveryFailureWakePrompt,
  buildChannelInboundWakePrompt,
  buildChannelOutboundMessage,
  clampChannelLabel,
  formatChannelReactionSummary,
  humanizeChannelDeliveryFailure,
  renderChannelsSystemPrompt,
} from "../../source/host/channels/channel-messaging.ts";
import { SLACK_PLATFORM, type ConnectorManifest } from "../../source/host/channels/channels.ts";

const availableManifest: ConnectorManifest = {
  platform: "slack",
  displayName: "Slack",
  blurb: "Message in Slack channels and DMs.",
  credentialLabel: "app token",
  availability: "available",
  connectGuide: "Add the app token.\nThen pick a channel.",
};
const comingSoonManifest: ConnectorManifest = {
  platform: "discord",
  displayName: "Discord",
  blurb: "Message in Discord servers and DMs (coming soon).",
  credentialLabel: "bot token",
  availability: "coming-soon",
  connectGuide: "",
};

test("the channel constants are the ones the rest of the host reads", () => {
  assert.equal(CHANNEL_CONFIG_FILENAME, "connection.json");
  assert.equal(CHANNEL_MAX_LABEL_LENGTH, 80);
  assert.equal(CHANNEL_INBOUND_WAKE_CUE, "[inbound]");
  assert.equal(CHANNEL_DELIVERY_FAILED_WAKE_CUE, "[channel-delivery-failed]");
  assert.equal(CHANNEL_CREDENTIAL_FIELD, "token");
});

test("a label is clamped to one bounded line", () => {
  assert.equal(clampChannelLabel("  hello\nworld  "), "hello world");
  assert.equal(clampChannelLabel("x".repeat(80)).length, 80);
  assert.equal(clampChannelLabel("x".repeat(120)).length, 80);
});

test("an outbound text message becomes text, or an attachment when it carries an image", () => {
  assert.deepEqual(buildChannelOutboundMessage({ type: "text", content: "hello" }), { kind: "text", text: "hello" });
  assert.equal(buildChannelOutboundMessage({ type: "text", content: "" }), null);
  assert.deepEqual(
    buildChannelOutboundMessage({ type: "text", content: "look", images: [{ url: "" }, { url: "https://x/a.png" }] }),
    { kind: "attachment", url: "https://x/a.png", caption: "look" },
  );
  assert.deepEqual(
    buildChannelOutboundMessage({ type: "text", content: "", images: [{ url: "https://x/a.png" }] }),
    { kind: "attachment", url: "https://x/a.png", caption: null },
  );
});

test("an outbound attachment keeps its url and alt text and degrades to text without one", () => {
  assert.deepEqual(
    buildChannelOutboundMessage({ type: "attachment", url: "https://x/a.pdf", alt: "the file" }),
    { kind: "attachment", url: "https://x/a.pdf", caption: "the file" },
  );
  assert.deepEqual(
    buildChannelOutboundMessage({ type: "attachment", url: "https://x/a.pdf", alt: "" }),
    { kind: "attachment", url: "https://x/a.pdf", caption: null },
  );
  assert.deepEqual(
    buildChannelOutboundMessage({ type: "attachment", url: "", alt: "the file" }),
    { kind: "text", text: "the file" },
  );
  assert.equal(buildChannelOutboundMessage({ type: "attachment", url: "", alt: null }), null);
  assert.equal(buildChannelOutboundMessage({ type: "other" } as never), null);
});

test("a reaction is summarised with or without the quoted message", () => {
  assert.equal(formatChannelReactionSummary({ emoji: "❤️" }), "reacted ❤️ to a message");
  assert.equal(formatChannelReactionSummary({ emoji: "❤️", messageQuote: null }), "reacted ❤️ to a message");
  assert.equal(formatChannelReactionSummary({ emoji: "❤️", messageQuote: "" }), "reacted ❤️ to a message");
  assert.equal(formatChannelReactionSummary({ emoji: "👍", messageQuote: "good plan" }), "reacted 👍 to your message: \"good plan\"");
});

test("the inbound wake prompt names the channel, the sender and every message", () => {
  const prompt = buildChannelInboundWakePrompt([
    { address: { platform: SLACK_PLATFORM, chat: "C123" }, sender: "Ada", text: "are you there?" },
    { address: { platform: SLACK_PLATFORM, chat: "C123" }, sender: "Ada", text: "hello?" },
  ]);
  assert.equal(prompt.startsWith(CHANNEL_INBOUND_WAKE_CUE + " New messages on a channel you are connected to."), true);
  assert.match(prompt, /On Slack, from slack:C123:\n  Ada: are you there\?\n  Ada: hello\?/);
  assert.match(prompt, /Reply to them by calling SendMessage with the channel target/);
  assert.match(prompt, /not the user typing in this app/);
});

test("one inbound message is singular, and a reaction-only wake says not to reply", () => {
  const prompt = buildChannelInboundWakePrompt([
    { address: { platform: SLACK_PLATFORM, chat: "C1" }, sender: "Ada", text: "", reaction: { emoji: "❤️" } },
  ]);
  assert.equal(prompt.startsWith(CHANNEL_INBOUND_WAKE_CUE + " New reaction on a channel you are connected to."), true);
  assert.match(prompt, /Ada reacted ❤️ to a message/);
  assert.match(prompt, /don't need to reply/);
  assert.equal(buildChannelInboundWakePrompt([]).includes("New message"), false);
});

test("a failure notice speaks plainly about each failed send", () => {
  const singular = buildChannelDeliveryFailureWakePrompt([{ addressToken: "slack:C1", reason: "not connected" }]);
  assert.equal(singular.startsWith(CHANNEL_DELIVERY_FAILED_WAKE_CUE), true);
  assert.match(singular, /- To slack:C1: not connected/);
  assert.match(singular, /the message didn't go through/);
  const plural = buildChannelDeliveryFailureWakePrompt([
    { addressToken: "slack:C1", reason: "a" },
    { addressToken: "slack:C2", reason: "b" },
  ]);
  assert.match(plural, /the messages didn't go through/);
});

test("a delivery failure is explained in the user's terms", () => {
  assert.equal(
    humanizeChannelDeliveryFailure("not-an-address", "whatever"),
    "\"not-an-address\" isn't a valid channel address, so that message wasn't delivered.",
  );
  assert.equal(
    humanizeChannelDeliveryFailure("slack:C1", "not a valid channel address"),
    "\"slack:C1\" isn't a valid channel address, so that message wasn't delivered.",
  );
  assert.equal(
    humanizeChannelDeliveryFailure("slack:C1", "No channel delivery mechanism is registered."),
    "Channel messaging isn't available on this computer, so that message wasn't delivered.",
  );
  assert.equal(
    humanizeChannelDeliveryFailure("slack:C1", "there is no live Slack connection"),
    "Slack isn't connected on this computer, so that message wasn't delivered. Connect Slack (add its token) to send there.",
  );
  assert.equal(
    humanizeChannelDeliveryFailure("slack:C1", "  the token expired  "),
    "Couldn't deliver that message to Slack: the token expired",
  );
});

test("the system-prompt section says nothing when there is nothing to show", () => {
  assert.equal(renderChannelsSystemPrompt([availableManifest], [], null), "");
  assert.equal(renderChannelsSystemPrompt([], [], "/repo"), "");
  const withConnection = renderChannelsSystemPrompt([], [{ platform: "slack", label: "work", status: "connected" }], "/repo");
  assert.match(withConnection, /Currently connected:/);
});

test("the system-prompt section describes where channels live and how to address them", () => {
  const prompt = renderChannelsSystemPrompt([availableManifest, comingSoonManifest], [], "/repo");
  assert.equal(prompt.startsWith("Channels: outside messaging surfaces"), true);
  assert.match(prompt, /subfolder at \/repo holding a connection\.json/);
  assert.match(prompt, /Never ask the user to paste a token/);
  assert.match(prompt, /Every conversation on a channel has an address shaped like platform:chat/);
  assert.match(prompt, /\[inbound\] cue/);
  assert.match(prompt, /Platforms you can connect:/);
  assert.match(prompt, /- Slack: Message in Slack channels and DMs\./);
  assert.match(prompt, /  Add the app token\.\n  Then pick a channel\./);
  assert.match(prompt, /Coming soon \(not connectable yet\): Discord\./);
  assert.match(prompt, /No channels connected yet\./);
});

test("connected channels are listed, with error detail when they have one", () => {
  const prompt = renderChannelsSystemPrompt(
    [availableManifest],
    [
      { platform: "slack", label: "work", status: "connected" },
      { platform: "discord", label: "friends", status: "error", detail: "token expired" },
    ],
    "/repo",
  );
  assert.match(prompt, /Currently connected:/);
  assert.match(prompt, /- Slack "work" \[connected\]\. Address people on it as slack:<chat id>/);
  assert.match(prompt, /- Discord "friends" \[error\] \(token expired\)\. Address people on it as discord:<chat id>/);
  assert.doesNotMatch(prompt, /No channels connected yet/);
});

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

test("the whole channel section of the system prompt is stable", () => {
  const prompt = renderChannelsSystemPrompt([availableManifest, comingSoonManifest], [], "/repo");
  assert.equal(hashOf(prompt), "7ab6b694e59077c5fda3cb1609e540496ad8fd79ee3c5afbbd9ce59b8e58d6a1");
  const connected = renderChannelsSystemPrompt(
    [availableManifest],
    [
      { platform: "slack", label: "work", status: "connected" },
      { platform: "discord", label: "friends", status: "error", detail: "token expired" },
    ],
    "/repo",
  );
  assert.equal(hashOf(connected), "ed17ab90927d3dfa00f2ff132f1b11f3c45907040c6cfe6f6f2ea4c34ab57b71");
});

test("the whole inbound wake prompt and failure notice are stable", () => {
  const inbound = buildChannelInboundWakePrompt([
    { address: { platform: SLACK_PLATFORM, chat: "C123" }, sender: "Ada", text: "are you there?" },
    { address: { platform: SLACK_PLATFORM, chat: "C123" }, sender: "Ada", text: "hello?" },
    { address: { platform: "discord", chat: "D1" }, sender: "Bob", text: "hi" },
    { address: { platform: SLACK_PLATFORM, chat: "C999" }, sender: "Ada", text: "", reaction: { emoji: "❤️" } },
  ]);
  assert.equal(hashOf(inbound), "747ca5e350d72e09e05d76fa8d10ad39b9075d5b4821a1caeb6dff3361098fcf");
  const failures = buildChannelDeliveryFailureWakePrompt([
    { addressToken: "slack:C1", reason: "a" },
    { addressToken: "slack:C2", reason: "b" },
  ]);
  assert.equal(hashOf(failures), "56a0d90e93e902dd29cb0f785827615ab3d9d167c03d4fa14a9a46a7cf122580");
});

test("a connection on a platform we do not describe falls back to its own name", () => {
  const prompt = renderChannelsSystemPrompt([], [{ platform: "telegram", label: "friends", status: "connected" }], "/repo");
  assert.match(prompt, /- telegram "friends" \[connected\]\. Address people on it as telegram:<chat id>/);
  assert.equal(
    humanizeChannelDeliveryFailure("telegram:T1", "there is no live telegram connection"),
    "telegram isn't connected on this computer, so that message wasn't delivered. Connect telegram (add its token) to send there.",
  );
});

test("single-character text and alt text are still content", () => {
  assert.deepEqual(buildChannelOutboundMessage({ type: "text", content: "a" }), { kind: "text", text: "a" });
  assert.deepEqual(
    buildChannelOutboundMessage({ type: "attachment", url: "https://x/a.pdf", alt: "a" }),
    { kind: "attachment", url: "https://x/a.pdf", caption: "a" },
  );
});

test("the reaction-only wake prompt is stable", () => {
  const prompt = buildChannelInboundWakePrompt([
    { address: { platform: SLACK_PLATFORM, chat: "C1" }, sender: "Ada", text: "", reaction: { emoji: "👍", messageQuote: "good" } },
  ]);
  assert.equal(hashOf(prompt), "64b68e7ccb3d0ade3b2a9e674720cf4e345c5bd0de0652d74e2861eddf1309ff");
});
