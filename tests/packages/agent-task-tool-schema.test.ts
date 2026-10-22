import { test } from "node:test"
import assert from "node:assert/strict"

import {
  buildTargetMachineField,
  buildTaskParameterSchemas,
  buildTaskToolDescriptionBase,
  buildTaskToolDescriptionParts,
  type TaskSchemaSubagentConfig,
} from "../../source/packages/agent/tools/task-tool-schema.ts"
import { createSubagentModels } from "../../source/packages/agent/tools/core/subagent/models.ts"
import {
  SubagentType,
  SubagentTypeCustom,
  SubagentTypeExplore,
  SubagentTypeUnspecified,
} from "../../source/packages/proto/generated/agent/v1/subagents_pb.ts"

// ---------------------------------------------------------------------------------------------
// the arguments the task tool accepts
// ---------------------------------------------------------------------------------------------

const generalPurpose: TaskSchemaSubagentConfig = { subagent_type: new SubagentType({ type: { case: "unspecified", value: new SubagentTypeUnspecified({}) } }) }
const explore: TaskSchemaSubagentConfig = { subagent_type: new SubagentType({ type: { case: "explore", value: new SubagentTypeExplore({}) } }), description: "Search the codebase." }
const custom: TaskSchemaSubagentConfig = { subagent_type: new SubagentType({ type: { case: "custom", value: new SubagentTypeCustom({ name: "releaseBot" }) } }) }

const models = createSubagentModels({
  standard: { slug: "standard-model" },
  fast: { slug: "fast-model" },
})

const schemasOf = (configs: TaskSchemaSubagentConfig[] = [generalPurpose, explore], options = {}) =>
  buildTaskParameterSchemas(configs, { subagentModels: models, ...options })

interface ZodNode {
  shape?: Record<string, { description?: string }>
  _def?: { options?: Array<{ shape: Record<string, unknown> }>; schema?: unknown; innerType?: unknown; type?: unknown }
}

/** Schemas are wrapped by their refinements, so the object inside is found by walking the wrappers. */
function objectOf(schema: unknown): ZodNode {
  let node = schema as ZodNode | undefined
  for (let depth = 0; depth < 10 && node !== undefined; depth += 1) {
    if (node.shape !== undefined) return node
    if (Array.isArray(node._def?.options)) return node
    const def = node._def
    const next = def?.schema ?? def?.innerType ?? def?.type
    if (next === undefined || typeof next !== "object") break
    node = next as ZodNode
  }
  return {}
}

const fieldsOf = (schema: unknown): string[] => Object.keys(objectOf(schema).shape ?? {})

/** The description of one field, which is what the model is told about that argument. */
function fieldDescription(schema: unknown, field: string): string {
  const fieldSchema = objectOf(schema).shape?.[field]
  if (fieldSchema === undefined) return ""
  // A field wrapped in a preprocessing step keeps its description on the wrapped schema.
  let node = fieldSchema as { description?: string; _def?: { schema?: unknown; innerType?: unknown } }
  for (let depth = 0; depth < 6 && node !== undefined; depth += 1) {
    if (typeof node.description === "string") return node.description
    const next = node._def?.schema ?? node._def?.innerType
    if (next === undefined || typeof next !== "object") break
    node = next as typeof node
  }
  return ""
}

test("the schema the model sees carries the arguments a call may send", () => {
  const schemas = schemasOf()
  assert.deepEqual(fieldsOf(schemas.schemaTowardsModel), ["description", "prompt", "model", "resume", "subagent_type", "file_attachments"])
  assert.deepEqual(fieldsOf(schemas.schemaForParsing), ["description", "prompt", "model", "resume", "subagent_type", "file_attachments"])
})

test("a call without a description is accepted while parsing and refused when written", () => {
  const schemas = schemasOf()
  const written = schemas.schemaTowardsModel.safeParse({ prompt: "do the thing", subagent_type: "generalPurpose" })
  assert.equal(written.success, false)

  const parsed = schemas.schemaForParsing.parse({ prompt: "do the thing", subagent_type: "generalPurpose" })
  assert.equal((parsed as { description: string }).description, "")
})

