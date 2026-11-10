import assert from "node:assert/strict"
import { test } from "node:test"

import {
  DISK_SAVER_TASK,
  SLATE_DISK_SAVER_KICKSTART_PROMPT,
  SLATE_DISK_SAVER_REAUDIT_PROMPT,
} from "../../source/shared/agents/disk-saver.ts"

test("the shared disk-saver task is a read-only audit until the user approves cleanup", () => {
  assert.match(DISK_SAVER_TASK, /read-only inspection/)
  assert.match(DISK_SAVER_TASK, /largest items and the safest cleanup candidates/)
  assert.match(DISK_SAVER_TASK, /how much each would recover and why it is safe to remove/)
  assert.match(DISK_SAVER_TASK, /Preserve \/home\/box\/slate-data, the user's work, credentials, logins, and Git state/)
  assert.match(DISK_SAVER_TASK, /Delete or modify nothing until the user confirms a plan/)
})

test("kickstart sends the first audit while re-audit always sends fresh findings", () => {
  assert.match(SLATE_DISK_SAVER_KICKSTART_PROMPT, /Skip greetings and getting-started questions/)
  assert.match(SLATE_DISK_SAVER_KICKSTART_PROMPT, /Nothing reaches the user unless it's inside a SendMessage/)
  assert.match(SLATE_DISK_SAVER_KICKSTART_PROMPT, /Don't mention this cue/)
  assert.match(SLATE_DISK_SAVER_REAUDIT_PROMPT, /Deliver the fresh findings with SendMessage even if they match your last audit/)
  assert.match(SLATE_DISK_SAVER_REAUDIT_PROMPT, /Don't mention this cue/)
})
