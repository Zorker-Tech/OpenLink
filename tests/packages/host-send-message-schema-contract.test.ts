import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SEND_MESSAGE_TYPES,
  SEND_MESSAGE_TYPE_DESCRIPTION,
  isFieldProvided,
  isValidAttachmentUrl,
  refineSendMessage,
  sendMessageParameters,
  type SendMessageInput,
} from "../../source/host/runner/tools/send-message-schema.ts";

describe("SendMessage schema behavior contract", () => {
  it("publishes only Slate message types and their product description", () => {
    assert.deepEqual(SEND_MESSAGE_TYPES, ["text", "attachment", "widget", "slate-agent", "secret-request"]);
    assert.match(SEND_MESSAGE_TYPE_DESCRIPTION, /Slate cloud agent/);
    assert.equal(SEND_MESSAGE_TYPE_DESCRIPTION.includes("Grok"), false);
  });

  it("accepts only file and HTTPS attachment URLs", () => {
    for (const url of ["file:///tmp/image.png", "https://example.test/image.png", "https://user:pass@example.test/x"]) {
      assert.equal(isValidAttachmentUrl(url), true, url);
    }
    for (const url of ["http://example.test/x", "ftp://example.test/x", "javascript:alert(1)", "not a URL"]) {
      assert.equal(isValidAttachmentUrl(url), false, url);
    }
  });

  it("defines provided fields without treating empty strings or arrays as supplied", () => {
    for (const value of [undefined, null, "", []]) assert.equal(isFieldProvided(value), false);
    for (const value of [" ", 0, false, {}, ["x"]]) assert.equal(isFieldProvided(value), true);
  });

  it("requires text content and accepts ordinary text messages", () => {
    assert.deepEqual(refineSendMessage({ type: "text" }), [{ path: ["content"], message: "content is required when type is text" }]);
    assert.deepEqual(refineSendMessage({ type: "text", content: "hello" }), []);
  });

  it("requires a valid URL for standalone attachments", () => {
    assert.deepEqual(refineSendMessage({ type: "attachment" }), [{ path: ["url"], message: "url is required when type is attachment" }]);
    assert.equal(refineSendMessage({ type: "attachment", url: "http://example.test/file" })[0]?.path[0], "url");
    assert.deepEqual(refineSendMessage({ type: "attachment", url: "file:///tmp/file" }), []);
  });

  it("rejects fields that would be silently lost under another message type", () => {
    const value = {
      type: "widget",
      content: "text",
      url: "https://example.test/a",
      alt: "image",
      widget: { prompt: "Q", options: [{ label: "A" }] },
      agentId: "bc-1",
      secret: { label: "Token", connector: "chat", field: "token" },
    } as SendMessageInput;
    const issues = refineSendMessage(value);
    assert.deepEqual(issues.map(({ path }) => path[0]), ["content", "url", "alt", "agentId", "secret"]);
    assert.equal(issues.every(({ message }) => message.includes("cannot ride a type:widget message") && message.includes("Nothing was sent")), true);
  });

  it("restricts channels and images to their supported message kinds", () => {
    const channelIssue = refineSendMessage({ type: "widget", channel: "slack:C1", widget: { prompt: "Q", options: [{ label: "A" }] } });
    assert.equal(channelIssue[0]?.path[0], "channel");
    const imageIssue = refineSendMessage({ type: "attachment", url: "file:///tmp/a.png", images: [{ url: "file:///tmp/b.png" }] });
    assert.equal(imageIssue[0]?.path[0], "images");
    assert.deepEqual(refineSendMessage({ type: "text", content: "hello", channel: "slack:C1", images: [] }), []);
  });

  it("reports every invalid text-image URL at its indexed path", () => {
    const issues = refineSendMessage({
      type: "text",
      content: "caption",
      images: [{ url: "https://example.test/a" }, { url: "http://example.test/b" }, { url: "bad" }],
    });
    assert.deepEqual(issues.map(({ path }) => path), [["images", 1, "url"], ["images", 2, "url"]]);
  });

  it("trims schema strings before refinement and strips unknown input properties", () => {
    const valid = sendMessageParameters.safeParse({ type: "text", content: "  hello  ", reply_to: " t1 ", ignored: true });
    assert.equal(valid.success, true);
    if (valid.success) assert.deepEqual(valid.data, { type: "text", content: "hello", reply_to: "t1" });

    const blank = sendMessageParameters.safeParse({ type: "text", content: "   " });
    assert.equal(blank.success, false);
    if (!blank.success) assert.equal(blank.error.issues.some((issue) => issue.path[0] === "content"), true);
  });

  it("validates widget contents only for widget messages", () => {
    assert.equal(sendMessageParameters.safeParse({
      type: "widget",
      widget: { prompt: "  Choose one? ", options: [{ label: " Yes " }] },
    }).success, true);
    assert.equal(sendMessageParameters.safeParse({ type: "widget", widget: { prompt: "Q", options: [] } }).success, false);
    assert.equal(sendMessageParameters.safeParse({ type: "text", content: "hi", widget: { prompt: "Q", options: [{ label: "A" }] } }).success, false);
  });

  it("validates secret-request fields and permits a Slate agent reference", () => {
    assert.equal(sendMessageParameters.safeParse({
      type: "secret-request",
      secret: { label: " Token ", connector: "chat", field: "token" },
    }).success, true);
    assert.equal(sendMessageParameters.safeParse({ type: "secret-request", secret: { label: "Token", connector: "chat" } }).success, false);
    assert.equal(sendMessageParameters.safeParse({ type: "slate-agent", agentId: " bc-1 " }).success, true);
  });

  it("keeps explicit reply addresses and attachment alt text independent of message content", () => {
    const attachment = sendMessageParameters.safeParse({
      type: "attachment",
      url: " https://example.test/file.png ",
      alt: " preview ",
      reply_to: " t2u ",
      channel: "slack:C2",
    });
    assert.equal(attachment.success, true);
    if (attachment.success) assert.deepEqual(attachment.data, {
      type: "attachment", url: "https://example.test/file.png", alt: "preview", reply_to: "t2u", channel: "slack:C2",
    });
  });
});
