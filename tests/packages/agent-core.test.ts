import { test } from "node:test"
import assert from "node:assert/strict"

import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { isRedactedString } from "../../source/packages/redaction/redacted-values.ts"
import {
  fromRedactedInteractionUpdate,
  toRedactedInteractionQuery,
  toRedactedInteractionUpdate,
} from "../../source/packages/redacted-protos/generated/agent/v1/agent_redacted.ts"
import { InteractionQuery, InteractionUpdate } from "../../source/packages/proto/generated/agent/v1/agent_pb.ts"
import { WebSearchRequestQuery } from "../../source/packages/proto/generated/agent/v1/web_search_tool_pb.ts"
import {
  appendAgentDenialNote,
  createHookDenialMessage,
  createHookFailClosedMessage,
  FailClosedError,
  HOOK_DENIAL_AGENT_NOTE,
  HOOK_SETTINGS_HINT,
  HookDeniedError,
  withFailClosed,
} from "../../source/packages/hooks-exec/hook-errors.ts"
import {
  GOAL_ID_PATTERN,
  GOAL_STATUS_ACTIVE,
  goalClockOnActivation,
  goalClockOnDeactivation,
  goalElapsedMs,
  goalElapsedMsFrom,
  goalWorkedMs,
  isGoalIdentityValid,
  isGoalOwnerValid,
  isGoalStateShapeValid,
  type GoalState,
} from "../../source/packages/agent-core/goal-continuation.ts"
import { buildGoalPursuitGuidelines } from "../../source/packages/agent-core/goal-guidelines.ts"
import {
  DeferredInteractionResponseError,
  queryMcpAuth,
  queryWebFetch,
  queryWebSearch,
  Responses,
} from "../../source/packages/agent-core/interaction-queries.ts"
import {
  InteractionListenerStreamClosedError,
  flushPostTurnEndedWork,
  NoopInteractionListener,
} from "../../source/packages/agent-core/interaction-listener.ts"
import {
  toRedactedInteractionListener,
  toUnredactedInteractionListener,
} from "../../source/packages/agent-core/redacted-interaction-listener.ts"

const GOAL_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"

test("a hook block and a hook failure are different errors with different messages", async () => {
  const denied = new HookDeniedError("team policy")
  assert.equal(denied.failureType, "permission_denied")
  assert.equal(denied.name, "HookDeniedError")
  assert.match(denied.message, /Hook denied: team policy/)

  const failed = new FailClosedError("reason", new Error("cause"))
  assert.equal(failed.failureType, "error")
  assert.match(failed.message, /fail-closed/)

  assert.equal(await withFailClosed(() => "ok", "Writing a file"), "ok")
  await assert.rejects(
    withFailClosed(() => { throw new Error("hook crashed") }, "Writing a file"),
    (error: unknown) => {
      assert.ok(error instanceof FailClosedError)
      assert.match((error as Error).message, /Writing a file was blocked because a configured hook failed to execute: hook crashed/)
      assert.match((error as Error).message, /fail-closed/)
      assert.match((error as Error).message, /Slate Settings > Hooks/)
      return true
    },
  )
  await assert.rejects(withFailClosed(() => { throw "a string" }, undefined), /Action was blocked/)
})

test("a denial message tells the agent not to look for a way around it", () => {
  const withReason = createHookDenialMessage("Running a command", "denied by policy")
  assert.match(withReason, /Running a command was blocked by a hook: denied by policy/)
  assert.match(withReason, /Do not suggest workarounds to the blocked tool/)
  assert.match(withReason, /Slate Settings > Hooks/)
  assert.equal(withReason.split(HOOK_DENIAL_AGENT_NOTE).length - 1, 1, "the note is appended once")

  const withoutReason = createHookDenialMessage("Running a command", null)
  assert.match(withoutReason, /was blocked by a hook\./)
  assert.equal(appendAgentDenialNote(withReason), withReason, "an already-noted message is left alone")

  assert.match(HOOK_SETTINGS_HINT, /Slate Settings/)
  const failed = createHookFailClosedMessage("Reading a file", undefined)
  assert.match(failed, /Reading a file was blocked because a configured hook failed to execute\./)
})

