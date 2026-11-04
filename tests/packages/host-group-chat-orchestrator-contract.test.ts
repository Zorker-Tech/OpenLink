import assert from "node:assert/strict"
import { test } from "node:test"

import { GroupChatOrchestrator } from "../../source/host/transcript/group-chat-orchestrator.ts"
import {
  GROUP_MAX_MEMBER_TURNS,
  type GroupDescription,
  type GroupMember,
  type GroupMessage,
} from "../../source/host/groups/group-chat.ts"

const group: GroupDescription = { name: "Review", description: "Review the release." }
const a: GroupMember = { id: "a", name: "Analyst", description: "Finds facts." }
const b: GroupMember = { id: "b", name: "Writer", description: "Summarizes." }

test("a member sees messages since its prior turn, skips passes and sends at most two trimmed replies", async () => {
  const history: GroupMessage[] = [
    { speaker: { kind: "member", id: "a", name: "Analyst" }, content: "earlier" },
    { speaker: { kind: "user", name: "User" }, content: "new request" },
    { speaker: { kind: "member", id: "b", name: "Writer" }, content: "another reply" },
  ]
  let captured: { systemPrompt: string; prompt: string } | undefined
  const orchestrator = new GroupChatOrchestrator({
    async resolveMembers() { return [a, b] },
    readHistory: () => history,
    isCurrent: () => true,
    async runMemberTurn(args) {
      captured = { systemPrompt: args.systemPrompt, prompt: args.prompt }
      return [" (pass) ", "  first answer  ", " second answer ", "third answer"]
    },
    postMemberMessage() {},
  })

  assert.deepEqual(await orchestrator.runOneTurn(group, a, [a, b]), ["first answer", "second answer"])
  assert.match(captured?.systemPrompt ?? "", /Analyst/)
  assert.match(captured?.systemPrompt ?? "", /Writer/)
  assert.match(captured?.prompt ?? "", /new request/)
  assert.doesNotMatch(captured?.prompt ?? "", /earlier/)
})

test("a shared-room turn receives the bounded recent transcript, including history before this member spoke", async () => {
  const history: GroupMessage[] = Array.from({ length: 30 }, (_value, index) => ({
    speaker: { kind: "user", name: "Reviewer" },
    content: `room-${index}`,
  }))
  let capturedPrompt = ""
  const orchestrator = new GroupChatOrchestrator({
    async resolveMembers() { return [a, b] },
    readHistory: () => history,
    isCurrent: () => true,
    isSharedRoom: true,
    async runMemberTurn(args) { capturedPrompt = args.prompt; return [] },
    postMemberMessage() {},
  })

  await orchestrator.runOneTurn(group, a, [a, b])
  assert.match(capturedPrompt, /room-6/)
  assert.match(capturedPrompt, /room-29/)
  assert.doesNotMatch(capturedPrompt, /room-5/)
})

test("a room turn stops when it is no longer current and never exceeds the total message cap", async () => {
  let current = false
  let runs = 0
  const stopped = new GroupChatOrchestrator({
    async resolveMembers() { return [a, b] },
    readHistory: () => [],
    isCurrent: () => current,
    async runMemberTurn() { runs += 1; return ["not sent"] },
    postMemberMessage() {},
  })
  await stopped.run({ group, memberIds: [a.id, b.id] })
  assert.equal(runs, 0)

  current = true
  const messages: string[] = []
  const finalized: string[] = []
  const turns: string[] = []
  const active = new GroupChatOrchestrator({
    async resolveMembers() { return [a, b] },
    readHistory: () => [],
    isCurrent: () => true,
    async runMemberTurn(args) {
      turns.push(args.member.id)
      return [`${args.member.id} first`, `${args.member.id} second`, `${args.member.id} extra`]
    },
    postMemberMessage: (_member, content) => { messages.push(content) },
    finalizeMemberTurn: member => { finalized.push(member.id) },
  })
  await active.run({ group, memberIds: [a.id, b.id] })

  assert.equal(messages.length, GROUP_MAX_MEMBER_TURNS)
  assert.equal(finalized.length, 5)
  assert.deepEqual(turns, ["a", "b", "b", "a", "a"])
  assert.deepEqual(messages.slice(-2), ["a first", "a second"])
})
