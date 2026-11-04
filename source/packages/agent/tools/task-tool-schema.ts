/**
 * The task tool's arguments, and the words that explain them.
 *
 * The tool hands work to a subagent, so almost everything here is a choice the model has to make: which
 * kind of subagent, what model, where it runs, whether it is resumed, whether it runs in the background.
 * Those choices arrive as the same schema in two forms. The form the model is shown declares only what it
 * is allowed to send — an unknown placement is not offered, and the subagent type is a free string when
 * the catalogue lives in the user-info message instead of in the tool. The form used for parsing is the
 * same schema with the defaults applied, and it accepts the legacy placement fields that older prompts
 * send so a call written against them still runs. A call that names a placement field while asking for the
 * local machine is refused rather than ignored, because a silently dropped placement would run the work
 * somewhere the model did not intend.
 *
 * The description is built from the same options, because what the tool says about itself has to match
 * what it accepts: whether the subagent list and the model list are inlined or live in the user-info
 * message, whether resuming may interrupt a running agent, whether a background result is already visible
 * to the user, and whether a fork of the current conversation is allowed. Those are the differences that
 * change what the model should do, so they change the text.
 */

import { z } from "zod"

import { GENERAL_PURPOSE_SUBAGENT_TYPE, normalizeSubagentTypeName } from "./core/subagent/subagent-config.ts"
import { buildAvailableModelsDescription, type SubagentModels } from "./core/subagent/models.ts"

const EXPLORE_SUBAGENT_TYPE = "explore"
/** The value that means "fork this conversation" rather than naming an existing agent. */
const RESUME_SELF_SENTINEL = "self"

export type TaskResumeMode = "DEFAULT" | "LAST_AGENT" | "LAST_AGENT_SAME_TYPE"

export interface TaskSchemaSubagentConfig {
  readonly typeName: string
  readonly description?: string | undefined
  readonly resumeModeOverride?: TaskResumeMode | undefined
}

export interface TaskPlacementSchemaOptions {
  readonly includeEnvironmentBuildId: boolean
  readonly includeSelfHostedTargets: boolean
}

export interface TaskParametersSchemaOptions {
  readonly allowCustomModelId?: boolean
  readonly subagentModels?: SubagentModels
  readonly subagentModelsInUserInfo?: boolean
  readonly subagentInheritGuidance?: boolean
  readonly useClientSideSubagent?: boolean
  readonly includeRunInBackgroundInTaskSchema?: boolean
  readonly defaultSubagentsRunInBackground?: boolean
  readonly enableSubagentInterrupt?: boolean
  readonly environmentParamForSubagent?: boolean
  readonly requestedEnvironmentBuildParamForSubagent?: boolean
  readonly cloudSubagentTargeting?: boolean
  readonly allowResumeSelfFork?: boolean
  readonly enableMultitaskMode?: boolean
  readonly taskToolNotificationHintsEnabled?: boolean
  readonly hideAsyncSubagentTaskNotifications?: boolean
  readonly enableAgentChatLinks?: boolean
}

export interface TaskParameterSchemas {
  readonly schemaTowardsModel: z.ZodTypeAny
  readonly schemaForParsing: z.ZodTypeAny
}

/** A blank string is what a model sends when it means "nothing", so it is read as nothing. */
const blankToUndefined = (value: unknown): unknown => typeof value === "string" && value.trim() === "" ? undefined : value

const sameMachineSchema = z.object({ type: z.literal("same_machine") }).strict().describe("Use the current machine and its existing checkout. This is the normal placement.")

const selfHostedWorkerSchema = z.object({
  type: z.literal("self_hosted_worker"),
  worker_id: z.string().min(1).describe("ID returned by slate-cloud-list-self-hosted-workers. This target is for a machine you own; choose self_hosted_pool for a team worker. Check sharedAssignmentAllowed first: when sharing is enabled this agent can run beside other work, otherwise it waits until the worker is available."),
}).strict().describe("Choose one of your own self-hosted workers. It keeps that worker's checkout and branch, so no base branch can be supplied.")

const selfHostedPoolSchema = z.object({
  type: z.literal("self_hosted_pool"),
  pool: z.string().optional().describe("Worker pool to use; omitting it selects the team's default pool."),
  labels: z.record(z.string()).optional().describe("Every key/value pair must match the worker's labels."),
}).strict().describe("Select an available worker from a team pool. A worker serves one run at a time, so this request waits in the queue when all are busy.")

