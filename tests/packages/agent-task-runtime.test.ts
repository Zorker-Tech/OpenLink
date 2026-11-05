import { test } from "node:test"
import assert from "node:assert/strict"

import {
  assertCloudOnlyTaskArgsAllowed,
  assertMachineAndLegacyArgsNotBothSet,
  collectConversationStepsFromStepBlobIds,
  collectConversationStepsWithToolCallCount,
  collectConversationTurns,
  countToolCallsFromTurns,
  createTaskInitialMessage,
  extractLastAssistantMessage,
  getEffectiveReadonlyForSubagent,
  resolveSubagentModel,
  shouldUseAskModeForSubagent,
  targetMachineFromLegacyArgs,
  toClientSubagentPlacement,
  type ConversationBlobStore,
  type TaskSubagentModelConfig,
  type TaskTargetMachine,
} from "../../source/packages/agent/tools/task-runtime.ts"
import {
  buildCloudSubagentPersistedStateInterop,
  createTaskInitialUserActionInterop,
  conversationStepViewInterop,
  taskEnvironmentForTargetMachineInterop,
  taskEnvironmentToProtoInterop,
  targetMachineFromProtoInterop,
  targetMachineToProtoInterop,
} from "../../source/adapters/interop/agent/task-runtime-protocol-adapter.ts"
import { SubagentModelForcePolicy } from "../../source/packages/agent/tools/subagent-model-policy.ts"
import { createSubagentModels } from "../../source/packages/agent/tools/core/subagent/models.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import {
  AgentMode,
  ConversationStep,
  ConversationTurnStructure,
  SubagentExecutionEnvironment,
  TargetMachine,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { SelectedContext } from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import {
  CustomSubagentPermissionMode,
} from "../../source/adapters/interop/proto/generated/agent/v1/subagents_pb.ts"
import { createSlateSubagentType, SlateSubagentKind } from "../../source/packages/agent/subagent-type.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"

// ---------------------------------------------------------------------------------------------
// which model a subagent runs on
// ---------------------------------------------------------------------------------------------

const models = createSubagentModels({
  fast: { slug: "composer-2-fast" },
  standard: { slug: "composer-2" },
  other: { slug: "other-model" },
})

const exploreType = createSlateSubagentType(SlateSubagentKind.EXPLORE)
const generalType = createSlateSubagentType(SlateSubagentKind.GENERAL_PURPOSE)

function config(overrides: Partial<TaskSubagentModelConfig> = {}): TaskSubagentModelConfig {
  return { permissionMode: CustomSubagentPermissionMode.DEFAULT, subagentType: generalType, ...overrides }
}

function resolve(
  subagentConfig: TaskSubagentModelConfig,
  options: {
    requestedModel?: string
    parentModelId?: string
    forceModelId?: string
    policy?: (typeof SubagentModelForcePolicy)[keyof typeof SubagentModelForcePolicy]
    parentMaxMode?: boolean
    blocked?: string[]
    valid?: (modelId: string) => boolean
    requiresMaxMode?: (modelId: string) => Promise<boolean>
    compareModelCosts?: (candidate: string, parent: string) => number
    enableExploreParentModelInheritance?: boolean
  } = {},
): Promise<string> {
  const blocked = new Set(options.blocked ?? [])
  return resolveSubagentModel({
    subagentConfig,
    requestedModel: options.requestedModel,
    parentModelId: options.parentModelId ?? "composer-2",
    ...(options.enableExploreParentModelInheritance === undefined ? {} : { enableExploreParentModelInheritance: options.enableExploreParentModelInheritance }),
    forceModelId: options.forceModelId,
    subagentModelForcePolicy: options.policy ?? SubagentModelForcePolicy.None,
    parentMaxMode: options.parentMaxMode ?? true,
    subagentModels: models,
    isModelBlocked: modelId => blocked.has(modelId),
    isModelValid: options.valid ?? (modelId => models.modelsBySlug.has(modelId)),
    compareModelCosts: options.compareModelCosts ?? (() => 0),
    ...(options.requiresMaxMode === undefined ? {} : { requiresMaxMode: options.requiresMaxMode }),
  })
}

