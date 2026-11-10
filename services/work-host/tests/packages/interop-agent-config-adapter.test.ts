import assert from "node:assert/strict"
import { test } from "node:test"

import { BackgroundComposerSource } from "../../source/adapters/interop/proto/generated/aiserver/v1/background_composer_pb.ts"
import { projectBackgroundAgentSource } from "../../source/adapters/interop/agent/background-agent-source-adapter.ts"

test("external background-source values become Slate semantic categories", () => {
  assert.equal(projectBackgroundAgentSource(undefined), undefined)
  assert.equal(projectBackgroundAgentSource(BackgroundComposerSource.CLOUD_META_AGENT), "named-agent")
  assert.equal(projectBackgroundAgentSource(BackgroundComposerSource.GITHUB_CI_AUTOFIX), "automated-fix")
  assert.equal(projectBackgroundAgentSource(BackgroundComposerSource.BUGBOT_AUTOFIX), "automated-fix")
  assert.equal(projectBackgroundAgentSource(BackgroundComposerSource.UNSPECIFIED), "other")
  assert.equal(projectBackgroundAgentSource(999), "other")
  assert.equal(projectBackgroundAgentSource("CLOUD_META_AGENT"), "other")
})