test("a goal's clock accrues while it is active and freezes when it stops", () => {
  const goal: GoalState = { goalId: GOAL_ID, activeDurationMs: BigInt(1_000), lastAccruedAtMs: BigInt(5_000), status: GOAL_STATUS_ACTIVE }
  assert.equal(goalWorkedMs(goal), 1_000)
  assert.equal(goalWorkedMs(undefined), 0)

  assert.equal(goalElapsedMsFrom(1_000, undefined, 9_000), 1_000, "nothing anchored means nothing accrues")
  assert.equal(goalElapsedMsFrom(1_000, 5_000, 9_000), 5_000)
  assert.equal(goalElapsedMsFrom(1_000, 5_000, 4_000), 1_000, "a clock that went backwards does not subtract")
  assert.equal(goalElapsedMs(goal, 9_000), 5_000)

  const activated = goalClockOnActivation(goal, 9_000)
  assert.equal(activated.activeDurationMs, BigInt(1_000))
  assert.equal(activated.lastAccruedAtMs, BigInt(9_000))
  const deactivated = goalClockOnDeactivation(goal, 9_000)
  assert.equal(deactivated.activeDurationMs, BigInt(5_000), "the elapsed time is frozen into the total")
  assert.equal(deactivated.lastAccruedAtMs, undefined)
})

test("a goal belongs to its conversation and, when it names one, to its agent session", () => {
  const identity = { conversationId: "conv-1", agentSessionId: "session-1" }
  assert.equal(isGoalOwnerValid({ goalId: GOAL_ID }, "session-9"), true, "a goal without an owner is anyone's")
  assert.equal(isGoalOwnerValid({ goalId: GOAL_ID, agentSessionId: "session-1" }, "session-1"), true)
  assert.equal(isGoalOwnerValid({ goalId: GOAL_ID, agentSessionId: "session-1" }, "session-2"), false)
  assert.equal(isGoalOwnerValid({ goalId: GOAL_ID, agentSessionId: "session-1" }, undefined), false)

  assert.equal(isGoalIdentityValid({ goalId: GOAL_ID, conversationId: "conv-1" }, identity), true)
  assert.equal(isGoalIdentityValid({ goalId: GOAL_ID, conversationId: "conv-2" }, identity), false)
  assert.equal(
    isGoalIdentityValid({ goalId: GOAL_ID, conversationId: "conv-2", agentSessionId: "session-1" }, identity),
    true,
    "a goal with an owner is judged by its owner, not by the conversation it was stored with",
  )

  assert.equal(isGoalStateShapeValid({ goalId: GOAL_ID, conversationId: "conv-1", status: GOAL_STATUS_ACTIVE }, identity), true)
  assert.equal(isGoalStateShapeValid({ goalId: GOAL_ID, conversationId: "conv-1", status: 2 }, identity), false)
  assert.equal(
    isGoalStateShapeValid({ goalId: GOAL_ID, conversationId: "conv-9", status: GOAL_STATUS_ACTIVE }, identity),
    false,
    "the goal has to belong to this conversation",
  )
  assert.equal(isGoalStateShapeValid({ goalId: "not-a-goal", conversationId: "conv-1", status: GOAL_STATUS_ACTIVE }, identity), false)
  assert.equal(isGoalStateShapeValid(undefined, identity), false)
  assert.equal(GOAL_ID_PATTERN.test(GOAL_ID), true)
})

test("a goal's clock reads a stored total, and an unanchored clock does not accrue", () => {
  assert.equal(GOAL_STATUS_ACTIVE, 1)
  assert.equal(goalWorkedMs(null), 0)
  assert.equal(goalWorkedMs({ goalId: GOAL_ID }), 0)
  assert.equal(goalWorkedMs({ goalId: GOAL_ID, activeDurationMs: BigInt(-5) }), -5)
  assert.equal(
    goalWorkedMs({ goalId: GOAL_ID, activeDurationMs: BigInt("18446744073709551617") }),
    18_446_744_073_709_551_616,
    "a total too large for a safe integer is the number it rounds to",
  )

  assert.equal(goalElapsedMsFrom(1_000, 5_000, 9_000), 5_000)
  assert.equal(goalElapsedMsFrom(1_000, 5_000, 4_000), 1_000)
  assert.equal(goalElapsedMsFrom(1_000, undefined, 9_000), 1_000)
  assert.equal(goalElapsedMsFrom(1_000, 0, 1_500), 2_500, "a fractional stretch is kept as a fraction")
  assert.equal(goalElapsedMsFrom(1_000, null as never, 9_000), 10_000, "only undefined is an absent anchor, so a null one counts as zero")
  assert.equal(Number.isNaN(goalElapsedMsFrom(1_000, Number.NaN, 9_000)), true)

  assert.equal(goalElapsedMs({ goalId: GOAL_ID, activeDurationMs: BigInt(1_000) }, 9_000), 1_000, "no anchor, no growth")
  assert.equal(goalElapsedMs({ goalId: GOAL_ID, activeDurationMs: BigInt(1_000), lastAccruedAtMs: null as never }, 9_000), 10_000, "only undefined is an absent anchor, so a null one counts as zero")
})

