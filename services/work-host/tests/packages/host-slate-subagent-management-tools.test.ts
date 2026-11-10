import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkSubagentParameters,
  createSubagentManagementTools,
  describeRunningSubagent,
  elapsedLabel,
  messageSubagentParameters,
  notRunningMessage,
  stopSubagentParameters,
  type RunningSubagentInfo,
  type SubagentManagementController,
} from "../../source/host/runner/tools/slate-subagent-management-tools.ts";
import { createContext } from "../../source/packages/context/context.ts";

const info = (overrides: Partial<RunningSubagentInfo> = {}): RunningSubagentInfo => ({
  subagentId: "agent-1",
  subagentType: "general",
  title: "Writer",
  elapsedMs: 95_000,
  toolCallCount: 3,
  recentActivity: ["read file", "wrote file"],
  transcriptPath: "/tmp/t/transcript.json",
  ...overrides,
});
function world(controller: Partial<SubagentManagementController> = {}) {
  const management: SubagentManagementController = {
    listRunningSubagents: () => [info()],
    getRunningSubagent: (id) => (id === "agent-1" ? info() : undefined),
    steerSubagent: () => "steered",
    abortSubagent: () => "aborted",
    ...controller,
  };
  const tools = createSubagentManagementTools(management);
  const seen: Array<{ toolCallId: string; completed: unknown }> = [];
  const handler = {
    async executeToolCall(_ctx: unknown, _initial: unknown, toolCallId: string, execute: (ctx: unknown) => Promise<unknown>, complete: (result: unknown) => unknown) {
      const result = await execute(_ctx);
      const completed = complete(result);
      seen.push({ toolCallId, completed });
      return result;
    },
  };
  const argsOf = async function* (value: unknown) { yield JSON.stringify(value); };
  const run = async (index: number, args: unknown) => {
    const result = await (tools[index] as unknown as { execute(ctx: unknown, handler: unknown, args: AsyncIterable<string>, meta: unknown): Promise<unknown> }).execute(createContext(), handler, argsOf(args), { toolCallId: "call-1" });
    const json = (result as { toJson(): { success?: { currentStep?: string }; error?: { error?: string } } }).toJson();
    return json.success?.currentStep ?? json.error?.error ?? "";
  };
  return { tools, run, seen, management };
}

test("the subagent parameter schemas describe the ids they take", () => {
  assert.deepEqual(checkSubagentParameters.parse({ subagent_id: " a " }), { subagent_id: "a" });
  assert.deepEqual(checkSubagentParameters.parse({}), {});
  assert.equal(checkSubagentParameters.safeParse({ subagent_id: 3 }).success, false);
  assert.deepEqual(messageSubagentParameters.parse({ subagent_id: " a ", message: " go " }), { subagent_id: "a", message: "go" });
  assert.equal(messageSubagentParameters.safeParse({ subagent_id: "", message: "go" }).success, false);
  assert.equal(messageSubagentParameters.safeParse({ subagent_id: "a", message: "" }).success, false);
  assert.deepEqual(stopSubagentParameters.parse({ subagent_id: "a" }), { subagent_id: "a" });
});

test("elapsed time reads in seconds then minutes", () => {
  assert.equal(elapsedLabel(0), "0s");
  assert.equal(elapsedLabel(1_600), "2s");
  assert.equal(elapsedLabel(-5), "0s");
  assert.equal(elapsedLabel(65_000), "65s");
  assert.equal(elapsedLabel(89_000), "89s");
  assert.equal(elapsedLabel(90_000), "1m 30s");
  assert.equal(elapsedLabel(120_000), "2m");
  assert.equal(elapsedLabel(61_000), "61s");
});

test("a running subagent line carries its identity, age and activity", () => {
  assert.equal(describeRunningSubagent(info(), { detailed: false }), "- agent-1 [general] \"Writer\" — running for 1m 35s, 3 tool call(s)");
  assert.deepEqual(describeRunningSubagent(info(), { detailed: true }).split("\n"), [
    "- agent-1 [general] \"Writer\" — running for 1m 35s, 3 tool call(s)",
    "  Recent activity (oldest → newest):",
    "    read file",
    "    wrote file",
    "  Full transcript (read it for the complete play-by-play): /tmp/t/transcript.json",
  ]);
  const quiet = describeRunningSubagent(info({ recentActivity: [], transcriptPath: null }), { detailed: true });
  assert.match(quiet, /No tool activity recorded yet\./);
  assert.doesNotMatch(quiet, /Full transcript/);
});