export function buildTargetMachineField(options: TaskPlacementSchemaOptions): z.ZodTypeAny {
  const newCloudVmSchema = z.object({
    type: z.literal("new_cloud_vm"),
    base_branch: z.preprocess(blankToUndefined, z.string().optional().describe("Starting point for the agent's generated branch. The current branch is used by default. Cloud runs use the remote copy, which does not include local uncommitted or unpushed changes.")),
    ...(options.includeEnvironmentBuildId ? {
      environment_build_id: z.preprocess(blankToUndefined, z.string().optional().describe("Boot this VM from the specified build (for example, bld-YYYYMMDD-<uuid>) instead of the latest successful one. The build must be accessible within this team and environment; an unknown or unrelated ID makes the run fail.")),
    } : {}),
  }).strict().describe("Create a cloud VM with a separate clone and generated branch. When it finishes, follow the user's direction about merging or checking out that branch.")
  const description = "Where the agent should run. Leave this out for the usual local run. Use a cloud VM or named worker only when the user asks for that placement."
  if (options.includeSelfHostedTargets) {
    return z.discriminatedUnion("type", [sameMachineSchema, newCloudVmSchema, selfHostedWorkerSchema, selfHostedPoolSchema]).optional().describe(description)
  }
  return z.discriminatedUnion("type", [sameMachineSchema, newCloudVmSchema]).optional().describe(description)
}

/** A string that has to be one of a fixed set, said so the model can see the set. */
function stringChoice(values: string[], description: string): z.ZodType<string> {
  return z.string().refine(value => values.includes(value), {
    message: `Invalid value. Expected one of: ${values.join(", ")}`,
  }).describe(description)
}