test("an auto parent with nothing requested passes its own model to the subagent", async () => {
  assert.equal(await resolve(config(), { parentModelId: "auto" }), "auto")
  assert.equal(await resolve(config(), { parentModelId: "premium" }), "premium")
})

test("an auto parent that cannot be used is resolved like any other", async () => {
  const resolved = await resolve(config({ defaultModelIds: ["composer-2-fast"] }), { parentModelId: "auto" })
  assert.equal(resolved, "composer-2-fast")
})

test("a model the request pinned is used when it is usable", async () => {
  assert.equal(
    await resolve(config(), { policy: SubagentModelForcePolicy.ParentPin, forceModelId: "other-model" }),
    "other-model",
  )
})

test("a pinned model that is blocked is refused rather than replaced", async () => {
  await assert.rejects(
    () => resolve(config(), { policy: SubagentModelForcePolicy.ParentPin, forceModelId: "other-model", blocked: ["other-model"] }),
    /No usable model is available for this subagent\./,
  )
})

test("a requested model is resolved against the catalogue and returned", async () => {
  assert.equal(await resolve(config(), { requestedModel: "other-model" }), "other-model")
  assert.equal(await resolve(config(), { requestedModel: "other_model" }), "other-model")
})

test("naming the parent's own model is always allowed", async () => {
  assert.equal(await resolve(config(), { requestedModel: "parent-only-model", parentModelId: "parent-only-model" }), "parent-only-model")
})

test("a model that resolves to nothing is refused with the ones that exist", async () => {
  await assert.rejects(
    () => resolve(config(), { requestedModel: "no-such-model" }),
    (error: Error) => error.message.includes('Invalid model selection "no-such-model".') &&
      error.message.includes("Allowed model slugs:\n- composer-2\n- composer-2-fast\n- other-model"),
  )
})

test("an empty model is refused with what it should have been", async () => {
  await assert.rejects(
    () => resolve(config(), { requestedModel: "   " }),
    /Model must be a non-empty string when provided\./,
  )
})

test("the fast alias is tolerated even when it resolves to nothing usable", async () => {
  // "fast" is not in the catalogue, so it resolves to nothing — and the call still succeeds.
  assert.equal(await resolve(config({ inheritParentModel: true }), { requestedModel: "fast" }), "composer-2")
})

test("a subagent asked to inherit the parent's model gets it when the parent can be used", async () => {
  assert.equal(await resolve(config({ inheritParentModel: true })), "composer-2")
  assert.equal(await resolve(config({ inheritParentModel: true }), { requestedModel: "inherit" }), "composer-2")
})

test("a blocked parent model falls through to the configured defaults", async () => {
  assert.equal(
    await resolve(config({ inheritParentModel: true, defaultModelIds: ["composer-2-fast"] }), { blocked: ["composer-2"] }),
    "composer-2-fast",
  )
})

test("the user's own default is used when it is a real model", async () => {
  assert.equal(await resolve(config({ userRequestedModelId: "other-model" })), "other-model")
  // A user default that names nothing still leaves the parent's model as the answer.
  assert.equal(await resolve(config({ userRequestedModelId: "not-a-model" })), "composer-2")
})

test("an explore subagent may inherit the parent's model instead of the catalogue default", async () => {
  const exploreConfig = config({ subagentType: exploreType, defaultModelIds: ["composer-2-fast"] })
  assert.equal(await resolve(exploreConfig, { parentModelId: "other-model" }), "composer-2-fast")
  assert.equal(
    await resolve(exploreConfig, { parentModelId: "other-model", enableExploreParentModelInheritance: true }),
    "other-model",
  )
  // Inheriting is not offered when the parent's model is one of the family's own defaults: the default is
  // the answer then, and the parent's model is not a choice the subagent should be making.
  assert.equal(
    await resolve(exploreConfig, { parentModelId: "composer-2", enableExploreParentModelInheritance: true }),
    "composer-2-fast",
  )
  // A parent model outside the catalogue cannot be inherited at all.
  assert.equal(
    await resolve(exploreConfig, { parentModelId: "not-in-catalogue", enableExploreParentModelInheritance: true }),
    "composer-2-fast",
  )
})

