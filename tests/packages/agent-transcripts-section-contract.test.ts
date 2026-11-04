import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderContent } from "../../source/packages/prompt-jsx/index.ts";
import { AgentType } from "../../source/packages/agent/utils/agent-config.ts";
import { AgentTranscriptsSection } from "../../source/packages/agent/prompts/agent-transcripts-section.ts";

const folder = "/workspace/.slate/transcripts";

function render(agentType?: AgentType, enableAgentChatLinks?: boolean): string {
  return renderContent(AgentTranscriptsSection({ agentTranscriptsFolder: folder, agentType, enableAgentChatLinks }));
}

describe("agent transcript prompt contract", () => {
  it("names the transcript folder and stored file suffix", () => {
    const prompt = render();
    assert.match(prompt, /Earlier agent conversations.*kept under/);
    assert.match(prompt, /\.jsonl files/);
  });

  it("provides a bounded parent-chat link format in the editor", () => {
    const prompt = render(AgentType.IDE, true);
    assert.match(prompt, /link a parent conversation/);
    assert.match(prompt, /at most six words/);
    assert.match(prompt, /UUID without the \.jsonl suffix/);
    assert.doesNotMatch(prompt, /do not point to subagent transcript files/i);
    assert.match(prompt, /Do not explain the directory layout/);
  });

  it("limits user-facing citations when links are disabled or unavailable", () => {
    assert.match(render(AgentType.IDE, false), /do not point .* to subagent transcript files/i);
    assert.match(render(AgentType.CLI, true), /do not cite the path directly to the user/i);
  });
});