test("a goal's clock on activation anchors it, and on deactivation freezes what elapsed", () => {
  const started = goalClockOnActivation({ goalId: GOAL_ID, activeDurationMs: BigInt(1_000) }, 9_000)
  assert.deepEqual(started, { activeDurationMs: BigInt(1_000), lastAccruedAtMs: BigInt(9_000) })
  assert.deepEqual(goalClockOnActivation(undefined, 0), { activeDurationMs: BigInt(0), lastAccruedAtMs: BigInt(0) })
  assert.throws(() => goalClockOnActivation(undefined, 1.5), RangeError, "a fractional moment cannot be a bigint")

  const stopped = goalClockOnDeactivation({ goalId: GOAL_ID, activeDurationMs: BigInt(1_000), lastAccruedAtMs: BigInt(5_000) }, 9_000)
  assert.deepEqual(stopped, { activeDurationMs: BigInt(5_000), lastAccruedAtMs: undefined })
  assert.deepEqual(goalClockOnDeactivation(undefined, 9_000), { activeDurationMs: BigInt(0), lastAccruedAtMs: undefined })
  assert.throws(() => goalClockOnDeactivation({ goalId: GOAL_ID, activeDurationMs: BigInt(0), lastAccruedAtMs: BigInt(0) }, 1.5), RangeError)
})

test("a goal's owner is the session that made it, and an empty owner is nobody's", () => {
  assert.equal(isGoalOwnerValid({ goalId: GOAL_ID, agentSessionId: "" }, "session-1"), false, "an empty owner matches no session")
  assert.equal(isGoalOwnerValid({ goalId: GOAL_ID, agentSessionId: "" }, ""), false)
  assert.equal(isGoalOwnerValid({ goalId: GOAL_ID, agentSessionId: "session-1" }, ""), false, "an empty session is no session")
  assert.equal(isGoalOwnerValid({ goalId: GOAL_ID, agentSessionId: "session-1" }, "session-1"), true)
  assert.equal(isGoalOwnerValid({ goalId: GOAL_ID, agentSessionId: "session-1" }, undefined), false)
  assert.equal(isGoalOwnerValid({ goalId: GOAL_ID }, undefined), true, "a goal without an owner needs no session")
})

test("a goal's identity is its conversation when it has no owner, and its owner when it has one", () => {
  const identity = { conversationId: "conv-1", agentSessionId: "session-1" }
  assert.equal(isGoalIdentityValid({ goalId: GOAL_ID, conversationId: "conv-1", agentSessionId: "" }, identity), false, "an empty owner is not a conversation match")
  assert.equal(isGoalIdentityValid({ goalId: GOAL_ID, conversationId: "conv-9", agentSessionId: "session-1" }, identity), true)
  assert.equal(isGoalIdentityValid({ goalId: GOAL_ID, conversationId: "conv-9", agentSessionId: "session-2" }, identity), false)
  assert.equal(isGoalIdentityValid({ goalId: GOAL_ID }, { conversationId: "conv-1" }), false, "a goal without a conversation matches none")
})

test("the goal id pattern is the stored uuid shape, in either case, and only then", () => {
  assert.equal(GOAL_ID_PATTERN.test(GOAL_ID.toUpperCase()), true)
  assert.equal(GOAL_ID_PATTERN.test("3f2504e0-4f89-41d3-9a0c-0305e82c330"), false, "the last group is twelve hex digits")
  assert.equal(GOAL_ID_PATTERN.test("3f2504e04f8941d39a0c0305e82c3301"), false, "the dashes are part of the shape")
  assert.equal(GOAL_ID_PATTERN.test("3f2504e0-4f89-41d3-9a0c-0305e82c330g"), false)
  assert.equal(GOAL_ID_PATTERN.test(`${GOAL_ID}\n`), false, "the end anchor is the very end of the string")
  assert.equal(GOAL_ID_PATTERN.test(` ${GOAL_ID}`), false, "the start anchor does not skip a leading space")
})