test("the configured defaults are tried in order and only the usable one wins", async () => {
  assert.equal(await resolve(config({ defaultModelIds: ["other-model", "composer-2-fast"] })), "other-model")
  assert.equal(await resolve(config({ defaultModelIds: ["other-model", "composer-2-fast"] }), { blocked: ["other-model"] }), "composer-2-fast")
})

test("an explore subagent takes the cheaper default first, and never one costlier than the parent", async () => {
  const defaults = ["composer-2-fast", "composer-2"]
  // The first default is the cheap tier; when it is not actually cheaper it moves behind the other one.
  const fastIsCostlier = (candidate: string, _parent: string): number => candidate === "composer-2-fast" ? 1 : -1
  assert.equal(
    await resolve(config({ subagentType: exploreType, defaultModelIds: defaults }), { parentModelId: "other-model", compareModelCosts: fastIsCostlier }),
    "composer-2",
  )
  const fastIsCheaper = (candidate: string, _parent: string): number => candidate === "composer-2-fast" ? -1 : 1
  assert.equal(
    await resolve(config({ subagentType: exploreType, defaultModelIds: defaults }), { parentModelId: "other-model", compareModelCosts: fastIsCheaper }),
    "composer-2-fast",
  )
  // A default that costs more than the parent's model is skipped even when it is the only one.
  await assert.rejects(
    () => resolve(
      config({ subagentType: exploreType, defaultModelIds: ["composer-2-fast"] }),
      { parentModelId: "blocked-parent", blocked: ["blocked-parent"], compareModelCosts: fastIsCostlier },
    ),
    /No usable model is available for this subagent\./,
  )
})

test("a model that needs max mode is skipped when the session is not in it", async () => {
  const requiresMaxMode = async (modelId: string) => modelId === "other-model"
  assert.equal(await resolve(config({ defaultModelIds: ["other-model"] }), { requiresMaxMode, parentMaxMode: false }), "composer-2")
  assert.equal(await resolve(config({ defaultModelIds: ["other-model"] }), { requiresMaxMode, parentMaxMode: true }), "other-model")
})

test("a placeholder parent model keeps its family's default instead of being handed down", async () => {
  assert.equal(
    await resolve(config({ defaultModelIds: ["composer-2-fast"] }), { parentModelId: "genericbase-1" }),
    "genericbase-1",
  )
})

test("a call with no usable model anywhere is refused with what could be chosen", async () => {
  await assert.rejects(
    () => resolve(config({ defaultModelIds: ["other-model"] }), { parentModelId: "composer-2", blocked: ["composer-2", "other-model"] }),
    (error: Error) => error.message.includes("No usable model is available for this subagent.") &&
      error.message.includes("Choose a supported model with the `model` parameter or omit this subagent call."),
  )
})

// ---------------------------------------------------------------------------------------------
// how a subagent's permissions decide its mode
// ---------------------------------------------------------------------------------------------

test("a readonly subagent is read as readonly and nothing else is", () => {
  assert.equal(getEffectiveReadonlyForSubagent({ permissionMode: CustomSubagentPermissionMode.READONLY }), true)
  assert.equal(getEffectiveReadonlyForSubagent({ permissionMode: CustomSubagentPermissionMode.DEFAULT }), false)
  assert.equal(getEffectiveReadonlyForSubagent({ permissionMode: CustomSubagentPermissionMode.AGENT_ONLY }), false)
})

