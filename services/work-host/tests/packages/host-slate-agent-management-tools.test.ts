import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  createAgentParameters,
  createCreateAgentTool,
  createSendToAgentTool,
  createUpdateAgentTool,
  resolveSendToAgentImages,
  sendToAgentParameters,
  updateAgentParameters,
} from "../../source/host/runner/tools/slate-agent-management-tools.ts";
import { SLATE_CREATE_AGENT_TOOL_NAME, SLATE_SEND_TO_AGENT_TOOL_NAME, SLATE_UPDATE_AGENT_TOOL_NAME } from "../../source/host/agents/agent-messaging.ts";
import { createContext } from "../../source/packages/context/context.ts";

const streamOf = async function* (value: unknown) { yield JSON.stringify(value); };
const context = () => createContext();

function fakeInteraction() {
  const seen: Array<{ initial: unknown; toolCallId: string; completed: unknown }> = [];
  const handler = {
    async executeToolCall(_context: unknown, initial: unknown, toolCallId: string, execute: (ctx: unknown) => Promise<unknown>, complete: (result: unknown) => unknown) {
      const result = await execute(_context);
      const completed = complete(result);
      seen.push({ initial, toolCallId, completed });
      return result;
    },
  };
  return { handler, seen };
}

async function runTool(tool: Record<string, unknown>, args: unknown) {
  const { handler, seen } = fakeInteraction();
  const result = await (tool.execute as Function)(context(), handler, streamOf(args), { toolCallId: "call-1" });
  const json = (result as { toJson(): { success?: { currentStep?: string }; error?: { error?: string } } }).toJson();
  return { seen, text: json.success?.currentStep ?? json.error?.error, json };
}

test("the send parameters accept an id, a message and optional images with priority", () => {
  const valid = sendToAgentParameters.safeParse({ target_id: " agent-2 ", message: " hi ", images: [{ url: "https://example.test/shot.png", alt: " shot " }], priority: true });
  assert.equal(valid.success, true);
  assert.deepEqual(valid.success ? valid.data : null, { target_id: "agent-2", message: "hi", images: [{ url: "https://example.test/shot.png", alt: "shot" }], priority: true });
  assert.equal(sendToAgentParameters.safeParse({ target_id: "", message: "hi" }).success, false);
  assert.equal(sendToAgentParameters.safeParse({ target_id: "a", message: "" }).success, false);
});

