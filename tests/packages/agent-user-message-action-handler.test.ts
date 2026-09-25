import { test } from "node:test"
import assert from "node:assert/strict"

import { AbstractUserMessageActionHandler } from "../../source/packages/agent/actions/user-message-action/abstract-user-message-action-handler.ts"
import { createContext } from "../../source/packages/context/context.ts"
import { DataClassification } from "../../source/packages/redaction/classification.ts"
import { createRedactedString } from "../../source/packages/redaction/create.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { ResponseComparisonSkipReason } from "../../source/packages/proto/generated/agent/v1/agent_pb.ts"

// ---------------------------------------------------------------------------------------------
// The handler is the turn engine: it is handed the action's configuration and the things a turn
// talks to, and everything it does is visible through them. The fakes below are the smallest
// versions of each that a turn needs.
// ---------------------------------------------------------------------------------------------

type Handler = AbstractUserMessageActionHandler
type Config = ConstructorParameters<typeof AbstractUserMessageActionHandler>[0]
type Listener = ConstructorParameters<typeof AbstractUserMessageActionHandler>[2]
type Capability = Parameters<Handler["maybeWarmAgentResponseComparison"]>[1]
type Attempt = Parameters<Capability["execute"]>[0] extends never ? never : ReturnType<NonNullable<Capability["preselect"]>>

interface SentUpdate {
  readonly message: {
    readonly case?: string
    readonly value?: {
      readonly comparisonId?: string
      readonly event?: { readonly case?: string; readonly value?: { readonly reason?: number } }
    }
  }
}

const TRIGGER_OPEN = "<automation_trigger_info>"
const TRIGGER_CLOSE = "</automation_trigger_info>"

function attempt() {
  return {
    selection: { displayOrder: "parent-first", comparisonConfigId: "cfg", alternate: { modelId: "m2" } },
    maxResponseChars: 10_000,
    isParentLengthEligible: () => true,
    hasSufficientCharacterDiff: () => true,
    commitCooldown: async () => true,
  }
}

function assistantMessage(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] }
}

function createHarness(options: { readonly config?: Record<string, unknown>; readonly withPostTurnWork?: boolean } = {}) {
  const updates: SentUpdate[] = []
  const postTurnWork: Array<() => Promise<void>> = []
  const listener = {
    sendUpdate: async (_ctx: unknown, update: unknown) => {
      updates.push(update as SentUpdate)
    },
    ...(options.withPostTurnWork === false
      ? {}
      : { enqueuePostTurnEndedWork: (work: () => Promise<void>) => { postTurnWork.push(work) } }),
  } as unknown as Listener
  const config = { backgroundSummarizationProps: {}, ...options.config } as unknown as Config
  const handler = new AbstractUserMessageActionHandler(
    config,
    { get: () => undefined } as unknown as ConstructorParameters<typeof AbstractUserMessageActionHandler>[1],
    listener,
    undefined,
    {} as unknown as ConstructorParameters<typeof AbstractUserMessageActionHandler>[4],
    {} as unknown as ConstructorParameters<typeof AbstractUserMessageActionHandler>[5],
  )
  return { handler, updates, postTurnWork }
}

function createCapability(overrides: Record<string, unknown> = {}) {
  let warmed = 0
  const capability = {
    supportsPendingUi: true,
    warm: async () => {
      warmed += 1
    },
    preselect: async () => attempt(),
    resolve: async () => attempt(),
    execute: () => ({
      fullStream: (async function* () {
        yield { type: "text-delta", textDelta: "an alternate answer" }
      })(),
      response: Promise.resolve({ messages: [assistantMessage("an alternate answer")] }),
      usage: Promise.resolve(undefined),
      extendedUsage: Promise.resolve(undefined),
      providerMetadata: Promise.resolve(undefined),
      invocationId: Promise.resolve("alternate-invocation"),
    }),
    ...overrides,
  } as unknown as Capability
  return { capability, warmCalls: () => warmed }
}

const TRAINING_ALLOWED = PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED

// ---------------------------------------------------------------------------------------------
// What the action carries
// ---------------------------------------------------------------------------------------------

test("the write barrier's timeout comes from the resolver before the flag", () => {
  const fromResolver = createHarness({
    config: { resolveWriteBarrierTimeoutMs: () => 1_500, featureFlags: { writeBarrierTimeoutMs: 3_000 } },
  })
  assert.equal(fromResolver.handler.resolveWriteBarrierTimeoutMs(), 1_500)

  // A resolver that has nothing to say leaves the flag in charge, and an action told neither has no barrier.
  const fromFlag = createHarness({ config: { featureFlags: { writeBarrierTimeoutMs: 3_000 } } })
  assert.equal(fromFlag.handler.resolveWriteBarrierTimeoutMs(), 3_000)
  assert.equal(createHarness().handler.resolveWriteBarrierTimeoutMs(), undefined)
})

