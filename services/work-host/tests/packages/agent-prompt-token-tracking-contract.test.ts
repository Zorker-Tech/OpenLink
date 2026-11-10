import assert from "node:assert/strict";
import { test } from "node:test";

import { createContext } from "../../source/packages/context/context.ts";
import type {
  PromptTokenRequestDetails,
  TrackPromptTokenUsage,
  TrackPromptTokenUsageInput,
} from "../../source/packages/agent/utils/token-tracking-contract.ts";

test("the tracking contract carries prompt facts through Slate-owned projections", () => {
  const requestContext: PromptTokenRequestDetails = {
    applicableRules: [{ name: "workspace-rule" }],
    availableSkills: [{ name: "release" }],
    workspaceContext: { workspacePaths: ["/workspace"] },
    toolDiscoverySettings: { enabled: true },
  };
  const input: TrackPromptTokenUsageInput = {
    ctx: createContext(),
    availableTools: [{ name: "search" }],
    requestDetails: requestContext,
    promptMessages: [],
    attachedContext: { files: [] },
    userInfoDisplayOptions: { displaySkills: true },
    tokenBudget: 32_000,
    fileReadToolName: "Read",
    invocationId: "invocation-1",
    modelCapabilities: { supportsPromptBudget: true },
    behaviorFlags: { protectLoopSkillDescription: true },
    conversationState: {},
  };
  const observed: TrackPromptTokenUsageInput[] = [];
  const track: TrackPromptTokenUsage = (value) => { observed.push(value); };
  track(input);

  assert.deepEqual(observed, [input]);
  assert.equal(observed[0]?.requestDetails, requestContext);
});