test("a readonly subagent runs in ask mode only when it has nowhere to write", () => {
  const readonlyConfig = { permissionMode: CustomSubagentPermissionMode.READONLY }
  assert.equal(shouldUseAskModeForSubagent(true, readonlyConfig), true)
  assert.equal(shouldUseAskModeForSubagent(true, { ...readonlyConfig, computeAllowedWritePaths: ["/repo/out"] }), false)
  assert.equal(shouldUseAskModeForSubagent(false, readonlyConfig), false)
})

test("the subagent's first Slate message carries its mode, context and nonvarying reminder", () => {
  const message = createTaskInitialMessage(
    { permissionMode: CustomSubagentPermissionMode.DEFAULT, systemReminder: () => "Stay in scope." },
    "do the thing",
    "message-1",
    false,
    undefined,
  )
  assert.equal(message.text, "do the thing")
  assert.equal(message.messageId, "message-1")
  assert.equal(message.mode, SlateMode.AGENT)
  assert.equal(message.subagentSystemReminder, "Stay in scope.")
  assert.equal(message.selectedContext, undefined)
})

test("the AgentRoot boundary projects a Slate first message without changing its wire meaning", () => {
  const selectedContext = new SelectedContext()
  const message = createTaskInitialMessage(
    { permissionMode: CustomSubagentPermissionMode.DEFAULT, systemReminder: () => "Stay in scope." },
    "open the report",
    "message-4",
    true,
    selectedContext,
  )

  const action = createTaskInitialUserActionInterop({ message })
  assert.equal(action.action.case, "userMessageAction")
  if (action.action.case !== "userMessageAction") assert.fail("expected a first user message")
  assert.equal(action.action.value.userMessage?.text, "open the report")
  assert.equal(action.action.value.userMessage?.messageId, "message-4")
  assert.equal(action.action.value.userMessage?.mode, AgentMode.ASK)
  assert.equal(action.action.value.userMessage?.subagentSystemReminder, "Stay in scope.")
  assert.equal(SelectedContext.equals(action.action.value.userMessage?.selectedContext, selectedContext), true)
})

test("an empty reminder is left out, and a reminder that takes arguments is not called", () => {
  const empty = createTaskInitialMessage(
    { permissionMode: CustomSubagentPermissionMode.DEFAULT, systemReminder: () => "" },
    "go",
    "message-2",
    true,
    undefined,
  )
  assert.equal(empty.mode, SlateMode.CHAT)
  assert.equal(empty.subagentSystemReminder, undefined)

  let called = false
  const perCall = ((_arg: unknown) => { called = true; return "reminder" }) as unknown as () => string
  createTaskInitialMessage({ permissionMode: CustomSubagentPermissionMode.DEFAULT, systemReminder: perCall }, "go", "message-3", false, undefined)
  assert.equal(called, false)
})

// ---------------------------------------------------------------------------------------------
// reading a subagent's conversation back out of its blobs
// ---------------------------------------------------------------------------------------------

interface RecordedBlob {
  readonly id: Uint8Array
  readonly bytes: Uint8Array
}

function blobStoreOf(entries: RecordedBlob[]): ConversationBlobStore {
  const byKey = new Map(entries.map(entry => [Buffer.from(entry.id).toString("hex"), entry.bytes]))
  return {
    async getBlob(_ctx: Context, blobId: Uint8Array) {
      return byKey.get(Buffer.from(blobId).toString("hex"))
    },
  }
}

const idOf = (n: number): Uint8Array => new Uint8Array([n])

function stepBlobWithId(id: number, message: ConversationStep["message"]): RecordedBlob {
  return { id: idOf(id), bytes: new ConversationStep({ message }).toBinary() }
}

function turnBlob(id: number, stepIds: number[]): RecordedBlob {
  return {
    id: idOf(id),
    bytes: new ConversationTurnStructure({
      turn: {
        case: "agentConversationTurn",
        value: { steps: stepIds.map(idOf) } as never,
      },
    }).toBinary(),
  }
}