test("automation context is read once, and only when the action carries automation instructions", () => {
  assert.equal(createHarness().handler.getAutomationTriggerContext([]), undefined)

  const { handler } = createHarness({ config: { automationInstructions: { automationId: "auto-1" } } })
  const trigger = `${TRIGGER_OPEN}automation auto-1${TRIGGER_CLOSE}`
  const messages = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: createRedactedString(trigger, DataClassification.UNSPECIFIED, "text", PrivacyMode.UNSPECIFIED),
        },
      ],
    },
  ]
  assert.equal(handler.getAutomationTriggerContext(messages as never), trigger)
  // The context belongs to the action rather than to the messages, so a later read does not look again.
  assert.equal(handler.getAutomationTriggerContext([{ role: "user", content: [] }] as never), trigger)
})

test("a message with no automation trigger in it carries no context", () => {
  const { handler } = createHarness({ config: { automationInstructions: { automationId: "auto-1" } } })
  const messages = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: createRedactedString("just a question", DataClassification.UNSPECIFIED, "text", PrivacyMode.UNSPECIFIED),
        },
      ],
    },
  ]
  assert.equal(handler.getAutomationTriggerContext(messages as never), undefined)
})

// ---------------------------------------------------------------------------------------------
// Permissions the agent runs under
// ---------------------------------------------------------------------------------------------

test("auto-run instructions are only read for smart mode, and an administrator's layer wins", async () => {
  const ctx = createContext()
  assert.equal(await createHarness().handler.getUserPermissionsFileAutoRunInstructions(ctx, {} as never), undefined)

  const { handler } = createHarness({ config: { smartModeClassifierMode: "on" } })
  // With an administrator's instructions present the user's own file is not consulted at all.
  const admin = { adminPermissionsAutoRun: { allowInstructions: ["run the tests"], blockInstructions: [] } }
  assert.equal(await handler.getUserPermissionsFileAutoRunInstructions(ctx, admin as never), undefined)

  const own = { userPermissionsAutoRun: { allowInstructions: ["read the docs"], blockInstructions: [] } }
  assert.deepEqual(await handler.getUserPermissionsFileAutoRunInstructions(ctx, own as never), {
    allowInstructions: ["read the docs"],
    blockInstructions: [],
  })
})

test("project auto-run instructions come from the request as they are", () => {
  const { handler } = createHarness()
  assert.deepEqual(
    handler.getProjectPermissionsFileAutoRunInstructions({
      projectPermissionsAutoRun: { allowInstructions: ["a"], blockInstructions: ["b"] },
    } as never),
    { allowInstructions: ["a"], blockInstructions: ["b"] },
  )
  // An administrator's layer is what the project runs under, and entries that say nothing are dropped.
  assert.deepEqual(
    handler.getProjectPermissionsFileAutoRunInstructions({
      adminPermissionsAutoRun: { allowInstructions: ["a", ""], blockInstructions: [] },
    } as never),
    { allowInstructions: ["a"], blockInstructions: [] },
  )
  assert.equal(handler.getProjectPermissionsFileAutoRunInstructions({} as never), undefined)
})

// ---------------------------------------------------------------------------------------------
// The comparison between what the model said and what another model would have said
// ---------------------------------------------------------------------------------------------

test("a comparison is announced when the caller can show one, and skipped when it cannot", async () => {
  const { capability } = createCapability()
  const announced = createHarness({ config: { agentResponseComparison: capability } })
  await announced.handler.preparePendingAgentResponseComparison({
    ctx: createContext(),
    parentInvocationId: "parent",
    messages: [],
    tools: [],
    privacyMode: TRAINING_ALLOWED,
  })
  assert.equal(announced.updates.length, 1)
  assert.equal(announced.updates[0]!.message.case, "responseComparison")
  assert.equal(announced.updates[0]!.message.value?.event?.case, "started")
  assert.equal(typeof announced.updates[0]!.message.value?.comparisonId, "string")

  // A caller that cannot show a pending comparison is not told about one.
  const { capability: withoutUi } = createCapability({ supportsPendingUi: false })
  const quiet = createHarness({ config: { agentResponseComparison: withoutUi } })
  await quiet.handler.preparePendingAgentResponseComparison({
    ctx: createContext(),
    parentInvocationId: "parent",
    messages: [],
    tools: [],
    privacyMode: TRAINING_ALLOWED,
  })
  assert.equal(quiet.updates.length, 0)

  // Neither is one whose privacy mode does not allow the comparison.
  const forbidden = createHarness({ config: { agentResponseComparison: capability } })
  await forbidden.handler.preparePendingAgentResponseComparison({
    ctx: createContext(),
    parentInvocationId: "parent",
    messages: [],
    tools: [],
    privacyMode: PrivacyMode.UNSPECIFIED,
  })
  assert.equal(forbidden.updates.length, 0)
})

test("a comparison is warmed at most five times in a turn", async () => {
  const { capability, warmCalls } = createCapability()
  const { handler } = createHarness({ config: { agentResponseComparison: capability } })
  const ctx = createContext()

  // Nothing is warmed while no comparison is waiting to be run.
  handler.maybeWarmAgentResponseComparison(ctx, capability, [], [])
  assert.equal(warmCalls(), 0)

  await handler.preparePendingAgentResponseComparison({
    ctx,
    parentInvocationId: "parent",
    messages: [],
    tools: [],
    privacyMode: TRAINING_ALLOWED,
  })
  for (let index = 0; index < 7; index += 1) {
    handler.maybeWarmAgentResponseComparison(ctx, capability, [], [])
  }
  assert.equal(warmCalls(), 5)
})

