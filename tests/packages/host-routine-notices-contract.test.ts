import assert from "node:assert/strict"
import test from "node:test"
import type { NoticeAutomation } from "../../source/host/automations/routine-notices.ts"
import {
  GITHUB_LISTENER_SCOPE,
  GITHUB_LISTENER_SCOPE_CREATED_BEFORE_MS,
  isRoutineNoticeId,
  routineNoticeWakeLines,
  routineNoticesToRaise,
} from "../../source/host/automations/routine-notices.ts"

function automation(overrides: Partial<NoticeAutomation> = {}): NoticeAutomation {
  return {
    createdAt: GITHUB_LISTENER_SCOPE_CREATED_BEFORE_MS - 1,
    trigger: { type: "github", repo: "acme/app", events: ["issue-opened"] },
    raisedNotices: [],
    ...overrides,
  }
}

test("only old repository listeners without an account filter receive the notice", () => {
  assert.equal(routineNoticesToRaise(automation()).length, 1)
  assert.equal(routineNoticesToRaise(automation({ createdAt: GITHUB_LISTENER_SCOPE_CREATED_BEFORE_MS })).length, 0)
  assert.equal(routineNoticesToRaise(automation({
    trigger: { type: "github", repo: "acme/app", events: ["issue-opened"], userAllowlist: ["ada"] },
  })).length, 0)
  assert.equal(routineNoticesToRaise(automation({
    trigger: { type: "github", repo: "acme/app", events: ["issue-opened"], userAllowlist: [] },
  })).length, 1)
  assert.equal(routineNoticesToRaise(automation({ trigger: { type: "cron", schedule: "0 9 * * *" } })).length, 0)
})

test("an already raised notice is not repeated, and only known ids are accepted", () => {
  assert.deepEqual(routineNoticesToRaise(automation({ raisedNotices: [GITHUB_LISTENER_SCOPE] })), [])
  assert.equal(isRoutineNoticeId(GITHUB_LISTENER_SCOPE), true)
  assert.equal(isRoutineNoticeId("another-notice"), false)
})

test("wake lines explain the broad listener and keep uncertain scope changes with the user", () => {
  const lines = routineNoticeWakeLines(automation())

  assert.equal(lines.length, 2)
  assert.match(lines[0]!, /anyone|everyone/)
  assert.match(lines[0]!, /saved prompt/)
  assert.match(lines[1]!, /CI/)
  assert.match(lines[1]!, /uncertain/)
  assert.match(lines[1]!, /Tell the user/)
})

test("each wake gets its own lines array", () => {
  const current = automation()
  const first = routineNoticeWakeLines(current)
  first[0] = "changed by caller"

  assert.notEqual(routineNoticeWakeLines(current)[0], "changed by caller")
})