test("the last thing the subagent said is found by walking its turns backwards", async () => {
  const ctx = createContext()
  const blobs = [
    turnBlob(1, [10, 11]),
    stepBlobWithId(10, { case: "assistantMessage", value: { text: "first answer" } } as never),
    stepBlobWithId(11, { case: "toolCall", value: {} } as never),
    turnBlob(2, [12]),
    stepBlobWithId(12, { case: "assistantMessage", value: { text: "second answer" } } as never),
  ]
  const store = blobStoreOf(blobs)
  assert.equal(await extractLastAssistantMessage(ctx, [idOf(1), idOf(2)], store), "second answer")
  assert.equal(await extractLastAssistantMessage(ctx, [idOf(1)], store), "first answer")
})

test("turns and steps that are no longer there are skipped rather than treated as empty", async () => {
  const ctx = createContext()
  const store = blobStoreOf([
    turnBlob(2, [12]),
    stepBlobWithId(12, { case: "assistantMessage", value: { text: "answer" } } as never),
  ])
  assert.equal(await extractLastAssistantMessage(ctx, [idOf(1), idOf(2)], store), "answer")
  assert.equal(await extractLastAssistantMessage(ctx, [idOf(9)], store), undefined)
})

test("a turn that is not an agent turn contributes nothing", async () => {
  const ctx = createContext()
  const userTurn: RecordedBlob = {
    id: idOf(3),
    bytes: new ConversationTurnStructure({ turn: { case: "userConversationTurn", value: {} } as never }).toBinary(),
  }
  const store = blobStoreOf([userTurn])
  assert.equal(await extractLastAssistantMessage(ctx, [idOf(3)], store), undefined)
})

test("the steps of a turn are collected and the ones that are gone are left out", async () => {
  const ctx = createContext()
  const store = blobStoreOf([
    stepBlobWithId(10, { case: "assistantMessage", value: { text: "hello" } } as never),
  ])
  const steps = await collectConversationStepsFromStepBlobIds({ ctx, stepBlobIds: [idOf(9), idOf(10)], blobStore: store })
  assert.equal(steps.length, 1)
  assert.equal(conversationStepViewInterop(steps[0]).kind, "assistant")
})

test("turns are read into structures, with the missing ones kept as gaps", async () => {
  const ctx = createContext()
  const store = blobStoreOf([turnBlob(1, [])])
  const turns = await collectConversationTurns({ ctx, turns: [idOf(1), idOf(2)], blobStore: store })
  assert.equal(turns.length, 2)
  assert.equal(turns[0]?.kind, "agent")
  assert.equal(turns[1], undefined)
})

test("the tool calls in a conversation are counted across all of its turns", async () => {
  const ctx = createContext()
  const store = blobStoreOf([
    turnBlob(1, [10, 11]),
    stepBlobWithId(10, { case: "toolCall", value: {} } as never),
    stepBlobWithId(11, { case: "assistantMessage", value: { text: "done" } } as never),
    turnBlob(2, [12]),
    stepBlobWithId(12, { case: "toolCall", value: {} } as never),
  ])
  assert.equal(await countToolCallsFromTurns(ctx, [idOf(1), idOf(2)], store), 2)
  const collected = await collectConversationStepsWithToolCallCount(ctx, [idOf(1), idOf(2)], store)
  assert.equal(collected.toolCallCount, 2)
  assert.equal(collected.conversationSteps.length, 3)
})

// ---------------------------------------------------------------------------------------------
// where the subagent runs
// ---------------------------------------------------------------------------------------------

test("a placement is read into the environment the protocol spells", () => {
  assert.equal(taskEnvironmentToProtoInterop("cloud"), SubagentExecutionEnvironment.CLOUD)
  assert.equal(taskEnvironmentToProtoInterop("local"), SubagentExecutionEnvironment.LOCAL)
  assert.equal(taskEnvironmentToProtoInterop(undefined), SubagentExecutionEnvironment.UNSPECIFIED)

  assert.equal(taskEnvironmentForTargetMachineInterop({ type: "same_machine" }), SubagentExecutionEnvironment.LOCAL)
  assert.equal(taskEnvironmentForTargetMachineInterop({ type: "new_cloud_vm" }), SubagentExecutionEnvironment.CLOUD)
  assert.equal(taskEnvironmentForTargetMachineInterop({ type: "self_hosted_worker", worker_id: "w" }), SubagentExecutionEnvironment.CLOUD)
  assert.equal(taskEnvironmentForTargetMachineInterop({ type: "self_hosted_pool" }), SubagentExecutionEnvironment.CLOUD)
})

