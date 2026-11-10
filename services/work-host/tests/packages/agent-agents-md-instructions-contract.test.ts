import assert from "node:assert/strict";
import { test } from "node:test";

import { renderContent } from "../../source/packages/prompt-jsx/index.ts";
import { AgentsMdInstructions } from "../../source/packages/agent/prompts/testing/agents-md-instructions.ts";

test("the prompt explains repository guidance, instruction priority, and applicable skill files", () => {
  const prompt = renderContent(AgentsMdInstructions());
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /first user message/);
  assert.match(prompt, /System instructions take precedence/);
  assert.match(prompt, /Direct system, developer, or user instructions/);
  assert.match(prompt, /Skills/);
  assert.match(prompt, /relevant skill file/);
  assert.match(prompt, /MUST read/);
});