test("a prompt that is only whitespace is refused", () => {
  const schemas = schemasOf()
  const result = schemas.schemaTowardsModel.safeParse({ description: "tidy", prompt: "   ", subagent_type: "generalPurpose" })
  assert.equal(result.success, false)
  assert.match(JSON.stringify(result.error?.issues), /prompt is required/)
})

test("the subagent type is matched against the catalogue however it was spelled", () => {
  const schemas = schemasOf([generalPurpose, custom])
  const parsed = (value: unknown) => schemas.schemaForParsing.parse({ prompt: "go", subagent_type: value }) as { subagent_type: string }
  assert.equal(parsed("releaseBot").subagent_type, "releaseBot")
  assert.equal(parsed("release-bot").subagent_type, "releaseBot")
  assert.equal(parsed("RELEASE_BOT").subagent_type, "releaseBot")
  // A type named "releaseBotAgent" normalizes to the catalogue entry it names.
  assert.equal(parsed("releaseBotAgent").subagent_type, "releaseBot")
  // A space is part of a name rather than a separator, so this spelling names nothing.
  assert.equal(schemas.schemaForParsing.safeParse({ prompt: "go", subagent_type: "Release Bot" }).success, false)
})

test("a call that names no type gets the general purpose one, or the first one there is", () => {
  // The general-purpose agent wins even when it is not listed first.
  const reversed = buildTaskParameterSchemas([explore, generalPurpose], { subagentModels: models })
  const parsed = reversed.schemaForParsing.safeParse({ prompt: "p" })
  assert.equal(parsed.success && (parsed.data as { subagent_type?: string }).subagent_type, "generalPurpose")
  const withGeneral = schemasOf([generalPurpose, explore])
  assert.equal((withGeneral.schemaForParsing.parse({ prompt: "go" }) as { subagent_type: string }).subagent_type, "generalPurpose")
  assert.equal((withGeneral.schemaForParsing.parse({ prompt: "go", subagent_type: "  " }) as { subagent_type: string }).subagent_type, "generalPurpose")

  const withoutGeneral = schemasOf([explore, custom])
  assert.equal((withoutGeneral.schemaForParsing.parse({ prompt: "go" }) as { subagent_type: string }).subagent_type, "explore")

  const empty = schemasOf([])
  assert.equal((empty.schemaForParsing.parse({ prompt: "go" }) as { subagent_type: string }).subagent_type, "generalPurpose")
})

test("a type that is not in the catalogue is refused with the ones that are", () => {
  const schemas = schemasOf([generalPurpose, explore])
  const result = schemas.schemaForParsing.safeParse({ prompt: "go", subagent_type: "noSuchAgent" })
  assert.equal(result.success, false)
  assert.match(JSON.stringify(result.error?.issues), /Invalid value\. Expected one of: generalPurpose, explore/)

  assert.equal(fieldDescription(schemas.schemaTowardsModel, "subagent_type"), "Subagent type to use for this task. Must be one of: generalPurpose, explore.")
})

test("when the catalogue lives in the user-info message the type is not pinned to a list", () => {
  const schemas = schemasOf([generalPurpose, explore], { subagentModelsInUserInfo: true })
  assert.equal(schemas.schemaTowardsModel.safeParse({ description: "tidy", prompt: "go", subagent_type: "anything" }).success, true)
  // Parsing still checks it against the catalogue, because that is where the lookup happens.
  assert.equal(schemas.schemaForParsing.safeParse({ prompt: "go", subagent_type: "anything" }).success, false)
  assert.equal(fieldDescription(schemas.schemaTowardsModel, "subagent_type"), "Subagent type to use for this task. Available types are listed in the initial user-info message.")
})

test("a null model is read as no model rather than as a value", () => {
  const schemas = schemasOf()
  const parsed = schemas.schemaForParsing.parse({ prompt: "go", model: null }) as { model?: string }
  assert.equal(parsed.model, undefined)
})