test("the pursuit guidelines name the tools that exist and always carry the audit", () => {
  const bare = buildGoalPursuitGuidelines()
  assert.match(bare, /This goal persists across turns/)
  assert.match(bare, /keep a concise plan tied to the real objective/)
  assert.match(bare, /Do not mark a goal complete merely because you are stopping work/)
  assert.match(bare, /Completion audit:/)
  assert.doesNotMatch(bare, /todo_write|update_goal/)

  const named = buildGoalPursuitGuidelines({ todoWriteToolName: "todo_write", updateGoalToolName: "update_goal" })
  assert.match(named, /If todo_write is available/)
  assert.match(named, /call update_goal with status "complete"/)
  assert.match(named, /Do not call update_goal unless the goal is complete/)
  assert.match(named, /do not redefine success around a smaller or easier task/)
})

test("the response builders produce the answer each question expects", () => {
  const search = Responses.webSearchRejected(7, "not allowed")
  assert.equal(search.id, 7)
  assert.equal(search.result.case, "webSearchRequestResponse")
  const searchValue = search.result.value as { result: { case?: string; value?: { reason?: string } } }
  assert.equal(searchValue.result.case, "rejected")
  assert.equal(searchValue.result.value?.reason, "not allowed")

  const auth = Responses.mcpAuthRejected(3)
  const authValue = auth.result.value as { result: { value?: { reason?: string } } }
  assert.equal(authValue.result.value?.reason, "Authentication was rejected", "a rejection without a reason says so")

  const connect = Responses.connectScmFailed(4)
  const connectValue = connect.result.value as { result: { case?: string; value?: { error?: string } } }
  assert.equal(connectValue.result.case, "failed")
  assert.match(connectValue.result.value?.error ?? "", /Failed to connect GitHub/)

  const image = Responses.generateImageApproved(5, "a cat")
  const imageValue = image.result.value as { result: { value?: { description?: string } } }
  assert.equal(imageValue.result.value?.description, "a cat")
})

test("the query helpers unwrap the answer and refuse a mismatched one", async () => {
  const answering = { query: async (_context: unknown, query: InteractionQuery) => Responses.webSearchApproved(query.id) }
  const approved = await queryWebSearch(answering, {}, { searchTerm: "x" })
  assert.equal(approved.result.case, "approved")

  const wrong = { query: async (_context: unknown, query: InteractionQuery) => Responses.webFetchApproved(query.id) }
  await assert.rejects(queryWebSearch(wrong, {}, { searchTerm: "x" }), /Unexpected response for web search query/)

  const fetching = { query: async (_context: unknown, query: InteractionQuery) => Responses.webFetchRejected(query.id, "no") }
  const rejected = await queryWebFetch(fetching, {}, { url: "https://example.com" }, true)
  const rejectedValue = rejected.result.value as { reason?: string }
  assert.equal(rejectedValue.reason, "no")

  const auth = { query: async (_context: unknown, query: InteractionQuery) => Responses.mcpAuthApproved(query.id) }
  assert.equal((await queryMcpAuth(auth, {}, {})).result.case, "approved")

  const deferred = new DeferredInteractionResponseError(new InteractionQuery({
    id: 1,
    query: { case: "webSearchRequestQuery", value: new WebSearchRequestQuery({ args: { searchTerm: "x" } }) },
  }))
  assert.match(deferred.message, /Deferred interaction response requested for query 1 \(webSearchRequestQuery\)/)
})

