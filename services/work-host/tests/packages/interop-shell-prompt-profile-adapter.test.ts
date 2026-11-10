import { test } from "node:test"
import assert from "node:assert/strict"

import { shellPromptProfileFromInterop } from "../../source/adapters/interop/agent/shell-prompt-profile-adapter.ts"
import { SlateShellPromptProfile } from "../../source/packages/agent/tools/core/shell/shell-tool-description.ts"

test("external prompt versions resolve to Slate-owned shell profiles", () => {
  assert.equal(shellPromptProfileFromInterop("dsv3-1018"), SlateShellPromptProfile.INITIAL)
  assert.equal(shellPromptProfileFromInterop("dsv3-1205"), SlateShellPromptProfile.SESSION)
  assert.equal(shellPromptProfileFromInterop("cursor-0226"), SlateShellPromptProfile.STREAMING)
  assert.equal(shellPromptProfileFromInterop("future-version"), SlateShellPromptProfile.INITIAL)
  assert.equal(shellPromptProfileFromInterop(undefined), SlateShellPromptProfile.SESSION)
})