test("the interrupt argument is offered only where resuming may interrupt a running agent", () => {
  const without = schemasOf([generalPurpose], { useClientSideSubagent: true })
  assert.equal(fieldsOf(without.schemaTowardsModel).includes("interrupt"), false)

  const with_ = schemasOf([generalPurpose], { useClientSideSubagent: true, enableSubagentInterrupt: true })
  assert.equal(fieldsOf(with_.schemaTowardsModel).includes("interrupt"), true)
})

test("the background argument is offered only where the turn can start one", () => {
  const without = schemasOf([generalPurpose])
  assert.equal(fieldsOf(without.schemaTowardsModel).includes("run_in_background"), false)

  const with_ = schemasOf([generalPurpose], { includeRunInBackgroundInTaskSchema: true })
  assert.equal(fieldsOf(with_.schemaTowardsModel).includes("run_in_background"), true)
  const parsed = with_.schemaForParsing.parse({ prompt: "go", run_in_background: "true" }) as { run_in_background?: boolean }
  assert.equal(parsed.run_in_background, true)
  const parsedFalse = with_.schemaForParsing.parse({ prompt: "go", run_in_background: "false" }) as { run_in_background?: boolean }
  assert.equal(parsedFalse.run_in_background, false)
})

test("what the background argument says about itself follows the session's behaviour", () => {
  const descriptionOf = (options: Record<string, unknown>): string => {
    const schemas = schemasOf([generalPurpose], { includeRunInBackgroundInTaskSchema: true, ...options })
    return fieldDescription(schemas.schemaTowardsModel, "run_in_background")
  }
  assert.doesNotMatch(descriptionOf({}), /Defaults true/)
  assert.match(descriptionOf({ defaultSubagentsRunInBackground: true }), /Defaults true\./)
  assert.match(descriptionOf({ enableMultitaskMode: true }), /If the user is currently in Multitask Mode, always set this parameter to True\./)
  assert.match(descriptionOf({ taskToolNotificationHintsEnabled: true }), /the background subagent will send a notification when it completes/)
})

test("placement is offered as a machine object to a session that targets cloud machines", () => {
  const cloud = schemasOf([generalPurpose], { environmentParamForSubagent: true, cloudSubagentTargeting: true })
  assert.equal(fieldsOf(cloud.schemaTowardsModel).includes("machine"), true)
  assert.equal(fieldsOf(cloud.schemaTowardsModel).includes("environment"), false)
  // The older fields are still accepted while parsing, so a prompt written before the change still runs.
  assert.equal(fieldsOf(cloud.schemaForParsing).includes("environment"), true)
  assert.equal(fieldsOf(cloud.schemaForParsing).includes("cloud_base_branch"), true)

  const legacy = schemasOf([generalPurpose], { environmentParamForSubagent: true })
  assert.equal(fieldsOf(legacy.schemaTowardsModel).includes("environment"), true)
  assert.equal(fieldsOf(legacy.schemaTowardsModel).includes("machine"), false)
  assert.equal(fieldsOf(legacy.schemaForParsing).includes("machine"), true)
})

test("a placement field without the cloud environment is refused rather than dropped", () => {
  const schemas = schemasOf([generalPurpose], { environmentParamForSubagent: true })
  const rejected = schemas.schemaForParsing.safeParse({ prompt: "go", cloud_base_branch: "main" })
  assert.equal(rejected.success, false)
  assert.match(JSON.stringify(rejected.error?.issues), /cloud_base_branch may only be specified when environment equals cloud/)

  const accepted = schemas.schemaForParsing.safeParse({ prompt: "go", environment: "cloud", cloud_base_branch: "main" })
  assert.equal(accepted.success, true)

  const local = schemas.schemaForParsing.safeParse({ prompt: "go", environment: "local" })
  assert.equal(local.success, true)
})

test("the environment build argument follows the same rule", () => {
  const schemas = schemasOf([generalPurpose], { environmentParamForSubagent: true, requestedEnvironmentBuildParamForSubagent: true })
  assert.equal(fieldsOf(schemas.schemaTowardsModel).includes("cloud_requested_environment_build_id"), true)
  const rejected = schemas.schemaForParsing.safeParse({ prompt: "go", cloud_requested_environment_build_id: "bld-1" })
  assert.equal(rejected.success, false)
  assert.match(JSON.stringify(rejected.error?.issues), /cloud_requested_environment_build_id may only be specified when environment equals cloud/)
})

