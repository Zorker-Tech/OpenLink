import assert from "node:assert/strict"
import test from "node:test"

import { RecentAgent } from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import { toRecentAgentPromptInputs } from "../../source/adapters/interop/agent/recent-agents-adapter.ts"

test("recent-agent messages are projected in order into prompt-owned records", () => {
  assert.deepEqual(toRecentAgentPromptInputs([
    new RecentAgent({ name: "Build fix", path: "/transcripts/one", overview: "summary" }),
    new RecentAgent({ name: "Review", path: "/transcripts/two" }),
  ]), [
    { name: "Build fix", path: "/transcripts/one", overview: "summary" },
    { name: "Review", path: "/transcripts/two" },
  ])
})