test("a client-executed subagent can run here or on a cloud VM, and nowhere else", () => {
  assert.deepEqual(toClientSubagentPlacement({ type: "same_machine" }), {
    environment: "local",
    cloudBaseBranch: undefined,
  })
  assert.deepEqual(toClientSubagentPlacement({ type: "new_cloud_vm", base_branch: "main" }), {
    environment: "cloud",
    cloudBaseBranch: "main",
  })
  assert.throws(
    () => toClientSubagentPlacement({ type: "self_hosted_worker", worker_id: "worker-1" }),
    /Self-hosted machine placement requires server-side first-class subagent execution/,
  )
  assert.throws(() => toClientSubagentPlacement({ type: "self_hosted_pool" }), /not supported by a fresh client-executed Task\./)
})

test("the older environment fields are read into a placement, with blank fields meaning nothing", () => {
  assert.deepEqual(targetMachineFromLegacyArgs({}), { type: "same_machine" })
  assert.deepEqual(targetMachineFromLegacyArgs({ environment: "local" }), { type: "same_machine" })
  assert.deepEqual(targetMachineFromLegacyArgs({ environment: "cloud" }), { type: "new_cloud_vm" })
  assert.deepEqual(
    targetMachineFromLegacyArgs({ environment: "cloud", cloud_base_branch: "  main  ", cloud_requested_environment_build_id: " bld-1 " }),
    { type: "new_cloud_vm", base_branch: "main", environment_build_id: "bld-1" },
  )
  assert.deepEqual(
    targetMachineFromLegacyArgs({ environment: "cloud", cloud_base_branch: "   ", cloud_requested_environment_build_id: "" }),
    { type: "new_cloud_vm" },
  )
})

test("a placement survives the trip through the protocol in both directions", () => {
  const targets: TaskTargetMachine[] = [
    { type: "same_machine" },
    { type: "new_cloud_vm" },
    { type: "new_cloud_vm", base_branch: "main", environment_build_id: "bld-1" },
    { type: "self_hosted_worker", worker_id: "worker-1" },
    { type: "self_hosted_pool" },
    { type: "self_hosted_pool", pool: "team-pool", labels: { region: "eu", tier: "gpu" } },
  ]
  for (const target of targets) {
    assert.deepEqual(targetMachineFromProtoInterop(targetMachineToProtoInterop(target)), target)
  }
})

test("a placement that says nothing, or something unknown, reads as no placement", () => {
  assert.equal(targetMachineFromProtoInterop(undefined), undefined)
  assert.equal(targetMachineFromProtoInterop(new TargetMachine({})), undefined)
})

test("a pool with no labels carries no labels on the wire", () => {
  const machine = targetMachineToProtoInterop({ type: "self_hosted_pool" })
  assert.equal(machine.machine.case === "selfHostedPool" ? machine.machine.value.labels.length : -1, 0)
  assert.equal(targetMachineFromProtoInterop(machine)?.type, "self_hosted_pool")
})

test("a cloud subagent's saved state carries how to find it again", () => {
  const state = buildCloudSubagentPersistedStateInterop({ agentId: "bc-1", targetMachine: { type: "new_cloud_vm", base_branch: "main" } })
  assert.equal(state.environment, SubagentExecutionEnvironment.CLOUD)
  assert.equal(state.cloudSubagent?.bcId, "bc-1")
  assert.equal(state.cloudSubagent?.transcriptPath, undefined)
  assert.equal(state.modelId, undefined)
  assert.equal(state.machine?.machine.case, "newCloudVm")

  const withExtras = buildCloudSubagentPersistedStateInterop({
    agentId: "bc-2",
    transcriptUri: "/repo/.slate/transcripts/bc-2.txt",
    modelId: "composer-2",
    targetMachine: { type: "same_machine" },
  })
  assert.equal(withExtras.cloudSubagent?.transcriptPath, "/repo/.slate/transcripts/bc-2.txt")
  assert.equal(withExtras.modelId, "composer-2")
  assert.equal(withExtras.machine?.machine.case, "sameMachine")
})