// ---------------------------------------------------------------------------------------------
// where a subagent may be placed
// ---------------------------------------------------------------------------------------------

function placementOptions(field: unknown): Array<{ shape: Record<string, unknown> }> {
  return objectOf(field)._def?.options ?? []
}

test("the placement field offers this machine and a cloud VM by default", () => {
  const field = buildTargetMachineField({ includeEnvironmentBuildId: false, includeSelfHostedTargets: false })
  const options = placementOptions(field)
  assert.deepEqual(options.map(option => (option.shape.type as { value: string }).value), ["same_machine", "new_cloud_vm"])
  assert.equal(options[1]?.shape.environment_build_id, undefined)
})

test("a session that targets self-hosted machines is offered them too", () => {
  const field = buildTargetMachineField({ includeEnvironmentBuildId: true, includeSelfHostedTargets: true })
  const options = placementOptions(field)
  assert.deepEqual(
    options.map(option => (option.shape.type as { value: string }).value),
    ["same_machine", "new_cloud_vm", "self_hosted_worker", "self_hosted_pool"],
  )
  assert.notEqual(options[1]?.shape.environment_build_id, undefined)
})

test("a placement with no type is read as this machine", () => {
  const field = buildTargetMachineField({ includeEnvironmentBuildId: false, includeSelfHostedTargets: true })
  assert.equal(field.safeParse(undefined).success, true)
  assert.equal(field.safeParse({ type: "self_hosted_worker", worker_id: "worker-1" }).success, true)
  assert.equal(field.safeParse({ type: "self_hosted_worker" }).success, false)
  assert.equal(field.safeParse({ type: "self_hosted_worker", worker_id: "worker-1", extra: true }).success, false)

  const legacy = buildTargetMachineField({ includeEnvironmentBuildId: false, includeSelfHostedTargets: false })
  assert.equal(legacy.safeParse({ type: "self_hosted_worker", worker_id: "worker-1" }).success, false)
})

test("a blank base branch is read as no base branch", () => {
  const field = buildTargetMachineField({ includeEnvironmentBuildId: false, includeSelfHostedTargets: false })
  const parsed = field.parse({ type: "new_cloud_vm", base_branch: "   " }) as { base_branch?: string }
  assert.equal(parsed.base_branch, undefined)
})

// ---------------------------------------------------------------------------------------------
// what the tool says about itself
// ---------------------------------------------------------------------------------------------

const baseArgs = { toolLabel: "Task", readToolName: "Read", globToolName: "Glob" }

test("the base description points at the read and search tools for work they do better", () => {
  const text = buildTaskToolDescriptionBase(baseArgs)
  assert.match(text, /If you want to read a specific file path, use the Read or Glob tool instead of the Task tool/)
  assert.match(text, /If you are searching for a specific class definition like "class Foo", use the Glob tool instead of the Task tool/)
  assert.match(text, /Always include a short description \(3-5 words\)/)
})

test("the base description only names the tools the session actually has", () => {
  const onlyRead = buildTaskToolDescriptionBase({ toolLabel: "Task", readToolName: "Read" })
  assert.match(onlyRead, /use the Read tool instead of the Task tool/)
  assert.doesNotMatch(onlyRead, /Glob/)

  const noTools = buildTaskToolDescriptionBase({ toolLabel: "Task" })
  assert.doesNotMatch(noTools, /instead of the Task tool, to find the match more quickly/)
})