test("the no-op listener answers every question a headless run can ask", async () => {
  const listener = new NoopInteractionListener()
  const ask = async (query: InteractionQuery) => await listener.query({}, query)

  const search = await ask(new InteractionQuery({ id: 1, query: { case: "webSearchRequestQuery", value: new WebSearchRequestQuery({ args: { searchTerm: "x" } }) } }))
  assert.equal((search.result.value as { result: { case?: string } }).result.case, "approved")

  const question = await ask(new InteractionQuery({ id: 2, query: { case: "askQuestionInteractionQuery", value: {} as never } }))
  const questionValue = question.result.value as { result: { result: { case?: string; value?: { reason?: string } } } }
  assert.equal(questionValue.result.result.case, "rejected")
  assert.match(questionValue.result.result.value?.reason ?? "", /Questions skipped by user/)

  const mode = await ask(new InteractionQuery({ id: 3, query: { case: "switchModeRequestQuery", value: {} as never } }))
  assert.equal((mode.result.value as { result: { case?: string } }).result.case, "rejected")

  const plan = await ask(new InteractionQuery({ id: 4, query: { case: "createPlanRequestQuery", value: {} as never } }))
  assert.equal((plan.result.value as { result: { result: { case?: string } } }).result.result.case, "success")

  const pr = await ask(new InteractionQuery({ id: 5, query: { case: "prManagementRequestQuery", value: {} as never } }))
  const prValue = pr.result.value as { result: { case?: string; value?: { error?: string } } }
  assert.equal(prValue.result.case, "error")
  assert.match(prValue.result.value?.error ?? "", /only available in cloud agents/)

  const mcp = await ask(new InteractionQuery({ id: 6, query: { case: "mcpAuthRequestQuery", value: {} as never } }))
  assert.match(((mcp.result.value as { result: { value?: { reason?: string } } }).result.value?.reason) ?? "", /not supported/)

  const image = await ask(new InteractionQuery({
    id: 7,
    query: { case: "generateImageRequestQuery", value: { args: { description: "a cat" } } as never },
  }))
  assert.equal(((image.result.value as { result: { value?: { description?: string } } }).result.value?.description), "a cat")

  await assert.rejects(ask(new InteractionQuery({ id: 8, query: { case: "unknownQuery" as never, value: {} as never } })), /Unhandled interaction query type/)
})

test("post-turn work is queued, flushed, and a failing task does not stop the others", async () => {
  const listener = new NoopInteractionListener()
  const done: string[] = []
  listener.enqueuePostTurnEndedWork(async () => { done.push("first") })
  listener.enqueuePostTurnEndedWork(async () => { throw new Error("this one fails") })
  listener.enqueuePostTurnEndedWork(async () => { done.push("third") })

  await flushPostTurnEndedWork({}, listener)
  assert.deepEqual(done, ["first", "third"])
  await flushPostTurnEndedWork({}, listener)
  assert.deepEqual(done, ["first", "third"], "the queue is drained, not replayed")

  assert.equal(new InteractionListenerStreamClosedError("closed", { cause: "why" }).cause, "why")
})

test("the listener adapters convert across the privacy boundary in both directions", async () => {
  const mode = PrivacyMode.NO_STORAGE
  const seen: unknown[] = []
  const plainDelegate = {
    sendUpdate: (_ctx: unknown, update: InteractionUpdate) => { seen.push(update) },
    query: async (_ctx: unknown, query: InteractionQuery) => Responses.webSearchApproved(query.id),
  }

  const redacting = toRedactedInteractionListener(plainDelegate, mode)
  const update = new InteractionUpdate({
    message: { case: "textDelta", value: { text: "the secret" } as never },
  })
  await redacting.sendUpdate({}, toRedactedInteractionUpdate(update, mode))
  assert.equal(seen.length, 1, "the plain delegate receives a plain update")
  assert.equal((seen[0] as InteractionUpdate).message.case, "textDelta")

  const redactedQuery = toRedactedInteractionQuery(
    new InteractionQuery({
      id: 1,
      query: { case: "webSearchRequestQuery", value: new WebSearchRequestQuery({ args: { searchTerm: "x" } }) },
    }),
    mode,
  )
  const redactedResponse = await redacting.query({}, redactedQuery)
  assert.equal(typeof redactedResponse, "object")

  const reading = toUnredactedInteractionListener({
    sendUpdate: (_ctx: unknown, redacted: unknown) => { seen.push(redacted) },
    query: async (_ctx: unknown, _query: unknown) => redactedResponse,
  }, mode)
  await reading.sendUpdate({}, update)
  assert.equal(seen.length, 2)
  assert.equal(
    isRedactedString((seen[1] as { message: { value: { text: unknown } } }).message.value.text),
    true,
    "the redacted delegate receives a redacted update",
  )
  const roundTripped = fromRedactedInteractionUpdate(
    toRedactedInteractionUpdate(update, mode) as never,
    "unsafe_always_allowed",
    undefined,
  ) as unknown as InteractionUpdate
  assert.equal(
    (roundTripped.message.value as { text?: string }).text,
    "the secret",
    "a redacted update reads back as the update it came from",
  )
})
