import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSendMessageToolCall,
  encodeMarkdownImageDestination,
  encodeSendMessage,
  encodeTextContent,
  resolveBoxMediaAttachment,
  type EncodableMessage,
} from "../../source/host/runner/tools/send-message-encoding.ts";
import { SendMessageToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/send_message_tool_pb.ts";

function textContent(message: EncodableMessage): string {
  const result = encodeSendMessage(message);
  assert.equal(result.message.case, "text");
  if (result.message.case !== "text") throw new Error("expected a text message");
  return result.message.value.content;
}

describe("SendMessage encoding behavior contract", () => {
  it("wraps a tool call in the interop tool-call envelope", () => {
    const call = createSendMessageToolCall(new SendMessageToolCall());
    assert.equal(call.tool.case, "sendMessageToolCall");
  });

  it("keeps plain text as it was supplied and places attached images below it", () => {
    assert.equal(encodeTextContent({ content: " hello " }), " hello ");
    assert.equal(encodeTextContent({
      content: "See these",
      images: [
        { url: "file:///tmp/a.png", alt: "first" },
        { url: "https://images.test/b.png", alt: "second" },
      ],
    }), "See these\n\n![first](<file:///tmp/a.png>)\n![second](<https://images.test/b.png>)");
    assert.equal(textContent({ type: "text", content: "hello" }), "hello");
  });

  it("escapes Markdown destination delimiters and sanitizes image alt text", () => {
    assert.equal(encodeMarkdownImageDestination("https://image.test/a<b>\r\n.png"), "<https://image.test/a%3Cb%3E%0D%0A.png>");
    assert.equal(encodeTextContent({ content: "", images: [{ url: "https://image.test/x", alt: "a [caption]\nnext" }] }), "\n\n![a  caption  next](<https://image.test/x>)");
    assert.equal(encodeTextContent({ content: "caption", images: [{ url: "https://image.test/x" }] }), "caption\n\n![](<https://image.test/x>)");
  });

  it("encodes attachments as the attachment protobuf variant", () => {
    const encoded = encodeSendMessage({ type: "attachment", url: "file:///tmp/photo.png", alt: " A photo " });
    assert.equal(encoded.message.case, "attachment");
    if (encoded.message.case === "attachment") {
      assert.deepEqual([encoded.message.value.url, encoded.message.value.alt], ["file:///tmp/photo.png", " A photo "]);
    }
  });

  it("summarizes interactive widgets, secrets and permission requests as user-facing text", () => {
    assert.equal(textContent({ type: "widget", widget: { prompt: "Choose", options: [{ label: "A" }, { label: "B" }] } }), "Choose — A / B");
    assert.equal(textContent({ type: "secret-request", secret: { label: "Slack token" } }), "Secure secret input requested: Slack token");
    assert.equal(textContent({ type: "permission-request", permission: { title: "Run command", reason: "Needs access" } }), "Legacy permission request (no longer actionable): Run command — Needs access");
  });

  it("references a Slate cloud agent using its Slate-owned message type and identity", () => {
    assert.equal(textContent({ type: "slate-agent", agentId: "bc-1", title: " Build helper " }), "Referenced Slate cloud agent bc-1 (Build helper)");
    assert.equal(textContent({ type: "slate-agent", agentId: "bc-2", title: "  " }), "Referenced Slate cloud agent bc-2");
    assert.throws(() => encodeSendMessage({ type: "cursor-agent", agentId: "bc-old" }), /Unsupported send-message type/);
  });

  it("renders connector and listener prompts with the destination information", () => {
    assert.equal(textContent({ type: "connector", connector: "Linear", variant: "connected" }), "Confirmed the Linear connector is connected");
    assert.equal(textContent({ type: "connector", connector: "GitHub", variant: "connect" }), "Asked the user to connect the GitHub connector");
    assert.equal(textContent({ type: "connectors", connectors: ["Slack", "Linear"] }), "Asked the user to connect: Slack, Linear");
    assert.equal(textContent({ type: "listener-connect", platform: "slack" }), "Asked the user to connect Slack for listener routines");
    assert.equal(textContent({ type: "listener-connect", platform: "github" }), "Asked the user to connect GitHub for listener routines");
  });

  it("renders review states and local tool permission states as text summaries", () => {
    assert.equal(textContent({ type: "auto-review-approval", approval: { summary: "Remove files", status: "pending" } }), "Auto-review requested approval for: Remove files. Status: pending.");
    assert.equal(textContent({ type: "local-tool-permission", ask: { action: "write-file", target: "note.txt", status: "approved" } }), "Asked the user for permission to use their computer (write-file: note.txt). Status: approved.");
  });

  it("renders email and Slack drafts with optional metadata in place", () => {
    assert.equal(textContent({ type: "email-draft", draft: {
      from: "sender@example.test", to: ["one@example.test", "two@example.test"], cc: ["copy@example.test"],
      subject: "Hello", body: "A message",
    } }), "Draft email\nFrom: sender@example.test\nTo: one@example.test, two@example.test\nCc: copy@example.test\nSubject: Hello\n\nA message");
    assert.equal(textContent({ type: "email-draft", draft: { to: ["one@example.test"], subject: "Hello", body: "A message" } }), "Draft email\nTo: one@example.test\nSubject: Hello\n\nA message");
    assert.equal(textContent({ type: "slack-draft", draft: { workspace: "team", target: "#general", thread: "t1", body: "A message" } }), "Draft Slack message in team to #general\nThread: t1\n\nA message");
    assert.equal(textContent({ type: "slack-draft", draft: { target: "#general", body: "A message" } }), "Draft Slack message to #general\nThread: New message\n\nA message");
  });

  it("resolves an image in a desktop-enabled box and persists it with its media type", async () => {
    const data = new Uint8Array([1, 2, 3]);
    const calls: unknown[][] = [];
    const fileUrl = await resolveBoxMediaAttachment({
      boxPath: "/workspace/images/photo.png",
      remoteBoxHasDesktop: true,
      download: async (path) => { calls.push(["download", path]); return data; },
      persistImage: async (bytes, mime) => { calls.push(["image", bytes, mime]); return { fileUrl: "file:///cached/photo.png" }; },
      persistMediaBytes: async (name) => { calls.push(["media", name]); return "file:///cached/media"; },
    });
    assert.equal(fileUrl, "file:///cached/photo.png");
    assert.deepEqual(calls, [["download", "/workspace/images/photo.png"], ["image", data, "image/png"]]);
  });

  it("uses the generic media persister for a non-image file and only its basename", async () => {
    const calls: unknown[][] = [];
    const fileUrl = await resolveBoxMediaAttachment({
      boxPath: "/home/user/archive.zip",
      remoteBoxHasDesktop: true,
      download: async () => new Uint8Array([7]),
      persistMediaBytes: async (name, bytes) => { calls.push([name, bytes]); return "file:///cached/archive"; },
    });
    assert.equal(fileUrl, "file:///cached/archive");
    assert.deepEqual(calls, [["archive.zip", new Uint8Array([7])]]);
  });

  it("refuses paths outside a desktop-enabled box and isolates download or persistence failures", async () => {
    let downloads = 0;
    const blocked = await resolveBoxMediaAttachment({
      boxPath: "/etc/passwd", remoteBoxHasDesktop: true,
      download: async () => { downloads += 1; return new Uint8Array([1]); },
    });
    const noDesktop = await resolveBoxMediaAttachment({
      boxPath: "/workspace/file.png", remoteBoxHasDesktop: false,
      download: async () => { downloads += 1; return new Uint8Array([1]); },
    });
    const missing = await resolveBoxMediaAttachment({
      boxPath: "/workspace/file.png", remoteBoxHasDesktop: true,
      download: async () => null,
    });
    const failed = await resolveBoxMediaAttachment({
      boxPath: "/workspace/file.png", remoteBoxHasDesktop: true,
      download: async () => { throw new Error("box offline"); },
    });
    assert.deepEqual([blocked, noDesktop, missing, failed, downloads], [null, null, null, null, 0]);
  });
});