test("the explore recommendation is made only where exploring is worth recommending", () => {
  const recommended = buildTaskToolDescriptionBase({ ...baseArgs, includeExploreSubagent: true })
  assert.match(recommended, /VERY IMPORTANT: When broadly exploring the codebase/)
  assert.match(recommended, /subagent_type="explore"/)

  const notRecommended = buildTaskToolDescriptionBase({ ...baseArgs, includeExploreSubagent: true, subagentExperimentGroup: "no-subagent-unless-asked" })
  assert.doesNotMatch(notRecommended, /VERY IMPORTANT/)
  assert.match(notRecommended, /If the query is a narrow or specific question/)

  const catalogueElsewhere = buildTaskToolDescriptionBase({ ...baseArgs, includeExploreSubagent: true, subagentModelsInUserInfo: true })
  assert.doesNotMatch(catalogueElsewhere, /VERY IMPORTANT/)

  const withoutExplore = buildTaskToolDescriptionBase({ ...baseArgs, includeExploreSubagent: false })
  assert.doesNotMatch(withoutExplore, /subagent_type="explore"/)
})

test("the description tells the model what happens to a subagent's result", () => {
  const defaultText = buildTaskToolDescriptionBase(baseArgs)
  assert.match(defaultText, /The result returned by the agent is not visible to the user\./)

  const notified = buildTaskToolDescriptionBase({ ...baseArgs, taskToolNotificationHintsEnabled: true })
  assert.match(notified, /do not summarize or restate a single background subagent's result by default/)

  const hidden = buildTaskToolDescriptionBase({ ...baseArgs, taskToolNotificationHintsEnabled: true, hideAsyncSubagentTaskNotifications: true })
  assert.doesNotMatch(hidden, /do not summarize or restate/)
})

test("the description says whether resuming may interrupt a running agent", () => {
  const serverSide = buildTaskToolDescriptionBase(baseArgs)
  assert.match(serverSide, /the agent continues with its full previous context preserved/)

  const clientSide = buildTaskToolDescriptionBase({ ...baseArgs, useClientSideSubagent: true })
  assert.match(clientSide, /If the agent is still running, the request fails; wait for completion before resuming\./)

  const interruptible = buildTaskToolDescriptionBase({ ...baseArgs, useClientSideSubagent: true, enableSubagentInterrupt: true })
  assert.match(interruptible, /the request fails unless `interrupt` is true/)
})

test("the description offers forking the current conversation only where it is allowed", () => {
  assert.doesNotMatch(buildTaskToolDescriptionBase(baseArgs), /fork the current parent agent/)
  const forking = buildTaskToolDescriptionBase({ ...baseArgs, allowResumeSelfFork: true })
  assert.match(forking, /set `resume` to "self" to fork the current parent agent into a new child subagent/)

  // The argument itself says what the sentinel means, which is where a model reading the schema finds it.
  assert.doesNotMatch(fieldDescription(schemasOf([generalPurpose]).schemaTowardsModel, "resume"), /self-fork/)
  const schemaWithFork = schemasOf([generalPurpose], { allowResumeSelfFork: true }).schemaTowardsModel
  assert.match(fieldDescription(schemaWithFork, "resume"), /Use "self" to start a new agent with your own entire conversation history as a starting point \(aka 'self-fork'\)\./)
})

test("the description links to agents only where links work", () => {
  assert.doesNotMatch(buildTaskToolDescriptionBase(baseArgs), /you may link to agents and subagents/)
  assert.match(buildTaskToolDescriptionBase({ ...baseArgs, enableAgentChatLinks: true }), /you may link to agents and subagents with the `\[Name\]\(id\)` format\./)
})

test("the catalogue of subagent types is listed, or pointed at when it lives in the user-info message", () => {
  const listed = buildTaskToolDescriptionParts({ ...baseArgs, subagentModels: models, configs: [generalPurpose, explore], defaultResumeMode: "DEFAULT" })
  assert.match(listed.subagentTypeDescriptionsText, /^- generalPurpose$/m)
  assert.match(listed.subagentTypeDescriptionsText, /^- explore: Search the codebase\.$/m)
  assert.match(listed.fullDescription, /Available subagent_types and a quick description of what they do:/)
  assert.match(listed.fullDescription, /standard-model/)

  const pointedAt = buildTaskToolDescriptionParts({ ...baseArgs, subagentModels: models, configs: [generalPurpose, explore], defaultResumeMode: "DEFAULT", catalogsInUserInfo: true })
  assert.match(pointedAt.fullDescription, /Available subagent_types and descriptions are listed in <available_subagent_types> in the initial user-info message at the start of this conversation\./)
  assert.match(pointedAt.fullDescription, /Available model slugs for subagents are listed in <available_subagent_models> in the initial user-info message at the start of this conversation\./)
  const pointsByDefault = buildTaskToolDescriptionParts({ ...baseArgs, subagentModels: models, configs: [generalPurpose, explore], defaultResumeMode: "DEFAULT", subagentModelsInUserInfo: true })
  assert.match(pointsByDefault.fullDescription, /listed in <available_subagent_types> in the initial user-info message/, "the user-info message is where the catalogues live when that setting says so")
  // The catalogue text is still produced, because a caller may want to render it elsewhere.
  assert.match(pointedAt.subagentTypeDescriptionsText, /^- explore: Search the codebase\.$/m)
})

test("a type that resumes by itself says so beside its name", () => {
  const listed = buildTaskToolDescriptionParts({ ...baseArgs, subagentModels: models, configs: [explore, custom], defaultResumeMode: "LAST_AGENT" })
  assert.match(listed.subagentTypeDescriptionsText, /^- explore: Search the codebase\. \(Auto-resumes most recent agent; `resume` arg is ignored\)$/m)
  // A type with no description of its own gets the note where its description would be, spacing and all.
  assert.match(listed.subagentTypeDescriptionsText, /^- releaseBot: +\(Auto-resumes most recent agent; `resume` arg is ignored\)$/m)

  const sameType = buildTaskToolDescriptionParts({ ...baseArgs, subagentModels: models, configs: [explore], defaultResumeMode: "LAST_AGENT_SAME_TYPE" })
  assert.match(sameType.subagentTypeDescriptionsText, /Auto-resumes most recent agent of this type/)

  const overridden = buildTaskToolDescriptionParts({ ...baseArgs, subagentModels: models, configs: [{ ...explore, resumeModeOverride: "DEFAULT" }], defaultResumeMode: "LAST_AGENT" })
  assert.doesNotMatch(overridden.subagentTypeDescriptionsText, /Auto-resumes/)

  const noCatalogue = buildTaskToolDescriptionParts({ ...baseArgs, subagentModels: models, configs: [], defaultResumeMode: "DEFAULT" })
  assert.equal(noCatalogue.subagentTypeDescriptionsText, "")
  assert.doesNotMatch(noCatalogue.fullDescription, /Available subagent_types/)
})

test("the parts description passes the session's own names and flags through to the base", () => {
  const parts = buildTaskToolDescriptionParts({
    ...baseArgs,
    subagentModels: models,
    configs: [generalPurpose, explore],
    defaultResumeMode: "DEFAULT",
    readToolName: "Read",
    globToolName: "Glob",
    allowResumeSelfFork: true,
    enableAgentChatLinks: true,
  })
  assert.match(parts.baseDescription, /Read or Glob/)
  assert.match(parts.baseDescription, /fork the current parent agent/)
  assert.equal(parts.fullDescription, [parts.baseDescription, parts.subagentTypeDescriptionsText, parts.modelsDescription].join("\n\n"), "the full description is the three parts, in order")
})

test("the models section says to skip rather than substitute when the model is not offered", () => {
  const parts = buildTaskToolDescriptionParts({ ...baseArgs, subagentModels: models, configs: [generalPurpose], defaultResumeMode: "DEFAULT" })
  assert.match(parts.modelsDescription, /standard-model/)
  assert.match(parts.fullDescription, /do NOT substitute a different model or guess/)

  const inheriting = buildTaskToolDescriptionParts({ ...baseArgs, subagentModels: models, configs: [generalPurpose], defaultResumeMode: "DEFAULT", subagentInheritGuidance: true })
  assert.match(inheriting.modelsDescription, /inherit \(default; required unless the user explicitly requested another model\)/)

  const noModels = buildTaskToolDescriptionParts({
    ...baseArgs,
    configs: [generalPurpose],
    defaultResumeMode: "DEFAULT",
    subagentModels: createSubagentModels({}),
  })
  assert.equal(noModels.modelsDescription, "No alternative models are available. Subagents will inherit the parent model.")
})