test("an image url without a supported scheme is a field issue", () => {
  const parsed = sendToAgentParameters.safeParse({ target_id: "a", message: "b", images: [{ url: "ftp://example.test/x.png" }, { url: "file:///tmp/x.png" }] });
  assert.equal(parsed.success, false);
  const issue = parsed.success ? undefined : parsed.error.issues[0];
  assert.deepEqual(issue?.path, ["images", 0, "url"]);
  assert.match(issue?.message ?? "", /file:\/\/ or https:\/\//);
  // An empty url is rejected by the field itself, before the scheme check.
  const empty = sendToAgentParameters.safeParse({ target_id: "a", message: "b", images: [{ url: "" }] });
  assert.equal(empty.success, false);
  const emptyIssue = empty.success ? undefined : empty.error.issues[0];
  assert.deepEqual(emptyIssue?.path, ["images", 0, "url"]);
  assert.equal(emptyIssue?.code, "too_small");
});

test("a created agent gets an empty description by default", () => {
  const parsed = createAgentParameters.parse({ name: " helper " });
  assert.deepEqual(parsed, { name: "helper", description: "" });
});

test("an update only carries the fields it was given", () => {
  assert.deepEqual(updateAgentParameters.parse({ agent_id: " a " }), { agent_id: "a" });
  assert.deepEqual(updateAgentParameters.parse({ agent_id: "a", name: " n ", description: " d " }), { agent_id: "a", name: "n", description: "d" });
  assert.equal(updateAgentParameters.safeParse({ agent_id: "" }).success, false);
});

test("images are resolved into urls and only non-empty alts are kept", async () => {
  const withoutResolver = await resolveSendToAgentImages(context(), [{ url: "file:///x.png" }, { url: "https://example.test/y.png", alt: "" }]);
  assert.deepEqual(withoutResolver, [{ url: "file:///x.png" }, { url: "https://example.test/y.png" }]);
  const seen: string[] = [];
  const resolved = await resolveSendToAgentImages(context(), [{ url: "https://example.test/a.png", alt: "A" }, { url: "https://example.test/b.png" }], async (_ctx, url) => { seen.push(url); return "data:image/png;base64," + url.length; });
  assert.deepEqual(seen, ["https://example.test/a.png", "https://example.test/b.png"]);
  assert.deepEqual(resolved, [{ url: "data:image/png;base64," + "https://example.test/a.png".length, alt: "A" }, { url: "data:image/png;base64," + "https://example.test/b.png".length }]);
});

test("a send to yourself is refused before any dependency is used", async () => {
  const sent: unknown[] = [];
  const tool = createSendToAgentTool({ getSelfAgentId: () => "agent-1", sendToAgent: (...args: unknown[]) => { sent.push(args); return "sent"; } });
  assert.equal(tool.name, SLATE_SEND_TO_AGENT_TOOL_NAME);
  const result = await runTool(tool, { target_id: "agent-1", message: "hi" });
  assert.match(result.text ?? "", /can't message yourself/);
  assert.equal(sent.length, 0);
});

test("a send passes the target, message, images and priority through", async () => {
  const calls: unknown[][] = [];
  const tool = createSendToAgentTool({
    getSelfAgentId: () => "agent-1",
    async resolveImageSource(_ctx, url) { return "resolved:" + url; },
    sendToAgent(...args: unknown[]) { calls.push(args); return "delivered"; },
  });
  const withImages = await runTool(tool, { target_id: "agent-2", message: "hello", images: [{ url: "https://example.test/a.png", alt: "A" }], priority: true });
  assert.equal(withImages.text, "delivered");
  assert.deepEqual(calls[0], ["agent-2", "hello", [{ url: "resolved:https://example.test/a.png", alt: "A" }], true]);
  const without = await runTool(tool, { target_id: "agent-3", message: "plain" });
  assert.equal(without.text, "delivered");
  assert.deepEqual(calls[1], ["agent-3", "plain", undefined, undefined]);
  const notPriority = await runTool(tool, { target_id: "agent-4", message: "later", priority: false });
  assert.equal(notPriority.text, "delivered");
  assert.deepEqual(calls[2], ["agent-4", "later", undefined, undefined]);
});

test("a create tool calls the manager and names the new agent", async () => {
  const calls: unknown[] = [];
  const tool = createCreateAgentTool({
    async create(profile) { calls.push(profile); return { id: "agent-9", name: profile.name }; },
    async update() { return null; },
  });
  assert.equal(tool.name, SLATE_CREATE_AGENT_TOOL_NAME);
  const result = await runTool(tool, { name: "Writer", description: "Writes" });
  assert.deepEqual(calls[0], { name: "Writer", description: "Writes" });
  assert.match(result.text ?? "", /Created agent "Writer" \(id: agent-9\)/);
  assert.equal((result.text ?? "").includes("Message it with SendToAgent using that id."), true);
});

test("an update with no fields says there is nothing to update", async () => {
  const calls: unknown[] = [];
  const tool = createUpdateAgentTool({ async create() { return { id: "x", name: "x" }; }, async update(...args: unknown[]) { calls.push(args); return { id: "agent-1", name: "New" }; } });
  const result = await runTool(tool, { agent_id: "agent-1" });
  assert.match(result.text ?? "", /Nothing to update/);
  assert.equal(calls.length, 0);
  // Whitespace-only fields trim to empty and are not patches either.
  const blank = await runTool(tool, { agent_id: "agent-1", name: "  ", description: " " });
  assert.match(blank.text ?? "", /Nothing to update/);
  assert.equal(calls.length, 0);
});

test("an update only sends the fields that were provided", async () => {
  const calls: unknown[][] = [];
  const tool = createUpdateAgentTool({ async create() { return { id: "x", name: "x" }; }, async update(...args: unknown[]) { calls.push(args); return { id: "agent-1", name: "New" }; } });
  await runTool(tool, { agent_id: "agent-1", name: "New" });
  await runTool(tool, { agent_id: "agent-1", description: "About" });
  await runTool(tool, { agent_id: "agent-1", name: "New", description: "About" });
  assert.deepEqual(calls, [["agent-1", { name: "New" }], ["agent-1", { description: "About" }], ["agent-1", { name: "New", description: "About" }]]);
});

test("an update for an agent that is gone says so", async () => {
  const tool = createUpdateAgentTool({ async create() { return { id: "x", name: "x" }; }, async update() { return null; } });
  assert.equal(tool.name, SLATE_UPDATE_AGENT_TOOL_NAME);
  const result = await runTool(tool, { agent_id: "missing", name: "New" });
  assert.match(result.text ?? "", /No agent found with id missing\./);
  const success = createUpdateAgentTool({ async create() { return { id: "x", name: "x" }; }, async update() { return { id: "agent-2", name: "Renamed" }; } });
  assert.match((await runTool(success, { agent_id: "agent-2", name: "Renamed" })).text ?? "", /Updated agent "Renamed" \(id: agent-2\)\./);
});