test("a comparison the turn will not run is dropped with a skip", async () => {
  const { capability } = createCapability()
  const { handler, updates } = createHarness({ config: { agentResponseComparison: capability } })
  await handler.preparePendingAgentResponseComparison({
    ctx: createContext(),
    parentInvocationId: "parent",
    messages: [],
    tools: [],
    privacyMode: TRAINING_ALLOWED,
  })
  await handler.finalizePendingAgentResponseComparison(false)

  assert.equal(updates.at(-1)!.message.value?.event?.case, "skipped")
  assert.equal(updates.at(-1)!.message.value?.event?.value?.reason, ResponseComparisonSkipReason.CANCELLED)
  // A comparison that is gone is not announced twice.
  await handler.finalizePendingAgentResponseComparison(false)
  assert.equal(updates.length, 2)
})

test("a finished turn hands its comparison to the work that runs after it", async () => {
  const { capability } = createCapability({ supportsPendingUi: false })
  const { handler, postTurnWork, updates } = createHarness({ config: { agentResponseComparison: capability } })

  await handler.enqueueAgentResponseComparisonIfEligible({
    ctx: createContext(),
    parentInvocationId: "parent",
    responseMessages: [assistantMessage("the answer the user saw")],
    messages: [],
    tools: [],
    privacyMode: TRAINING_ALLOWED,
  })
  assert.equal(postTurnWork.length, 1)

  await postTurnWork[0]!()
  assert.deepEqual(
    updates.map(update => update.message.value?.event?.case),
    ["started", "textDelta", "completed"],
  )
})

test("a turn whose response calls a tool is not compared", async () => {
  const { capability } = createCapability({ supportsPendingUi: false })
  const { handler, postTurnWork } = createHarness({ config: { agentResponseComparison: capability } })

  await handler.enqueueAgentResponseComparisonIfEligible({
    ctx: createContext(),
    parentInvocationId: "parent",
    responseMessages: [
      { role: "assistant", content: [{ type: "text", text: "let me look" }, { type: "tool-call", toolName: "Shell" }] },
    ],
    messages: [],
    tools: [],
    privacyMode: TRAINING_ALLOWED,
  })
  assert.equal(postTurnWork.length, 0)

  // And an action that was given no comparison capability hands nothing over either.
  const { handler: withoutCapability, postTurnWork: noWork } = createHarness()
  await withoutCapability.enqueueAgentResponseComparisonIfEligible({
    ctx: createContext(),
    parentInvocationId: "parent",
    responseMessages: [assistantMessage("an answer")],
    messages: [],
    tools: [],
    privacyMode: TRAINING_ALLOWED,
  })
  assert.equal(noWork.length, 0)
})

test("a pending comparison whose parent answered is compared after the turn ends", async () => {
  const { capability } = createCapability()
  const { handler, postTurnWork, updates } = createHarness({ config: { agentResponseComparison: capability } })
  const ctx = createContext()

  await handler.preparePendingAgentResponseComparison({
    ctx,
    parentInvocationId: "parent",
    messages: [],
    tools: [],
    privacyMode: TRAINING_ALLOWED,
  })
  await handler.enqueueAgentResponseComparisonIfEligible({
    ctx,
    parentInvocationId: "parent",
    responseMessages: [assistantMessage("the parent's answer")],
    messages: [],
    tools: [],
    privacyMode: TRAINING_ALLOWED,
  })
  await handler.finalizePendingAgentResponseComparison(true)
  assert.equal(postTurnWork.length, 1)

  await postTurnWork[0]!()
  assert.deepEqual(
    updates.map(update => update.message.value?.event?.case),
    ["started", "started", "textDelta", "completed"],
  )
})

test("a parent response the comparison cannot use ends the comparison early", async () => {
  const { capability } = createCapability()
  const { handler, postTurnWork, updates } = createHarness({ config: { agentResponseComparison: capability } })
  const ctx = createContext()

  await handler.preparePendingAgentResponseComparison({
    ctx,
    parentInvocationId: "parent",
    messages: [],
    tools: [],
    privacyMode: TRAINING_ALLOWED,
  })
  // A turn that called a tool cannot be compared, so the pending comparison is dropped rather than run.
  await handler.enqueueAgentResponseComparisonIfEligible({
    ctx,
    parentInvocationId: "parent",
    responseMessages: [
      { role: "assistant", content: [{ type: "text", text: "let me look" }, { type: "tool-call", toolName: "Shell" }] },
    ],
    messages: [],
    tools: [],
    privacyMode: TRAINING_ALLOWED,
  })
  await handler.finalizePendingAgentResponseComparison(true)

  assert.equal(postTurnWork.length, 0)
  assert.equal(updates.at(-1)!.message.value?.event?.case, "skipped")
})
