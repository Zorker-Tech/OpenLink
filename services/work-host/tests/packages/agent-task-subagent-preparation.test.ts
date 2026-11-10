import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"

import {
  attachmentPathEnvironment,
  buildClientSubagentAttachmentsContext,
  getEffectiveSubagentEnvironment,
  getPotentialVideoMimeTypeFromPath,
  getVideoMimeTypeFromPath,
  isPathWithinAllowedPrefix,
  isPriorSubagentModelUsable,
  prepareTaskSubagent,
  resolveCanonicalSubagentId,
  resolveSubagentConversationState,
  resolveTaskSubagentConfig,
  resolveTrustedAttachmentPath,
  untrustedAttachmentPathError,
} from "../../source/packages/agent/tools/task-subagent-preparation.ts"
import { taskEnvironmentFromProtoInterop } from "../../source/adapters/interop/agent/task-runtime-protocol-adapter.ts"
import { buildSlatePreparedTaskHookInput, type SlatePreparedTask } from "../../source/packages/agent/tools/task-prepared-state.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { createSubagentModels } from "../../source/packages/agent/tools/core/subagent/models.ts"
import { SubagentModelForcePolicy } from "../../source/packages/agent/tools/subagent-model-policy.ts"
import {
  SubagentCredentials,
  SubagentExecutionEnvironment,
  ConversationStateStructure,
  ApiKeyCredentials,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { fromInteropTaskConversationState } from "../../source/adapters/interop/agent/task-conversation-state-adapter.ts"
import type {
  SlateSubagentPersistedState,
  SlateTaskConversationState,
} from "../../source/packages/agent/subagent-persisted-state.ts"
import type { SlateTaskRequest } from "../../source/packages/agent/tools/task-runtime-types.ts"
import {
  CustomSubagentPermissionMode,
} from "../../source/adapters/interop/proto/generated/agent/v1/subagents_pb.ts"
import { createSlateSubagentType, SlateSubagentKind } from "../../source/packages/agent/subagent-type.ts"
import { readExecutorResource, type ReadExecutorResult } from "../../source/packages/agent-exec/read-operation.ts"
import { requestContextExecutorResource } from "../../source/packages/agent-exec/request-context-operation.ts"
import { RequestContext } from "../../source/adapters/interop/proto/generated/agent/v1/request_context_exec_pb.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"

// ---------------------------------------------------------------------------------------------
// the environment a subagent runs in
// ---------------------------------------------------------------------------------------------

/** The saved state a resume reads: every field it may look at, so the fakes are honest about the shape. */
/** The credentials a prepared subagent may be given, in the shape the proto carries them. */
const credentials: SubagentCredentials["credentials"] = { case: "apiKeyCredentials", value: new ApiKeyCredentials({ apiKey: "secret" }) }

const restoredState = (
  overrides: Partial<Pick<SlateSubagentPersistedState, "conversationSnapshot" | "cloudAgent" | "subagentType" | "modelId" | "targetMachine" | "executionEnvironment" | "firstClassAgentId" | "requestedRuntimeBuildId">> = {},
): Pick<SlateSubagentPersistedState, "conversationSnapshot" | "cloudAgent" | "subagentType" | "modelId" | "targetMachine" | "executionEnvironment" | "firstClassAgentId" | "requestedRuntimeBuildId"> => ({
  conversationSnapshot: undefined,
  cloudAgent: undefined,
  subagentType: undefined,
  modelId: undefined,
  targetMachine: undefined,
  executionEnvironment: "unspecified",
  firstClassAgentId: undefined,
  requestedRuntimeBuildId: undefined,
  ...overrides,
} as never)

test("a stored environment is read back as the request spells it", () => {
  assert.equal(taskEnvironmentFromProtoInterop(SubagentExecutionEnvironment.CLOUD), "cloud")
  assert.equal(taskEnvironmentFromProtoInterop(SubagentExecutionEnvironment.LOCAL), "local")
  assert.equal(taskEnvironmentFromProtoInterop(SubagentExecutionEnvironment.UNSPECIFIED), undefined)
})

test("what the request asked for wins, and the saved state is the fallback", () => {
  // A machine in the request decides it, whatever else says.
  assert.equal(
    getEffectiveSubagentEnvironment({ targetMachine: { kind: "cloud-machine" } }, restoredState({ executionEnvironment: "local" })),
    "cloud",
  )
  assert.equal(
    getEffectiveSubagentEnvironment({ targetMachine: { kind: "same-device" } }, restoredState({ executionEnvironment: "cloud" })),
    "local",
  )
  // Then the older environment field.
  assert.equal(
    getEffectiveSubagentEnvironment({ environment: "cloud" }, restoredState({ executionEnvironment: "local" })),
    "cloud",
  )
  // Then the saved state's machine, then its environment, then a cloud reference.
  assert.equal(
    getEffectiveSubagentEnvironment({}, restoredState({ targetMachine: { kind: "cloud-machine" } })),
    "cloud",
  )
  assert.equal(
    getEffectiveSubagentEnvironment({}, restoredState({ executionEnvironment: "cloud" })),
    "cloud",
  )
  assert.equal(
    getEffectiveSubagentEnvironment({}, restoredState({ cloudAgent: { agentId: "bc-1" } })),
    "cloud",
  )
  assert.equal(getEffectiveSubagentEnvironment({}, undefined), undefined)
  // And a saved state that says nothing is the same as none at all.
  assert.equal(getEffectiveSubagentEnvironment({}, restoredState()), undefined)
})

test("a subagent named by its cloud run is resolved to the id it was started with", () => {
  assert.equal(resolveCanonicalSubagentId({}, "bc-1"), "bc-1")
  assert.equal(resolveCanonicalSubagentId({ resolveSubagentId: id => (id === "bc-1" ? "subagent-1" : undefined) }, "bc-1"), "subagent-1")
  assert.equal(resolveCanonicalSubagentId({ resolveSubagentId: () => undefined }, "bc-9"), "bc-9")
})

// ---------------------------------------------------------------------------------------------
// attachment paths
// ---------------------------------------------------------------------------------------------

test("a video is recognised by its extension, or by what the mime database says", () => {
  assert.equal(getVideoMimeTypeFromPath("clip.mp4"), "video/mp4")
  assert.equal(getVideoMimeTypeFromPath("clip.MOV"), "video/quicktime")
  assert.equal(getVideoMimeTypeFromPath("clip.txt"), undefined)
  assert.equal(getVideoMimeTypeFromPath("clip"), undefined)
  assert.equal(getPotentialVideoMimeTypeFromPath("clip.webm"), "video/webm")
  // An extension the platform does not list is left to the mime database.
  assert.equal(getPotentialVideoMimeTypeFromPath("clip.mpeg"), "video/mpeg")
  assert.equal(getPotentialVideoMimeTypeFromPath("notes.txt"), undefined)
})

test("a path is inside a prefix only when it is the prefix or below it", () => {
  assert.equal(isPathWithinAllowedPrefix({ targetPath: "/repo/uploads/a.mp4", prefix: "/repo/uploads" }), true)
  assert.equal(isPathWithinAllowedPrefix({ targetPath: "/repo/uploads", prefix: "/repo/uploads" }), true)
  assert.equal(isPathWithinAllowedPrefix({ targetPath: "/repo/upload", prefix: "/repo/uploads" }), false)
  assert.equal(isPathWithinAllowedPrefix({ targetPath: "/elsewhere/a.mp4", prefix: "/repo/uploads" }), false)
})

test("a refused attachment explains where attachments may come from", () => {
  const error = untrustedAttachmentPathError("/tmp/clip.mp4")
  assert.match(error.message, /Attachment path is not trusted: \/tmp\/clip\.mp4\./)
  assert.match(error.message, /Only videos the user attached to this conversation/)
  assert.match(error.message, /cannot make it trusted/)
})

test("an attachment is trusted from the session's own folders or from where the user put it", () => {
  const requestContext = {
    env: { projectFolder: "/repo/.slate/projects/p1", workspacePaths: ["/work"], artifactsFolder: "/artifacts" },
  }
  assert.equal(
    resolveTrustedAttachmentPath({ attachmentPath: "/repo/.slate/projects/p1/uploads/clip.mp4", requestContext }),
    "/repo/.slate/projects/p1/uploads/clip.mp4",
  )
  assert.equal(
    resolveTrustedAttachmentPath({ attachmentPath: "/work/attachments/clip.mp4", requestContext }),
    "/work/attachments/clip.mp4",
  )
  assert.equal(resolveTrustedAttachmentPath({ attachmentPath: "/artifacts/clip.mp4", requestContext }), "/artifacts/clip.mp4")
  assert.equal(resolveTrustedAttachmentPath({ attachmentPath: "/tmp/clip.mp4", requestContext }), undefined)
  // A path the user attached is trusted wherever it is.
  assert.equal(
    resolveTrustedAttachmentPath({ attachmentPath: "/tmp/clip.mp4", requestContext, userAttachedVideoPaths: ["/tmp/clip.mp4"] }),
    "/tmp/clip.mp4",
  )
  // A root the session was given for videos is trusted without any of the folders above.
  assert.equal(
    resolveTrustedAttachmentPath({ attachmentPath: "/box/videos/clip.mp4", requestContext, trustedVideoAttachmentRoots: ["/box/videos"] }),
    "/box/videos/clip.mp4",
  )
})

test("a session with no environment has no folders, which means none are allowed", () => {
  assert.deepEqual(attachmentPathEnvironment({}), { workspacePaths: [] })
  const env = { projectFolder: "/repo", workspacePaths: ["/work"] }
  assert.equal(attachmentPathEnvironment({ env }), env)
  assert.equal(resolveTrustedAttachmentPath({ attachmentPath: "/repo/uploads/clip.mp4", requestContext: {} }), undefined)
})

// ---------------------------------------------------------------------------------------------
// what a subagent starts from
// ---------------------------------------------------------------------------------------------

const parentStateWith = (state: SlateTaskConversationState): {
  readonly asked: string[]
  readonly parentState: {
    getConversationState(ctx: Context): Promise<SlateTaskConversationState>
    restoreSubagentState(ctx: Context, subagentId: string): Pick<SlateSubagentPersistedState, "conversationSnapshot" | "cloudAgent" | "subagentType" | "modelId" | "targetMachine" | "executionEnvironment" | "firstClassAgentId" | "requestedRuntimeBuildId"> | undefined
  }
} => {
  const asked: string[] = []
  return {
    asked,
    parentState: {
      async getConversationState() { return state },
      restoreSubagentState(_ctx, subagentId) {
        asked.push(subagentId)
        return undefined
      },
    },
  }
}

test("a self-fork starts from the parent's own conversation", async () => {
  const state = fromInteropTaskConversationState(new ConversationStateStructure({ turns: [new Uint8Array([1])] }))
  const { parentState } = parentStateWith(state)
  const resolved = await resolveSubagentConversationState(createContext(), {}, parentState, undefined, true, "call-1", "generalPurpose")
  assert.equal(resolved, state)
})

test("a resumed subagent starts from the conversation it was saved with", async () => {
  const saved = fromInteropTaskConversationState(new ConversationStateStructure({ turns: [new Uint8Array([2])] }))
  const parentState = {
    async getConversationState() { return fromInteropTaskConversationState(new ConversationStateStructure()) },
    restoreSubagentState() { return restoredState({ conversationSnapshot: saved }) },
  }
  const resolved = await resolveSubagentConversationState(createContext(), {}, parentState, "subagent-1", false, "call-1", "generalPurpose")
  assert.equal(resolved, saved)
})

test("a resumed cloud subagent with no saved conversation starts from nothing", async () => {
  const parentState = {
    async getConversationState() { return fromInteropTaskConversationState(new ConversationStateStructure({ turns: [new Uint8Array([3])] })) },
    restoreSubagentState() { return restoredState({ cloudAgent: { agentId: "bc-1" } }) },
  }
  const resolved = await resolveSubagentConversationState(createContext(), {}, parentState, "subagent-1", false, "call-1", "generalPurpose")
  assert.deepEqual(resolved.turns, [])
})

test("a fresh subagent starts from the parent's conversation as its type maps it", async () => {
  const parent = fromInteropTaskConversationState(new ConversationStateStructure({ turns: [new Uint8Array([4])] }))
  const mapped = fromInteropTaskConversationState(new ConversationStateStructure({ turns: [new Uint8Array([5])] }))
  const parentState = {
    async getConversationState() { return parent },
    restoreSubagentState() { return restoredState() },
  }
  let mapperCalls = 0
  const resolved = await resolveSubagentConversationState(
    createContext(),
    { conversationStateMapper: () => { mapperCalls += 1; return mapped } },
    parentState,
    undefined,
    false,
    "call-1",
    "generalPurpose",
  )
  assert.equal(resolved, mapped)
  assert.equal(mapperCalls, 1)
})

test("a resumed subagent's model is only usable when it is not blocked and the mode allows it", async () => {
  assert.equal(await isPriorSubagentModelUsable("m1", { isModelBlocked: () => true, parentMaxMode: true }), false)
  assert.equal(await isPriorSubagentModelUsable("m1", { isModelBlocked: () => false, parentMaxMode: true }), true)
  assert.equal(
    await isPriorSubagentModelUsable("m1", { isModelBlocked: () => false, parentMaxMode: false, requiresMaxMode: async () => true }),
    false,
  )
  assert.equal(
    await isPriorSubagentModelUsable("m1", { isModelBlocked: () => false, parentMaxMode: true, requiresMaxMode: async () => true }),
    true,
  )
})

// ---------------------------------------------------------------------------------------------
// resolving a task call into a subagent
// ---------------------------------------------------------------------------------------------

const generalConfig = {
  permissionMode: CustomSubagentPermissionMode.DEFAULT,
  subagentType: createSlateSubagentType(SlateSubagentKind.GENERAL_PURPOSE),
}
const customConfig = {
  permissionMode: CustomSubagentPermissionMode.READONLY,
  subagentType: createSlateSubagentType(SlateSubagentKind.CUSTOM, { customName: "releaseBot" }),
}

const models = createSubagentModels({ standard: { slug: "composer-2" }, fast: { slug: "composer-2-fast" } })

function resolutionArgs(options: {
  rawArgs?: Partial<SlateTaskRequest>
  configs?: readonly unknown[]
  restore?: (subagentId: string) => unknown
  getSubagentIdToResume?: (typeName: string, mode: string) => string | undefined
  policy?: (typeof SubagentModelForcePolicy)[keyof typeof SubagentModelForcePolicy]
  forceModelId?: string
  blocked?: string[]
  parentModelParameters?: readonly unknown[]
} = {}) {
  const restoreCalls: string[] = []
  return {
    restoreCalls,
    ctx: createContext(),
    rawArgs: { prompt: "do the thing", ...options.rawArgs } as SlateTaskRequest,
    meta: { toolCallId: "call-1" },
    subagentConfigs: (options.configs ?? [generalConfig, customConfig]) as never,
    parentState: {
      async getConversationState() { return fromInteropTaskConversationState(new ConversationStateStructure()) },
      restoreSubagentState(_ctx: Context, subagentId: string) {
        restoreCalls.push(subagentId)
        return restoredState((options.restore?.(subagentId) ?? {}) as never)
      },
      ...(options.getSubagentIdToResume === undefined ? {} : { getSubagentIdToResume: options.getSubagentIdToResume }),
    },
    parentModelInfo: { modelName: "composer-2" },
    options: {
      subagentModelForcePolicy: options.policy ?? SubagentModelForcePolicy.None,
      ...(options.forceModelId === undefined ? {} : { forceModelId: options.forceModelId }),
      parentMaxMode: true,
      subagentModels: models,
      isModelBlocked: (modelId: string) => (options.blocked ?? []).includes(modelId),
      isModelValid: (modelId: string) => models.modelsBySlug.has(modelId),
      compareModelCosts: () => 0,
      ...(options.parentModelParameters === undefined ? {} : { parentModelParameters: options.parentModelParameters }),
    },
  }
}

test("a task call with no type at all gets the general purpose one, or the first there is", async () => {
  const resolved = await resolveTaskSubagentConfig(resolutionArgs() as never)
  assert.equal(resolved.typeName, "generalPurpose")
  assert.equal(resolved.analyticsSubagentType, "generalPurpose")
  assert.equal(resolved.isResume, false)
  assert.equal(resolved.resolvedModelId, "composer-2")

  const onlyCustom = await resolveTaskSubagentConfig(resolutionArgs({ configs: [customConfig] }) as never)
  assert.equal(onlyCustom.typeName, "releaseBot")
  // A custom type is counted as custom, whatever it is called.
  assert.equal(onlyCustom.analyticsSubagentType, "custom")
  assert.equal(onlyCustom.effectiveReadonly, true)
  assert.equal(onlyCustom.useAskModeForSubagent, true)
})

test("a call with no subagent types available is refused", async () => {
  await assert.rejects(() => resolveTaskSubagentConfig(resolutionArgs({ configs: [] }) as never), /No subagent types are available\./)
})

test("a type is matched however it was spelled", async () => {
  const resolved = await resolveTaskSubagentConfig(resolutionArgs({ rawArgs: { subagentType: "release-bot" } }) as never)
  assert.equal(resolved.typeName, "releaseBot")
})

test("a type that is not in the catalogue falls back to the default", async () => {
  const resolved = await resolveTaskSubagentConfig(resolutionArgs({ rawArgs: { subagentType: "noSuchAgent" } }) as never)
  assert.equal(resolved.typeName, "generalPurpose")
})

test("the ids a subagent is given are derived from the call", async () => {
  const first = await resolveTaskSubagentConfig(resolutionArgs() as never)
  const second = await resolveTaskSubagentConfig(resolutionArgs() as never)
  assert.equal(first.subagentId, second.subagentId)
  assert.equal(first.subagentRequestId, second.subagentRequestId)
  assert.notEqual(first.subagentId, first.subagentRequestId)
})

test("a resume mode that resumes by itself asks the parent which agent to continue", async () => {
  const configs = [{ ...customConfig, resumeModeOverride: "LAST_AGENT" as const }]
  const args = resolutionArgs({
    configs,
    rawArgs: { subagentType: "releaseBot" },
    getSubagentIdToResume: (typeName, mode) => `${typeName}:${mode}`,
    restore: () => ({ subagentType: customConfig.subagentType, modelId: "composer-2-fast" }),
  })
  const resolved = await resolveTaskSubagentConfig(args as never)
  assert.deepEqual(args.restoreCalls, ["releaseBot:LAST_AGENT"])
  assert.equal(resolved.isResume, true)
  assert.equal(resolved.subagentIdToResume, "releaseBot:LAST_AGENT")
  // A resumed subagent keeps the model it was running on.
  assert.equal(resolved.resolvedModelId, "composer-2-fast")
})

test("an explicit resume names the agent to continue, and its type comes from the saved state", async () => {
  const args = resolutionArgs({
    rawArgs: { subagentType: "generalPurpose", resume: "subagent-9" },
    restore: () => ({ subagentType: customConfig.subagentType }),
  })
  const resolved = await resolveTaskSubagentConfig(args as never)
  assert.deepEqual(args.restoreCalls, ["subagent-9"])
  assert.equal(resolved.subagentIdToResume, "subagent-9")
  assert.equal(resolved.subagentId, "subagent-9")
  assert.equal(resolved.typeName, "releaseBot")
})

test("resuming an agent whose type is gone is refused rather than started as something else", async () => {
  await assert.rejects(
    () => resolveTaskSubagentConfig(resolutionArgs({
      rawArgs: { resume: "subagent-9" },
      restore: () => ({ subagentType: createSlateSubagentType(SlateSubagentKind.CUSTOM, { customName: "goneBot" }) }),
    }) as never),
    /Cannot resume subagent of type "goneBot" because that subagent type is not available\./,
  )
})

test("a resume that would contradict the pinned model is refused", async () => {
  await assert.rejects(
    () => resolveTaskSubagentConfig(resolutionArgs({
      rawArgs: { resume: "subagent-9" },
      restore: () => ({ subagentType: generalConfig.subagentType, modelId: "composer-2-fast" }),
      policy: SubagentModelForcePolicy.ParentPin,
      forceModelId: "composer-2",
    }) as never),
    /Cannot resume subagent with model "composer-2-fast" because the active policy requires model "composer-2"\./,
  )
})

test("a resumed model that is blocked is refused", async () => {
  await assert.rejects(
    () => resolveTaskSubagentConfig(resolutionArgs({
      rawArgs: { resume: "subagent-9" },
      restore: () => ({ subagentType: generalConfig.subagentType, modelId: "composer-2-fast" }),
      blocked: ["composer-2-fast"],
    }) as never),
    /Cannot resume subagent with model "composer-2-fast" because it is blocked or unavailable\./,
  )
})

test("a self-fork continues on the parent's model", async () => {
  const resolved = await resolveTaskSubagentConfig(resolutionArgs({ rawArgs: { resume: "self" } }) as never)
  assert.equal(resolved.isSelfForkRequested, true)
  assert.equal(resolved.isResume, false)
  assert.equal(resolved.resolvedModelId, "composer-2")
})

test("the parent's model parameters are carried only when the subagent runs on the parent's model", async () => {
  const same = await resolveTaskSubagentConfig(resolutionArgs({ parentModelParameters: [{ temperature: 0 }] }) as never)
  assert.deepEqual(same.resolvedModelParameters, [{ temperature: 0 }])

  const different = await resolveTaskSubagentConfig(resolutionArgs({
    rawArgs: { model: "composer-2-fast" },
    parentModelParameters: [{ temperature: 0 }],
  }) as never)
  assert.equal(different.resolvedModelId, "composer-2-fast")
  assert.equal(different.resolvedModelParameters, undefined)
})

test("where the subagent runs follows the request, then the saved state, then the cloud fields", async () => {
  const cloud = await resolveTaskSubagentConfig(resolutionArgs({ rawArgs: { environment: "cloud", cloudBaseBranch: "main" } }) as never)
  assert.equal(cloud.effectiveEnvironment, "cloud")
  assert.deepEqual(cloud.effectiveTargetMachine, { kind: "cloud-machine", baseBranch: "main" })

  const local = await resolveTaskSubagentConfig(resolutionArgs() as never)
  assert.equal(local.effectiveEnvironment, undefined)
  assert.deepEqual(local.effectiveTargetMachine, { kind: "same-device" })
})

test("a resumed cloud run keeps the build it was started with", async () => {
  const resolved = await resolveTaskSubagentConfig(resolutionArgs({
    rawArgs: { resume: "subagent-9", environment: "cloud" },
    restore: () => ({
      subagentType: generalConfig.subagentType,
      cloudAgent: { agentId: "bc-7" },
      requestedRuntimeBuildId: "bld-1",
    }),
  }) as never)
  assert.equal(resolved.cloudAgentId, "bc-7")
  assert.equal(resolved.requestedRuntimeBuildId, "bld-1")
  assert.deepEqual(resolved.effectiveTargetMachine, { kind: "cloud-machine", environmentBuildId: "bld-1" })
})

// ---------------------------------------------------------------------------------------------
// preparing the subagent
// ---------------------------------------------------------------------------------------------

interface AttachmentHarness {
  readonly reads: Array<{ path: string; execId?: string }>
  readonly resourceAccessor: unknown
}

function attachmentHarness(options: {
  data?: Uint8Array
  outputBlobId?: Uint8Array
  failRead?: boolean
} = {}): AttachmentHarness {
  const reads: AttachmentHarness["reads"] = []
  const readExecutor = {
    async execute(_ctx: Context, args: { path: string }, meta: { execId: string }) {
      reads.push({ path: args.path, execId: meta.execId })
      if (options.failRead === true) return { kind: "not-found", path: args.path } satisfies ReadExecutorResult
      const data = options.data ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      return {
        kind: "success",
        path: args.path,
        totalLines: 0,
        fileSize: BigInt(data.length),
        truncated: false,
        rangeApplied: false,
        output: { kind: "data", bytes: data },
        ...(options.outputBlobId === undefined ? {} : { outputBlobId: options.outputBlobId }),
      } satisfies ReadExecutorResult
    },
  }
  const requestContextExecutor = {
    async execute() {
      return {
        result: {
          case: "success",
          value: { requestContext: new RequestContext({ env: { projectFolder: "/repo", workspacePaths: ["/work"] } } as never) },
        },
      }
    },
  }
  return {
    reads,
    resourceAccessor: {
      get: (resource: unknown) => resource === readExecutorResource ? readExecutor : requestContextExecutor,
    },
  }
}

const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

test("an image attachment is read and handed over as the bytes it is", async () => {
  const attachments = attachmentHarness()
  const selected = await buildClientSubagentAttachmentsContext(
    createContext(),
    ["/repo/uploads/diagram.png"],
    attachments.resourceAccessor as never,
    "call-1",
  )
  assert.equal(selected?.selectedImages.length, 1)
  assert.equal(selected?.selectedImages[0]?.mimeType, "image/png")
  assert.equal(selected?.selectedImages[0]?.path, "/repo/uploads/diagram.png")
  assert.equal(selected?.selectedVideos.length, 0)
  // The read is cached under an id derived from the call and the path.
  assert.equal(attachments.reads[0]?.path, "/repo/uploads/diagram.png")
  assert.match(String(attachments.reads[0]?.execId), /^[0-9a-f-]{36}$/)
})

test("an attachment the workspace already addressed by blob id is carried with it", async () => {
  const attachments = attachmentHarness({ outputBlobId: new Uint8Array([7, 7, 7]) })
  const selected = await buildClientSubagentAttachmentsContext(
    createContext(),
    ["/repo/uploads/diagram.png"],
    attachments.resourceAccessor as never,
    "call-1",
  )
  assert.equal(selected?.selectedImages[0]?.dataOrBlobId?.case, "blobIdWithData")
})

test("no attachments means no context at all", async () => {
  const attachments = attachmentHarness()
  assert.equal(await buildClientSubagentAttachmentsContext(createContext(), [], attachments.resourceAccessor as never, "call-1"), undefined)
  assert.deepEqual(attachments.reads, [])
})

test("an attachment that cannot be read is refused rather than skipped", async () => {
  const attachments = attachmentHarness({ failRead: true })
  await assert.rejects(
    () => buildClientSubagentAttachmentsContext(createContext(), ["/repo/uploads/diagram.png"], attachments.resourceAccessor as never, "call-1"),
    /Failed to read attachment: \/repo\/uploads\/diagram\.png/,
  )
})

test("an attachment that is neither an image nor a video is refused", async () => {
  const attachments = attachmentHarness({ data: new TextEncoder().encode("just text") })
  await assert.rejects(
    () => buildClientSubagentAttachmentsContext(createContext(), ["/repo/uploads/notes.txt"], attachments.resourceAccessor as never, "call-1"),
    /Attachment must be image\/\* or video\/\*/,
  )
})

test("a video is refused for a model that cannot watch one", async () => {
  const attachments = attachmentHarness()
  await assert.rejects(
    () => buildClientSubagentAttachmentsContext(createContext(), ["/repo/uploads/clip.mp4"], attachments.resourceAccessor as never, "call-1", {
      resolvedModelId: "composer-2",
    }),
    /Video attachments require a video-capable model/,
  )
})

test("a video outside the session's own folders is refused", async () => {
  const attachments = attachmentHarness()
  await assert.rejects(
    () => buildClientSubagentAttachmentsContext(createContext(), ["/tmp/clip.mp4"], attachments.resourceAccessor as never, "call-1", {
      resolvedModelId: "gemini-2.5-pro",
    }),
    /Attachment path is not trusted: \/tmp\/clip\.mp4/,
  )
})

test("a trusted video is handed over as a video with a frame rate", async () => {
  const attachments = attachmentHarness()
  const selected = await buildClientSubagentAttachmentsContext(
    createContext(),
    ["/repo/uploads/clip.mp4"],
    attachments.resourceAccessor as never,
    "call-1",
    { resolvedModelId: "gemini-2.5-pro" },
  )
  assert.equal(selected?.selectedVideos.length, 1)
  assert.equal(selected?.selectedVideos[0]?.mimeType, "video/mp4")
  assert.equal(selected?.selectedVideos[0]?.fps, 4)
  assert.equal(selected?.selectedVideos[0]?.filename, "clip.mp4")
})

// ---------------------------------------------------------------------------------------------
// the prepared subagent
// ---------------------------------------------------------------------------------------------

async function prepared(options: {
  rawArgs?: Partial<SlateTaskRequest>
  parentCursorCommands?: readonly unknown[]
  subagentCredentials?: SubagentCredentials["credentials"]
  configuredSteps?: readonly string[]
  readonlyShellEnabled?: boolean
  toolName?: string
  attachments?: string[]
  environment?: "cloud" | "local"
} = {}): Promise<{ prepared: SlatePreparedTask; attachments: AttachmentHarness }> {
  const attachments = attachmentHarness()
  const rawArgs = { prompt: "do the thing", description: "the thing", ...options.rawArgs, ...(options.attachments === undefined ? {} : { fileAttachments: options.attachments }) } as SlateTaskRequest
  const resolved = await resolveTaskSubagentConfig({
    ...resolutionArgs({ rawArgs, ...(options.environment === undefined ? {} : { rawArgs: { ...rawArgs, environment: options.environment } }) }),
  } as never)
  const preparedMessage = await prepareTaskSubagent({
    resolved,
    ctx: createContext(),
    rawArgs,
    meta: { toolCallId: "call-1" },
    parentState: {
      async getConversationState() { return fromInteropTaskConversationState(new ConversationStateStructure({ turns: [new Uint8Array([1])] })) },
      restoreSubagentState() { return restoredState() },
    },
    resourceAccessor: attachments.resourceAccessor as never,
    parentModelInfo: { modelName: "composer-2" },
    ...(options.parentCursorCommands === undefined ? {} : { parentCursorCommands: options.parentCursorCommands as never }),
    ...(options.subagentCredentials === undefined ? {} : { subagentCredentials: options.subagentCredentials }),
    ...(options.configuredSteps === undefined ? {} : { configuredSteps: options.configuredSteps }),
    ...(options.readonlyShellEnabled === undefined ? {} : { readonlyShellEnabled: options.readonlyShellEnabled }),
    ...(options.toolName === undefined ? {} : { toolName: options.toolName }),
  })
  return { prepared: preparedMessage, attachments }
}

test("a prepared Slate task carries what the run loop needs to start it", async () => {
  const { prepared: message } = await prepared()
  assert.equal(message.typeName, "generalPurpose")
  assert.equal(message.modelId, "composer-2")
  assert.equal(message.toolCallId, "call-1")
  assert.equal(message.isResuming, false)
  assert.equal(message.prompt, "do the thing")
  assert.equal(message.description, "the thing")
  assert.equal(message.parentModelName, "composer-2")
  // A type that maps nothing out of the parent's conversation starts from an empty structure, and the count
  // says where its own turns begin.
  assert.equal(message.conversationSnapshot.turns.length, 0)
  assert.equal(message.startingTurnCount, 0)
  assert.equal(message.firstMessage.text, "do the thing")
  assert.equal(message.firstMessage.mode, "agent")
  // The defaults a caller can leave out.
  assert.equal(message.allowExecuteHook, false)
  assert.deepEqual(message.configuredSteps, [])
  assert.equal(message.readonlyShellEnabled, false)
  assert.equal(message.toolName, "Task")
  assert.equal(typeof message.preparedAtMs, "bigint")
})

test("the normalized Slate request carries task arguments and placement", async () => {
  const { prepared: message } = await prepared({
    rawArgs: { model: "composer-2-fast", resume: "self", environment: "cloud", cloudBaseBranch: "main", runInBackground: true },
  })
  const raw = message.request
  assert.equal(raw?.prompt, "do the thing")
  assert.equal(raw?.description, "the thing")
  assert.equal(raw?.model, "composer-2-fast")
  assert.equal(raw?.resume, "self")
  assert.equal(raw?.runInBackground, true)
  assert.equal(raw?.cloudBaseBranch, "main")
  assert.equal(raw?.environment, "cloud")
  assert.equal(raw?.targetMachine.kind, "cloud-machine")
  assert.equal(raw?.targetMachine.kind === "cloud-machine" ? raw.targetMachine.baseBranch : undefined, "main")
})

test("credentials are kept for a subagent that runs here, and not for one that runs in the cloud", async () => {
  const local = await prepared({ subagentCredentials: credentials })
  assert.deepEqual(local.prepared.credentials, credentials)

  const cloud = await prepared({ subagentCredentials: credentials, environment: "cloud" })
  assert.equal(cloud.prepared.credentials, undefined)
})

test("the session's own settings are carried onto the subagent", async () => {
  const { prepared: message } = await prepared({
    configuredSteps: ["preToolUse"],
    readonlyShellEnabled: true,
    toolName: "Peek",
  })
  assert.deepEqual(message.configuredSteps, ["preToolUse"])
  assert.equal(message.readonlyShellEnabled, true)
  assert.equal(message.toolName, "Peek")
})

test("the parent's saved commands travel with the subagent", async () => {
  const commands = [{ name: "commit", content: "commit the work" }]
  const { prepared: message } = await prepared({ parentCursorCommands: commands })
  assert.deepEqual(message.attachmentSelection?.commands, commands)
})

test("attachments are read while the subagent is prepared", async () => {
  const { prepared: message, attachments } = await prepared({ attachments: ["/repo/uploads/diagram.png"] })
  assert.equal(message.attachmentSelection?.images.length, 1)
  assert.equal(attachments.reads.length, 1)
})

test("the hook input mirrors the call the way a hook expects to read it", async () => {
  const { prepared: message } = await prepared({
    rawArgs: { environment: "cloud", cloudBaseBranch: "main", runInBackground: false },
    attachments: ["/repo/uploads/diagram.png"],
  })
  const input = buildSlatePreparedTaskHookInput({ typeName: message.typeName, request: message.request })
  assert.equal(input.prompt, "do the thing")
  assert.equal(input.description, "the thing")
  assert.equal(input.environment, "cloud")
  assert.equal(input.cloud_base_branch, "main")
  assert.equal(input.run_in_background, false)
  assert.equal(input.subagent_type, "generalPurpose")
  assert.deepEqual(input.machine, { kind: "cloud-machine", baseBranch: "main" })
  assert.deepEqual(input.file_attachments, ["/repo/uploads/diagram.png"])
})

test("a hook input without a prepared request says only what it knows", () => {
  const input = buildSlatePreparedTaskHookInput({ typeName: "explore" })
  assert.equal(input.subagent_type, "explore")
  assert.equal(input.prompt, undefined)
  assert.equal(input.environment, undefined)
  assert.equal(input.file_attachments, undefined)
})

// ---------------------------------------------------------------------------------------------
// The edges preparation keeps
// ---------------------------------------------------------------------------------------------

test("a sibling of a trusted prefix is not inside it", () => {
  assert.equal(isPathWithinAllowedPrefix({ targetPath: "/root/a", prefix: "/root" }), true);
  assert.equal(isPathWithinAllowedPrefix({ targetPath: "/root", prefix: "/root" }), true);
  assert.equal(isPathWithinAllowedPrefix({ targetPath: "/rootish/a", prefix: "/root" }), false);
  assert.equal(isPathWithinAllowedPrefix({ targetPath: "/other", prefix: "/root" }), false);
});

test("a requested cloud build is trimmed", async () => {
  const resolved = await resolveTaskSubagentConfig(resolutionArgs({
    rawArgs: { environment: "cloud", requestedRuntimeBuildId: " build-1 " },
  }) as never);
  assert.equal((resolved.effectiveTargetMachine as { environmentBuildId?: string }).environmentBuildId, "build-1");
});