test("a missing subagent message names it and the ones that are running", () => {
  const none = notRunningMessage("agent-9", []);
  assert.match(none, /No subagent "agent-9" is currently running/);
  assert.match(none, /No subagents are running right now\.$/);
  const some = notRunningMessage("agent-9", [info(), info({ subagentId: "agent-2" })]);
  assert.match(some, /Currently running: agent-1, agent-2\.$/);
});

test("the three tools carry their protocol ids and names", () => {
  const { tools } = world();
  assert.deepEqual(tools.map((tool) => ({ id: (tool as unknown as { toolIdentifier: string }).toolIdentifier, name: tool.name })), [
    { id: "CHECK_SUBAGENT", name: "CheckSubagent" },
    { id: "MESSAGE_SUBAGENT", name: "MessageSubagent" },
    { id: "STOP_SUBAGENT", name: "StopSubagent" },
  ]);
  for (const tool of tools) assert.equal((tool as unknown as { descriptionGenerator(): string }).descriptionGenerator().length > 100, true);
});

test("checking lists everything when no id is given", async () => {
  const { run } = world({ listRunningSubagents: () => [] });
  assert.equal(await run(0, {}), "No background subagents are running right now.");
  const one = world({ listRunningSubagents: () => [info(), info({ subagentId: "agent-2", title: "Reader", elapsedMs: 2_000, toolCallCount: 0 })] });
  const text = await one.run(0, {});
  assert.match(text, /^2 subagent\(s\) running:/);
  assert.match(text, /- agent-1 \[general\] "Writer"/);
  assert.match(text, /- agent-2 \[general\] "Reader"/);
  assert.match(text, /Pass a subagent_id to see its recent activity and transcript path\.$/);
});

test("checking a known id shows its activity and transcript, and an unknown one the running list", async () => {
  const { run } = world();
  assert.match(await run(0, { subagent_id: "agent-1" }), /Recent activity \(oldest → newest\):/);
  assert.match(await run(0, { subagent_id: "agent-9" }), /No subagent "agent-9" is currently running/);
});

test("a message goes through review and the steer call", async () => {
  const steers: unknown[][] = [];
  const worlded = world({ steerSubagent: (...args) => { steers.push(args); return "steered"; } });
  const text = await worlded.run(1, { subagent_id: "agent-1", message: "stop looping" });
  assert.deepEqual(steers, [["agent-1", "stop looping"]]);
  assert.match(text, /Message delivered to subagent agent-1\./);
  assert.match(text, /don't wait on it\.$/);
});

test("a refused steer returns the review reason and never steers", async () => {
  const steers: unknown[] = [];
  const worlded = world({
    steerSubagent: (...args) => { steers.push(args); return "steered"; },
    reviewSteer: async () => ({ allowed: false, reason: "not allowed right now" }),
  });
  assert.equal(await worlded.run(1, { subagent_id: "agent-1", message: "hi" }), "not allowed right now");
  assert.equal(steers.length, 0);
});

test("a message to a subagent that is not running says who is", async () => {
  const worlded = world({ steerSubagent: () => "not-running" });
  assert.match(await worlded.run(1, { subagent_id: "agent-9", message: "hi" }), /No subagent "agent-9" is currently running/);
});

test("stopping aborts the subagent or explains that it is not running", async () => {
  const aborts: string[] = [];
  const worlded = world({ abortSubagent: (id) => { aborts.push(id); return "aborted"; } });
  assert.match(await worlded.run(2, { subagent_id: "agent-1" }), /^Stopping subagent agent-1\./);
  assert.deepEqual(aborts, ["agent-1"]);
  const gone = world({ abortSubagent: () => "not-running" });
  assert.match(await gone.run(2, { subagent_id: "agent-9" }), /No subagent "agent-9" is currently running/);
});

test("the review receives the tool call id it was invoked with", async () => {
  const reviews: unknown[] = [];
  const worlded = world({ reviewSteer: async (_ctx, request) => { reviews.push(request); return { allowed: true, reason: "" }; } });
  await worlded.run(1, { subagent_id: "agent-1", message: "hi" });
  assert.deepEqual(reviews[0], { subagentId: "agent-1", message: "hi", toolCallId: "call-1" });
});