test("a placement given both ways is refused rather than guessed at", () => {
  assertMachineAndLegacyArgsNotBothSet({})
  assertMachineAndLegacyArgsNotBothSet({ environment: "cloud" })
  assertMachineAndLegacyArgsNotBothSet({ machine: { type: "same_machine" } })

  assert.throws(
    () => assertMachineAndLegacyArgsNotBothSet({ machine: { type: "same_machine" }, environment: "cloud" }),
    /machine replaces environment; specify machine alone\./,
  )
  assert.throws(
    () => assertMachineAndLegacyArgsNotBothSet({
      machine: { type: "same_machine" },
      environment: "cloud",
      cloud_base_branch: "main",
      cloud_requested_environment_build_id: "bld-1",
    }),
    /machine replaces environment, cloud_base_branch, cloud_requested_environment_build_id; specify machine alone\./,
  )
})

test("a cloud-only field without the cloud environment is refused, and blank does not count", () => {
  assertCloudOnlyTaskArgsAllowed({})
  assertCloudOnlyTaskArgsAllowed({ environment: "cloud", cloud_base_branch: "main" })
  assertCloudOnlyTaskArgsAllowed({ cloud_base_branch: "   " })
  assertCloudOnlyTaskArgsAllowed({ cloud_requested_environment_build_id: "" })

  assert.throws(
    () => assertCloudOnlyTaskArgsAllowed({ environment: "local", cloud_base_branch: "main" }),
    /cloud_base_branch may only be specified when environment equals cloud\./,
  )
  assert.throws(
    () => assertCloudOnlyTaskArgsAllowed({ cloud_requested_environment_build_id: "bld-1" }),
    /cloud_requested_environment_build_id may only be specified when environment equals cloud\./,
  )
})

test("a generic parent's default keeps the parent's own placeholder model", async () => {
  assert.equal(await resolve(config({ defaultModelIds: ["other-model"] }), { parentModelId: "genericbase-1" }), "genericbase-1")
})

test("an auto parent with a user default still uses the user's model", async () => {
  assert.equal(await resolve(config({ userRequestedModelId: "composer-2-fast" }), { parentModelId: "auto-medium" }), "composer-2-fast")
})

test("a pin policy without a pinned model does not refuse the call", async () => {
  assert.equal(await resolve(config(), { policy: SubagentModelForcePolicy.ParentPin }), "composer-2")
})

test("an auto parent naming its own placeholder is refused rather than taken", async () => {
  // The placeholder is not a catalogue model, so naming it is not the same as naming the parent's model.
  await assert.rejects(
    () => resolve(config(), { requestedModel: "default", parentModelId: "default" }),
    /Invalid model selection "default"\./,
  )
})

test("a forced default is not overridden by the request", async () => {
  assert.equal(await resolve(config({ forceDefaultModel: true }), { requestedModel: "other-model" }), "composer-2")
})

test("a blocked user default falls back to the parent's model", async () => {
  assert.equal(await resolve(config({ userRequestedModelId: "composer-2-fast" }), { blocked: ["composer-2-fast"] }), "composer-2")
})

test("inheriting the parent's model for exploring needs an explore subagent", async () => {
  // The parent's model is on the catalogue and is not a default placeholder, so only the type stops the inheritance.
  const resolved = await resolve(config({ defaultModelIds: ["composer-2-fast"] }), { enableExploreParentModelInheritance: true, parentModelId: "other-model" })
  assert.equal(resolved, "composer-2-fast")
})