export function buildTaskParameterSchemas(configs: readonly TaskSchemaSubagentConfig[], options: TaskParametersSchemaOptions): TaskParameterSchemas {
  const inheritGuidance = options.subagentInheritGuidance ?? options.subagentModelsInUserInfo === true
  const baseModelDescription = inheritGuidance
    ? "Optional available model slug. Keep the parent's model by default; select another only when the user names one. Leave this unset when continuing a saved agent, which keeps its prior model. Use \"inherit\" for the default choice."
    : "Optional available model slug. Leaving it blank uses the parent's model. A resumed agent keeps its saved model, so omit this field. Pick a different model only at the user's request."
  const configNames = configs.map(config => config.typeName)
  // The catalogue is matched case- and separator-insensitively, but the value that goes forward is the
  // catalogue's own spelling, because that is what the rest of the turn looks subagents up by.
  const normalizedToCanonical = new Map<string, string>()
  for (const canonicalName of configNames) normalizedToCanonical.set(normalizeSubagentTypeName(canonicalName), canonicalName)
  const defaultSubagentTypeName = configNames.includes(GENERAL_PURPOSE_SUBAGENT_TYPE) ? GENERAL_PURPOSE_SUBAGENT_TYPE : configNames[0] ?? GENERAL_PURPOSE_SUBAGENT_TYPE
  const preprocessSubagentType = (value: unknown): unknown => {
    if (value === undefined) return defaultSubagentTypeName
    if (typeof value !== "string") return value
    const trimmed = value.trim()
    if (trimmed.length === 0) return defaultSubagentTypeName
    return normalizedToCanonical.get(normalizeSubagentTypeName(trimmed)) ?? trimmed
  }
  const typeDescription = options.subagentModelsInUserInfo === true
    ? "Agent type for this task. The available choices appear in the opening user-info message."
    : `Agent type for this task. Choose one of: ${configNames.join(", ")}.`
  const parsingSubagentTypeField = z.preprocess(preprocessSubagentType, stringChoice(configNames.length > 0 ? configNames : [GENERAL_PURPOSE_SUBAGENT_TYPE], typeDescription))
  // When the catalogue is in the user-info message the model may not be shown a fixed set, so the type it
  // sends is only checked against the catalogue while parsing, not while being written.
  const modelFacingSubagentTypeField = options.subagentModelsInUserInfo === true
    ? z.preprocess(preprocessSubagentType, z.string().describe(typeDescription))
    : parsingSubagentTypeField
  const promptField = z.string().refine(value => value.trim().length > 0, { message: "prompt is required" }).describe("Instructions for the agent's work")
  const modelField = z.preprocess(value => value === null ? undefined : value, z.string().optional()).describe(baseModelDescription)
  const baseResumeDescription = options.useClientSideSubagent
    ? `Optional ID of a finished agent to continue. It receives a follow-up after completion. A request against a running agent ${options.enableSubagentInterrupt ? "is rejected unless `interrupt` is true; use that flag only when the user asks to stop its current run." : "is rejected; wait for that run to finish first."}`
    : "Optional ID of a prior agent. Continuing it restores the transcript from its earlier run."
  const resumeFieldDescription = options.allowResumeSelfFork ? `${baseResumeDescription} Set \"${RESUME_SELF_SENTINEL}\" to create a new agent with a copy of this conversation's history.` : baseResumeDescription
  const resumeField = z.string().optional().describe(resumeFieldDescription)
  const interruptField = z.boolean().optional().describe("When true, stop the active run named by `resume` and deliver this prompt now. Use it only if the user asks to interrupt or redirect that run.")
  const fileAttachmentsField = z.array(z.string()).optional().describe("Image or video paths to attach for a media-review agent. The files become part of its context; use this to pass along relevant media the user supplied.")
  const environmentField = z.enum(["local", "cloud"]).optional().describe('Run the agent locally by default. Choose "cloud" only when the user requests it; the agent then works in a separate VM and branch. Follow the user\'s instructions about that branch when the run ends.')
  const cloudBaseBranchField = z.preprocess(blankToUndefined, z.string().optional().describe("Remote branch from which the cloud run creates its branch. The current branch is assumed when omitted. Only remote commits are available, so leave local-only changes out. Set this only with cloud placement."))
  const cloudRequestedEnvironmentBuildIdField = z.preprocess(blankToUndefined, z.string().optional().describe("Build ID (for example, bld-YYYYMMDD-<uuid>) for the cloud VM to use instead of the environment's latest successful build. Set it only with cloud placement. It must be a build from this team and environment, or the run will fail."))
  const machineField = buildTargetMachineField({
    includeEnvironmentBuildId: options.requestedEnvironmentBuildParamForSubagent === true,
    includeSelfHostedTargets: options.cloudSubagentTargeting === true,
  })

  /** Accept the previous placement fields when reading older model prompts. */
  const legacyPlacementFields = {
    environment: environmentField,
    cloud_base_branch: cloudBaseBranchField,
    ...(options.requestedEnvironmentBuildParamForSubagent ? { cloud_requested_environment_build_id: cloudRequestedEnvironmentBuildIdField } : {}),
  }
  /** Advertise the active placement shape; keep accepting the legacy fields during parsing. */
  const placementFieldsFor = (forParsing: boolean): Record<string, z.ZodTypeAny> => {
    if (options.cloudSubagentTargeting === true) return { machine: machineField, ...(forParsing ? legacyPlacementFields : {}) }
    return { ...legacyPlacementFields, ...(forParsing ? { machine: machineField } : {}) }
  }
  /** Reject cloud-only details unless the caller selected a cloud run. */
  const rejectPlacementWithoutCloud = (args: Record<string, unknown>, ctx: z.RefinementCtx): void => {
    if ("environment" in args && args.environment === "cloud") return
    if ("cloud_base_branch" in args && args.cloud_base_branch !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cloud_base_branch"], message: "cloud_base_branch may only be specified when environment equals cloud" })
    if ("cloud_requested_environment_build_id" in args && args.cloud_requested_environment_build_id !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cloud_requested_environment_build_id"], message: "cloud_requested_environment_build_id may only be specified when environment equals cloud" })
  }

  const buildSchema = (descriptionField: z.ZodTypeAny, subagentTypeField: z.ZodTypeAny, forParsing: boolean): z.ZodTypeAny => {
    const baseObjectSchema = z.object({ description: descriptionField, prompt: promptField, model: modelField, resume: resumeField, subagent_type: subagentTypeField, file_attachments: fileAttachmentsField })
    const schemaWithEnvironment = !options.environmentParamForSubagent
      ? baseObjectSchema
      : baseObjectSchema.extend(placementFieldsFor(forParsing))
    const schemaWithInterrupt = options.useClientSideSubagent && options.enableSubagentInterrupt ? schemaWithEnvironment.extend({ interrupt: interruptField }) : schemaWithEnvironment
    const objectSchema = options.includeRunInBackgroundInTaskSchema === true
      ? schemaWithInterrupt.extend({
        run_in_background: z.preprocess(value => value === "true" ? true : value === "false" ? false : value, z.boolean()).optional().describe("Start without waiting and return an output_file path for later checks." + (options.defaultSubagentsRunInBackground === true ? " Defaults true." : "") + " Set false to wait for the result before continuing." + (options.enableMultitaskMode ? " During Multitask Mode, set this to True." : "") + (options.taskToolNotificationHintsEnabled ? " A notification arrives when the background run completes." : "")),
      })
      : schemaWithInterrupt
    return objectSchema.superRefine(rejectPlacementWithoutCloud)
  }
  const descriptionFieldDescription = "A concise, recognizable title shown for this agent in the UI. Avoid reusing a recent title. When redirecting a resumed agent to a different task, describe its new work; keep the existing title when it continues the same larger task."
  return {
    schemaTowardsModel: buildSchema(z.string().describe(descriptionFieldDescription), modelFacingSubagentTypeField, false),
    // The parsing schema defaults the description, because a call without one is still a call.
    schemaForParsing: buildSchema(z.string().default("").describe(descriptionFieldDescription), parsingSubagentTypeField, true),
  }
}

export interface TaskDescriptionPartsOptions {
  readonly configs: readonly TaskSchemaSubagentConfig[]
  readonly defaultResumeMode: TaskResumeMode
  readonly includeExploreSubagent?: boolean
  readonly useClientSideSubagent?: boolean
  readonly enableSubagentInterrupt?: boolean
  readonly taskToolNotificationHintsEnabled?: boolean
  readonly hideAsyncSubagentTaskNotifications?: boolean
  readonly allowResumeSelfFork?: boolean
  readonly enableAgentChatLinks?: boolean
  readonly subagentModels: SubagentModels
  readonly subagentModelsInUserInfo?: boolean
  readonly subagentInheritGuidance?: boolean
  readonly catalogsInUserInfo?: boolean
  readonly toolLabel: string
  readonly readToolName?: string
  readonly globToolName?: string
  readonly subagentExperimentGroup?: string
}

export interface TaskDescriptionParts {
  readonly baseDescription: string
  readonly subagentTypeDescriptionsText: string
  readonly modelsDescription: string
  readonly fullDescription: string
}

interface TaskDescriptionBaseOptions {
  readonly includeExploreSubagent?: boolean | undefined
  readonly subagentModelsInUserInfo?: boolean | undefined
  readonly useClientSideSubagent?: boolean | undefined
  readonly enableSubagentInterrupt?: boolean | undefined
  readonly taskToolNotificationHintsEnabled?: boolean | undefined
  readonly hideAsyncSubagentTaskNotifications?: boolean | undefined
  readonly allowResumeSelfFork?: boolean | undefined
  readonly enableAgentChatLinks?: boolean | undefined
  readonly toolLabel: string
  readonly readToolName?: string | undefined
  readonly globToolName?: string | undefined
  readonly subagentExperimentGroup?: string | undefined
}

/** What a resumed agent does this turn: resume it, or answer with why it cannot be resumed. */
function resumeBehaviorFor(args: TaskDescriptionBaseOptions): string {
  return args.useClientSideSubagent ? args.enableSubagentInterrupt ? "A finished agent receives this follow-up with its context intact. An active run can be stopped first by setting `interrupt` to true; do so only at the user's explicit direction." : "A finished agent receives this follow-up with its context intact. An active run cannot be resumed yet, so wait for it to finish." : "Continuing an agent restores its earlier conversation."
}

/** The note about where a background result goes, when notifications are on. */
function resultVisibilityNoteFor(args: TaskDescriptionBaseOptions): string {
  return args.taskToolNotificationHintsEnabled
    ? args.hideAsyncSubagentTaskNotifications ? "- On completion, the agent returns one reply. Tell it exactly what information to send back." : "- Each completed agent returns one reply, so say precisely what it should report. Background completion already shows a summary to the user. Do not repeat a single agent's result unless asked, several results need to be combined, or a blocker needs action beyond the visible summary." : "- Each completed agent returns one reply, so say precisely what it should report. Its result is not shown automatically; send the user a short message with the outcome when needed."
}

export function buildTaskToolDescriptionBase(args: TaskDescriptionBaseOptions): string {
  const recommendExplore = !args.subagentModelsInUserInfo && args.subagentExperimentGroup !== "no-subagent-unless-asked"
  const directToolHints = [
    ...(args.readToolName ? [
      `For one known file, use ${args.readToolName}${args.globToolName ? ` or ${args.globToolName}` : ""} to locate the relevant section rather than starting a ${args.toolLabel} run.`,
      `For a search limited to a couple of files, use ${args.readToolName} directly instead of asking ${args.toolLabel} to do it.`,
    ] : []),
    ...(args.globToolName ? [`To find a named declaration such as "class Foo", search with ${args.globToolName} instead of starting ${args.toolLabel}.`] : []),
  ]
  const exploreHints = args.includeExploreSubagent ? [
    ...(recommendExplore ? [`For broad codebase discovery on substantial work, prefer ${args.toolLabel} with subagent_type="${EXPLORE_SUBAGENT_TYPE}" over running the searches yourself.`] : []),
    `Handle a focused question directly with the available tools rather than starting ${args.toolLabel}.`,
    "",
    "Examples:",
    '- user: "Where is the ClientError class defined?" assistant: [Searches directly for this single declaration]',
    '- user: "Run this query using my database API" assistant: [Calls the database tool directly]',
    `- user: "What is the codebase structure?" assistant: [Starts ${args.toolLabel} with subagent_type="${EXPLORE_SUBAGENT_TYPE}"]`,
    "When separate areas can be explored independently, run their agents at the same time.",
  ] : []
  const resumeNote = args.allowResumeSelfFork
    ? ' Set resume="self" to start a child with this conversation\'s history.'
    : ""
  const linkNote = args.enableAgentChatLinks
    ? "Link to agents or subagents in user-facing text with the [Name](id) format."
    : ""
  return [
    "Start an additional agent for substantial work that can be completed independently.",
    "",
    `${args.toolLabel} starts a specialist process with its own capabilities and tools. Each subagent_type describes a different kind of agent.`,
    "",
    `Choose the required subagent_type field to select the agent.${exploreHints.length > 0 ? `\n${exploreHints.join("\n")}` : ""}`,
    "",
    "Use your own tools for short tasks that need only one or two direct steps.",
    ...directToolHints,
    "",
    "Guidance:",
    "Give each run a clear title of about 3-5 words.",
    "Start independent agents together when that helps the work move faster.",
    resultVisibilityNoteFor(args),
    `Pass a prior agent's ID as resume to continue it. ${resumeBehaviorFor(args)}${resumeNote} A new run has no prior agent context, so include the details it needs.`,
    linkNote,
    "An agent cannot see the user's message or earlier assistant work. State the assignment and include all relevant context in the prompt.",
    "Treat the agent's report as reliable by default.",
    "Give the agent a clear assignment and the context it needs to act on it.",
    "When an agent description recommends proactive use, choose it when appropriate.",
  ].join("\n")
}

/** One line of the catalogue: the type's name, and the note that it resumes by itself. */
function formatSubagentConfigForDescription(config: TaskSchemaSubagentConfig, defaultResumeMode: TaskResumeMode): string {
  const name = config.typeName
  const effectiveResumeMode = config.resumeModeOverride ?? defaultResumeMode
  let description = config.description ?? ""
  if (effectiveResumeMode !== "DEFAULT") {
    const resumeNote = effectiveResumeMode === "LAST_AGENT_SAME_TYPE" ? " (Continues the newest agent of this type automatically; ignores `resume`)" : " (Continues the newest agent automatically; ignores `resume`)"
    description = description ? `${description}${resumeNote}` : resumeNote
  }
  return description ? `- ${name}: ${description}` : `- ${name}`
}

export function buildTaskToolDescriptionParts(options: TaskDescriptionPartsOptions): TaskDescriptionParts {
  const catalogsInUserInfo = options.catalogsInUserInfo ?? options.subagentModelsInUserInfo
  const subagentInheritGuidance = options.subagentInheritGuidance ?? options.subagentModelsInUserInfo
  const { configs, defaultResumeMode, subagentModels, ...baseOptions } = options
  const baseDescription = buildTaskToolDescriptionBase({
    ...baseOptions,
    includeExploreSubagent: options.includeExploreSubagent && configs.some(config => config.typeName === EXPLORE_SUBAGENT_TYPE),
  })
  const sections = [baseDescription]
  let subagentTypeDescriptionsText = ""
  if (configs.length > 0) {
    subagentTypeDescriptionsText = `Agent types and a short note about each:\n${configs.map(config => formatSubagentConfigForDescription(config, defaultResumeMode)).join("\n")}`
    // A catalogue that lives in the user-info message is pointed at rather than repeated here.
    sections.push(catalogsInUserInfo ? "Agent types and descriptions are in <available_subagent_types> near the beginning of this conversation." : subagentTypeDescriptionsText)
  }
  const modelsDescription = buildAvailableModelsDescription(subagentModels, subagentInheritGuidance)
  sections.push(catalogsInUserInfo ? "Agent model choices are in <available_subagent_models> near the beginning of this conversation." : modelsDescription)
  return { baseDescription, subagentTypeDescriptionsText, modelsDescription, fullDescription: sections.join("\n\n") }
}
