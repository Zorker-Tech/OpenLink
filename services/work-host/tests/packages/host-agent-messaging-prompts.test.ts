import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ADMIN_BROADCAST_WAKE_CUE,
  AGENT_DIRECTORY_PROMPT_LIMIT,
  AGENT_INBOUND_WAKE_CUE,
  AGENT_MESSAGE_MAX_TEXT_LENGTH,
  buildAdminBroadcastWakePrompt,
  buildAgentInboundWakePrompt,
  buildMentionedAgentsContext,
  clampAgentMessage,
  describeAddress,
  renderAgentDirectorySystemPrompt,
  type AgentAddress,
  type AgentGroupAddress,
} from "../../source/host/agents/agent-messaging.ts";

const agent = (index: number, extra: Partial<AgentAddress> = {}): AgentAddress => ({
  id: `agent-${index}`,
  name: `Agent ${index}`,
  ...extra,
});

describe("agent message prompt construction", () => {
  it("keeps body trimming and the published text limit", () => {
    assert.equal(AGENT_MESSAGE_MAX_TEXT_LENGTH, 8_000);
    assert.equal(clampAgentMessage("  hello\nthere  "), "hello\nthere");
    assert.equal(clampAgentMessage("x".repeat(8_100)), "x".repeat(AGENT_MESSAGE_MAX_TEXT_LENGTH));
  });

  it("renders an address with only the annotations it actually has", () => {
    assert.equal(
      describeAddress(agent(1, { isGroup: true, description: "  tools\n and reports  " })),
      "- Agent 1 (id: agent-1) (group) — tools and reports"
    );
    assert.equal(describeAddress(agent(2, { description: " \n " })), "- Agent 2 (id: agent-2)");
    assert.equal(describeAddress(agent(3, { isGroup: 1 as unknown as boolean })), "- Agent 3 (id: agent-3)");
    const longDescription = describeAddress(agent(4, { description: "d".repeat(140) }));
    assert.equal(longDescription.slice(longDescription.indexOf(" — ") + 3).length, 120);
  });

  it("offers the no-roster path and keeps directory sections ordered and bounded", () => {
    const empty = renderAgentDirectorySystemPrompt([], [], undefined);
    assert.match(empty, /^Your teammates:/);
    assert.match(empty, /This user has no other agents yet\./);
    assert.equal(empty.includes("Teammates you can message right now:"), false);
    assert.equal(empty.includes("Discovering agents is file-based"), false);
    assert.equal(renderAgentDirectorySystemPrompt([], [], "").includes("Discovering agents is file-based"), false);

    const people = Array.from({ length: AGENT_DIRECTORY_PROMPT_LIMIT + 1 }, (_, index) => agent(index));
    const group: AgentGroupAddress = { ...agent(90, { isGroup: true }), members: [agent(1), agent(2)] };
    const withinLimit = renderAgentDirectorySystemPrompt(people.slice(0, AGENT_DIRECTORY_PROMPT_LIMIT));
    assert.match(withinLimit, /Agent 39 \(id: agent-39\)/);
    assert.equal(withinLimit.includes("…and more"), false);
    const prompt = renderAgentDirectorySystemPrompt(people, [group], "/agents");
    assert.ok(prompt.indexOf("Discovering agents is file-based") < prompt.indexOf("Teammates you can message"));
    assert.match(prompt, /under \/agents\./);
    assert.match(prompt, /Agent 0 \(id: agent-0\)/);
    assert.match(prompt, /Agent 39 \(id: agent-39\)/);
    assert.equal(prompt.includes("Agent 40 (id: agent-40)"), false);
    assert.match(prompt, /…and more \(read the agent folders above for the full roster\)\./);
    assert.match(prompt, /Agent 90 \(id: agent-90\) — with Agent 1, Agent 2/);
    assert.match(prompt, /private 1:1 DM with your user/);
    assert.equal(prompt.includes("This user has no other agents yet."), false);
  });

  it("describes a group without inventing member names", () => {
    const prompt = renderAgentDirectorySystemPrompt([], [{ ...agent(8, { isGroup: true }), members: [] }]);
    assert.match(prompt, /Group chats you're in/);
    assert.match(prompt, /- Agent 8 \(id: agent-8\)$/m);
    assert.equal(prompt.includes("— with "), false);
    assert.equal(prompt.includes("This user has no other agents yet."), false);

    const groups = Array.from({ length: AGENT_DIRECTORY_PROMPT_LIMIT + 1 }, (_, index) => ({
      ...agent(index, { isGroup: true }),
      members: [],
    }));
    const bounded = renderAgentDirectorySystemPrompt([], groups);
    assert.match(bounded, /- Agent 0 \(id: agent-0\)$/m);
    assert.match(bounded, /- Agent 39 \(id: agent-39\)$/m);
    assert.equal(bounded.includes("- Agent 40 (id: agent-40)"), false);
  });

  it("separates ordinary and priority arrivals and bounds image descriptions", () => {
    const from = agent(7);
    const ordinary = buildAgentInboundWakePrompt({ from, text: "check this" });
    assert.ok(ordinary.startsWith(`${AGENT_INBOUND_WAKE_CUE} A message just arrived`));
    assert.match(ordinary, /This is another assistant reaching out/);
    assert.match(ordinary, /Agent 7: check this/);
    assert.match(ordinary, /If it needs a reply or an action/);
    assert.match(ordinary, /SendToAgent \(their id: agent-7\)/);

    const singleImage = buildAgentInboundWakePrompt({ from, text: "one image", images: [{ url: "file:///tmp/one.png" }] });
    assert.match(singleImage, /Agent 7 attached an image to this message:/);
    assert.match(singleImage, /- file:\/\/\/tmp\/one\.png$/m);

    const priority = buildAgentInboundWakePrompt({
      from,
      text: "interrupt the run",
      priority: true,
      images: [
        { url: "file:///tmp/one.png", alt: "  a\nsmall image  " },
        { url: "https://example.test/two.png", alt: "y".repeat(220) },
      ],
    });
    assert.match(priority, /PRIORITY instruction/);
    assert.match(priority, /Agent 7 attached 2 images to this message:/);
    assert.match(priority, /- file:\/\/\/tmp\/one\.png — a small image/);
    assert.match(priority, new RegExp(`- https://example\\.test/two\\.png — y{200}(?!y)`));
    assert.match(priority, /Local image files are shown to you alongside this message/);
    assert.equal(priority.includes("This is another assistant reaching out"), false);
  });

  it("keeps the broadcast and mention envelopes distinct", () => {
    const broadcast = buildAdminBroadcastWakePrompt("stop the rollout");
    assert.ok(broadcast.startsWith(`${ADMIN_BROADCAST_WAKE_CUE} A direct message from your user`));
    assert.match(broadcast, /The user says: stop the rollout/);
    assert.match(broadcast, /the user has already reached the others directly/);

    assert.equal(buildMentionedAgentsContext([]), null);
    assert.equal(
      buildMentionedAgentsContext([agent(1), agent(2, { isGroup: true })]),
      "[Agents mentioned in this message — you can reach any of them with SendToAgent using their id:\n- Agent 1 (id: agent-1)\n- Agent 2 (id: agent-2) (group)\n]"
    );
  });
});
