/**
 * The tool that runs a command, on either surface.
 *
 * A command is asked for in a way that depends on where it will run and who is watching. It may be run on
 * the machine the user is sitting at, or inside a box that was made for it; it may be asked for by a prompt
 * version that knows about a background shell and one that does not; it may be read-only, in which case the
 * platform will not run anything that changes the machine. All of that is decided here, once, from the
 * settings the caller supplied, and the tool that comes out is the one the session uses.
 *
 * Before anything runs, the command is read: the parser reports what it is made of, and a executionPlan says whether
 * it starts in the background, how long it may take and what happens when it runs out of time. Then the
 * command may be reviewed — a caller may install a check of its own, the platform's own guard refuses the
 * commands that would take a screenshot of the user's screen, and the auto-review classifier decides whether
 * this particular command, on this particular surface, under this project's permissions, may run at all. A
 * block from the classifier becomes an approvalOutcome request when the model asked for one, and a refusal
 * otherwise.
 *
 * What makes an approvalOutcome worth anything is that it is for the command that actually runs. So the approvalOutcome
 * carries a fingerprint of what was reviewed — the command, the working directory, the policy, the executionPlan and
 * whatever the caller's own enrichment produced — and before the command starts, the identity and the
 * enrichment are asked for again and compared. A command whose target changed between the review and the
 * run is refused rather than run under an approvalOutcome it no longer has, because an approvalOutcome that can be moved
 * to another command is not an approvalOutcome of anything.
 *
 * The result is the command's own: its streamOutput, its exit code, how long it took, and — for a command that
 * was moved to the background — the shell it can be watched under. A refusal, a denial, a timeout and a
 * failure to start are all reported as the same kind of result the renderer knows how to write.
 */

import type { Context } from "../../../../context/context.ts"
import { createHash } from "node:crypto"
import { z } from "zod"

import { createStringResult } from "../../../../chat-inference/prompt-executor.ts"
import type { ResourceAccessor } from "../../../../agent-exec/resource-provider.ts"
import type { RemoteExecManager } from "../../../../agent-exec/executor-resources.ts"
import { shellStreamExecutorResource, type ShellStreamExecutor, type ShellStreamExecutorArgs, type ShellStreamExecutorEvent } from "../../../../agent-exec/shell-stream-operation.ts"
import { smartModeClassifierExecutorResource } from "../../../../agent-exec/smart-mode-classifier-operation.ts"
import {
  createBackgroundShellSuccessInterop,
  createShellArgsInterop,
  createShellFailureToolCallInterop,
  createShellToolCallInterop,
  createSmartModeClassifierArgsInterop,
  createSmartModeRiskTargetInterop,
  emptyShellArgsInterop,
  escalatedShellSandboxPolicyInterop,
  formatShellResultInterop,
  projectShellStreamEventInterop,
  shellStreamArgsFromToolCallInterop,
  projectSmartModeClassifierDecisionInterop,
  shellSandboxPolicyFingerprintInterop,
  createShellStreamResultInterop,
  type ShellArgsInterop,
  type ShellResultInterop,
  type ShellSandboxPolicy,
  type ShellStreamEventViewInterop,
  type ShellTimeoutBehaviorInterop,
  type ShellToolEnvelopeInterop,
} from "../../../../../adapters/interop/agent/shell-tool-protocol-adapter.ts"
import type { HookContextEntry } from "../../../../hooks-carriers/hook-additional-context.ts"
import { analyzeShellCommand, type ShellCommandAnalysis } from "../../../../shell-exec/shell-parser.ts"
import {
  CustomToolCallError,
  ToolCallAbortedError,
  ToolCallRejectedError,
  ToolCallUnexpectedEnvironmentError,
  ToolTimeoutError,
} from "../../tool-errors.ts"
import { createZodAgentTool, withSafeParsedArgs } from "../../tool-support.ts"
import type { SmartModeClassifierControls } from "../../dev-smart-mode-classifier-block.ts"
import { ToolErrorClassification } from "../../tool-errors.ts"
import { getShellToolDescription, getShellToolParametersSchema } from "./shell-tool-description.ts"
import { shellPromptProfileFromInterop } from "../../../../../adapters/interop/agent/shell-prompt-profile-adapter.ts"
import { BACKGROUND_SHELL_DEFAULT_BLOCK_UNTIL_MS } from "../../tool-execution-timeout.ts"
import { getConversationId } from "../../../utils/request-scope.ts"
import { AgentType } from "../../../utils/agent-config.ts"
import { loadSmartModeProjectPermissionsContext } from "../../../smart-mode-project-permissions.ts"
import { tryExtractSmartModeClassifierConversationContext, type SlateClassifierConversationMessage } from "../../../smart-mode-classifier-context.ts"
import { executeSmartModeClassifierWithMeasurement } from "../../../../../adapters/interop/agent/smart-mode-classifier-measurement-adapter.ts"
import { delayDevSmartModeClassifierIfRequested, type OneShotState } from "../../dev-smart-mode-classifier-block.ts"
import { withToolExecutionTimeoutSuspended } from "../../tool-timeout-suspension.ts"
import type { ConversationStateHandle } from "../../../state.ts"
import { checkShellDesktopControl } from "./ui-automation-guard.ts"

/** The resource boundary the shell shellStreamExecutor lane owns. */
export type ShellToolResourceAccessor = ResourceAccessor<RemoteExecManager>
export type { ShellStreamExecutor }

/** Where a command runs: the machine the user is at, or a box that was made for it. */
export type ShellToolSurface = "host_machine" | "isolated_box"

export interface ShellExecutionPlan {
  readonly shouldStartInBackground: boolean
  readonly backgroundAfterMs: number
  readonly hardTimeoutMs?: number
  readonly timeoutBehavior: ShellTimeoutBehaviorInterop
}

export interface ShellPreflightRequest {
  readonly command: string
  readonly workingDirectory?: string
  readonly isBackground: boolean
  readonly analysis: ShellCommandAnalysis
  readonly executionPlan: ShellExecutionPlan
  readonly requestedSandboxPolicy?: ShellSandboxPolicy
  readonly surface: ShellToolSurface
}

export type ShellPreflightDecision =
  | { readonly allow: true; readonly auditId?: string }
  | { readonly allow: false; readonly reason: string; readonly auditId?: string }

export interface ShellToolInteractionHandler {
  executeToolCall(
    toolCtx: Context,
    toolCall: ShellToolEnvelopeInterop,
    toolCallId: string,
    execute: (toolCtx: Context) => Promise<ShellResultInterop>,
    merge: (result: ShellResultInterop) => ShellToolEnvelopeInterop,
    hookContextCollector?: unknown,
  ): Promise<ShellResultInterop>
  getAbortSignal(toolCtx: Context): AbortSignal
  emitPartialToolCall?(toolCtx: Context, toolCallId: string, toolCall: ShellToolEnvelopeInterop): Promise<void>
}

export interface ShellToolExecutionMeta {
  readonly toolCallId: string
  readonly execId?: string
  readonly hookContextCollector?: HookContextEntry[]
  readonly strictArgParsing?: boolean
  readonly workspacePaths?: readonly string[]
  readonly stateHandler?: { readonly usesLargeContextTreatment?: () => boolean }
  readonly userAutoRunInstructions?: ShellAutoRunInstructions
  readonly projectAutoRunInstructions?: ShellAutoRunInstructions
}

/** The state handler as the classifier wants it: a conversation that can be read, not just a version flag. */
function looksLikeConversationState(value: { readonly usesLargeContextTreatment?: () => boolean }): value is ConversationStateHandle {
  return "conversationStateStructure" in value && "readPaths" in value
}

export interface ShellAutoRunInstructions {
  readonly allowInstructions: readonly string[]
  readonly blockInstructions: readonly string[]
}

export interface ShellSmartModeApprovalTarget {
  readonly surface: string
  readonly command: string
  readonly workingDirectory?: string
  readonly requestedSandboxPolicy?: ShellSandboxPolicy
  readonly isBackground: boolean
  readonly isReadonly: boolean
  readonly executionPlan: ShellExecutionPlan
  readonly executionStateIdentity?: string
  readonly targetEnrichmentHash?: string
  readonly blockReason: string
  readonly description?: string
  readonly proposedAllowRule?: string
}

export interface ShellSmartModeApprovalProvider {
  requestApproval(input: {
    readonly kind: "shell"
    readonly target: ShellSmartModeApprovalTarget
    readonly fingerprint: string
    readonly toolCallId: string
    readonly conversationId: string | undefined
    readonly signal: AbortSignal
  }): Promise<{ readonly approved: boolean; readonly reason?: string | undefined }>
}

/** What an approvalOutcome is bound to besides the command: the state the shell is in, and the caller's own view. */
export interface ShellSmartModeApprovalState {
  getIdentity(): string | undefined
  markSideEffectStart(): void
}

export interface ShellToolOptions {
  readonly surface?: ShellToolSurface
  readonly toolName?: string
  readonly toolIdentifier?: string
  readonly promptVersion?: string
  readonly shellType?: string
  readonly sandboxEnabled?: boolean
  readonly sandboxPromptEnabled?: boolean
  readonly isReadonly?: boolean
  readonly enableBlockUntilMs?: boolean
  readonly requireBlockUntilMs?: boolean
  readonly defaultBlockUntilMs?: number
  readonly defaultTimeoutMs?: number
  readonly hardTimeoutMs?: number
  readonly terminalsFolder?: string
  readonly useMinimalHarness?: boolean
  readonly agentType?: string
  readonly parametersSchema?: ReturnType<typeof getShellToolParametersSchema>
  readonly adminCommandDenylist?: readonly string[]
  readonly fileOperationLockManager?: {
    waitForExclusiveLock(toolCtx: Context): Promise<{ [Symbol.dispose](): void }>
  }
  readonly preflight?: (toolCtx: Context, request: ShellPreflightRequest) => Promise<ShellPreflightDecision>
  readonly onAudit?: (toolCtx: Context, request: ShellPreflightRequest, decision: ShellPreflightDecision) => void
  readonly onStreamEvent?: (toolCtx: Context, event: ShellStreamExecutorEvent) => Promise<void>
  readonly onTelemetry?: (toolCtx: Context, event: { readonly type: "started" | "finished" | "backgrounded"; readonly toolCallId: string }) => void
  readonly isPlatformEnabled?: (platform: NodeJS.Platform) => boolean
  readonly smartModeClassifierControls?: SmartModeClassifierControls
  readonly smartModeClassifierMode?: boolean
  readonly smartModeClassifierShadowMode?: boolean
  readonly smartModeApprovalSurface?: string
  readonly smartModeApprovalProvider?: ShellSmartModeApprovalProvider
  readonly smartModeShellTargetEnrichmentProvider?: (
    toolCtx: Context,
    args: { readonly resourceAccessor: ShellToolResourceAccessor; readonly command: string; readonly workingDirectory?: string; readonly toolCallId: string },
  ) => Promise<unknown>
  readonly smartModeShellApprovalState?: ShellSmartModeApprovalState
  readonly extractSmartModeClassifierConversationContext?: (toolCtx: Context, state: ConversationStateHandle) => Promise<readonly SlateClassifierConversationMessage[]>
  readonly userAutoRunInstructions?: ShellAutoRunInstructions
  readonly projectAutoRunInstructions?: ShellAutoRunInstructions
  readonly smartModeClassifierMaxAttempts?: number
  readonly suppressSmartModeClassifierTelemetryIds?: boolean
  readonly devSmartModeClassifierBlockState?: OneShotState
  readonly devSmartModeClassifierDelayState?: OneShotState
  readonly disableSmartModeAllowlistPrecheck?: boolean
  readonly loadSmartModeWorkspacePermissionFiles?: boolean
  readonly enforceModelFacingShellUiAutomationGuard?: boolean
  readonly readToolIdentifier?: string
  readonly awaitToolIdentifier?: string
  readonly enableJobCompletionNotifications?: boolean
  readonly enableTerminalFiles?: boolean
}

export class ShellToolRejectedError extends ToolCallRejectedError {
  constructor(readonly command: string, readonly workingDirectory: string | undefined, readonly reason: string) { super(reason) }
}

export class ShellToolPermissionDeniedError extends CustomToolCallError {
  constructor(readonly command: string, readonly workingDirectory: string | undefined, readonly error: string, readonly isReadonly: boolean) {
    super(ToolErrorClassification.USER_REJECTED, {
      error: `Permission denied: ${error}`,
      clientVisibleErrorMessage: isReadonly ? "You are in ask mode and cannot run non read-only tools. Ask the user to switch to agent mode if edits are required." : `Permission denied: ${error}`,
      modelVisibleErrorMessage: isReadonly ? "You are in ask mode and cannot run non read-only tools. Ask the user to switch to agent mode if edits are required." : `Permission denied: ${error}`,
    })
  }
}

export class ShellToolTimeoutError extends ToolTimeoutError {
  constructor(readonly command: string, readonly workingDirectory: string | undefined, readonly timeoutMs: number) {
    const message = `The shell command did not complete within ${timeoutMs} ms.`
    super({ error: message, clientVisibleErrorMessage: message, modelVisibleErrorMessage: message })
  }
}

const WAIT_TIMEOUT_MS = 30_000
const HARD_TIMEOUT_MS = 24 * 60 * 60 * 1_000

const APPROVAL_RETRY_DESCRIPTION = "Set to true when immediately retrying the exact same command after Auto-review blocks it and you decide the user should approve it through the native approvalOutcome card."
const APPROVAL_REASON_DESCRIPTION = "Provide the exact block reason returned by Auto-review in the prior rejection. Required when request_smart_mode_approval is true so the approvalOutcome card shows the original classifier reason without re-running the classifier."

/** The two arguments that only exist where an approvalOutcome can be asked for. */
function withApprovalParameters(
  parameters: ReturnType<typeof getShellToolParametersSchema>,
  enabled: boolean,
): ReturnType<typeof getShellToolParametersSchema> {
  if (!enabled) return parameters
  return parameters.extend({
    request_smart_mode_approval: z.boolean().optional().describe(APPROVAL_RETRY_DESCRIPTION),
    smart_mode_block_reason: z.string().optional().describe(APPROVAL_REASON_DESCRIPTION),
  })
}

/** When a command starts in the background, how long it may take, and what running out of time means. */
function executionPlanOf(callArgs: Record<string, unknown>, settings: ShellToolOptions): ShellExecutionPlan {
  const defaultTimeoutMs = settings.defaultTimeoutMs ?? WAIT_TIMEOUT_MS
  const defaultBlockUntilMs = settings.defaultBlockUntilMs ?? (settings.agentType === "background" ? BACKGROUND_SHELL_DEFAULT_BLOCK_UNTIL_MS : defaultTimeoutMs)
  if (settings.enableBlockUntilMs === true) {
    const requestedValue = typeof callArgs.block_until_ms === "number" ? callArgs.block_until_ms : defaultBlockUntilMs
    // A wait of zero is a status check, which is the same as asking for the background.
    return {
      shouldStartInBackground: callArgs.is_background === true || requestedValue === 0,
      backgroundAfterMs: Math.min(requestedValue, settings.defaultTimeoutMs ?? requestedValue),
      hardTimeoutMs: settings.hardTimeoutMs ?? HARD_TIMEOUT_MS,
      timeoutBehavior: "background",
    }
  }
  const requestedTimeout = typeof callArgs.timeout === "number" ? callArgs.timeout : defaultTimeoutMs
  return {
    shouldStartInBackground: callArgs.is_background === true,
    backgroundAfterMs: requestedTimeout,
    ...(settings.hardTimeoutMs === undefined ? {} : { hardTimeoutMs: settings.hardTimeoutMs }),
    timeoutBehavior: "background",
  }
}

/** What the command asked to be allowed to do, which is only a policy where a sandbox is in use. */
function policyRequestedBy(callArgs: Record<string, unknown>, settings: ShellToolOptions, workspacePaths: readonly string[] = []): ShellSandboxPolicy | undefined {
  if (settings.sandboxEnabled !== true) return undefined
  const permissions = Array.isArray(callArgs.required_permissions) ? callArgs.required_permissions : []
  const all = permissions.includes("all")
  const network = permissions.includes("network") || permissions.includes("full_network")
  // A read-only session is confined to reading its workspace however much it asks for.
  if (settings.isReadonly === true) return { mode: "workspace_readonly", networkAccess: network }
  if (all) return { mode: "unrestricted" }
  return { mode: "workspace_readwrite", networkAccess: network, additionalReadwritePaths: [...workspacePaths] }
}

type SlateJsonValue = null | string | boolean | number | SlateJsonValue[] | { readonly [key: string]: SlateJsonValue }

function jsonValueFrom(value: unknown): SlateJsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value
  if (Array.isArray(value)) {
    const values = value.map(jsonValueFrom)
    return values.some(entry => entry === undefined) ? undefined : values as SlateJsonValue[]
  }
  if (typeof value === "object") {
    const result: Record<string, SlateJsonValue> = {}
    for (const [key, entry] of Object.entries(value)) {
      const jsonValue = jsonValueFrom(entry)
      if (jsonValue !== undefined) result[key] = jsonValue
    }
    return result
  }
  return undefined
}

function jsonRecordFrom(value: Record<string, unknown>): Record<string, SlateJsonValue> {
  const json = jsonValueFrom(value)
  if (json == null || Array.isArray(json) || typeof json !== "object") return {}
  return json
}

/** A policy as JSON with its defaults, so that two policies that differ only by an unset field compare equal. */
function policyFingerprintOf(policy: ShellSandboxPolicy | undefined): unknown | null {
  return shellSandboxPolicyFingerprintInterop(policy)
}

function approvalFingerprintOf(target: ShellSmartModeApprovalTarget): string {
  return createHash("sha256").update(JSON.stringify({
    surface: target.surface,
    command: target.command,
    workingDirectory: target.workingDirectory ?? null,
    requestedSandboxPolicy: policyFingerprintOf(target.requestedSandboxPolicy),
    isBackground: target.isBackground,
    isReadonly: target.isReadonly,
    executionPlan: target.executionPlan,
    executionStateIdentity: target.executionStateIdentity ?? null,
    targetEnrichmentHash: target.targetEnrichmentHash ?? null,
  })).digest("hex")
}

/**
 * A blocked command that the user approves is run without a sandbox, since the approvalOutcome is the user taking
 * responsibility for it — except in a read-only session, where the policy stands.
 */
function escalatedPolicyFor(
  requestedSandboxPolicy: ShellSandboxPolicy | undefined,
): ShellSandboxPolicy {
  return escalatedShellSandboxPolicyInterop(requestedSandboxPolicy)
}

/** The caller's own enrichment can say that what will run could not be bound to the review. */
function missingApprovalBinding(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false
  if (!("approval_binding_unavailable" in value)) return false
  return value.approval_binding_unavailable === true
}

function enrichmentHashOf(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const serialized = JSON.stringify(value)
  return serialized === undefined ? undefined : createHash("sha256").update(serialized).digest("hex")
}

type ShellSmartModeDecision =
  | { readonly kind: "allow"; readonly enabled: boolean; readonly targetEnrichmentHash?: string }
  | { readonly kind: "block"; readonly reason: string; readonly proposedAllowRule?: string; readonly targetEnrichmentHash?: string }
  | { readonly kind: "reject"; readonly reason: string }

const AUTO_REVIEW_BLOCK_REASON = "Blocked by Auto-review"
const AUTO_REVIEW_FAILURE_REASON = "An error occured while classifying this action. Please review manually."

/**
 * The review of one command.
 *
 * The classifier is only asked where the session asked for it and the user's settings allow it; a background
 * agent is never reviewed, since nobody is there to answer an approvalOutcome. A shadow run asks without acting on
 * the answer, which is how the classifier is measured before it is trusted — and it is not waited for, since
 * nothing depends on it. Anything that is neither an allow nor a block is a refusal the user has to clear
 * rather than permission.
 */
async function classifyShellCall(
  toolCtx: Context,
  resourceAccessor: ShellToolResourceAccessor,
  settings: ShellToolOptions,
  callArgs: Record<string, unknown>,
  executionMeta: ShellToolExecutionMeta,
  command: string,
  workingDirectory: string | undefined,
  description: string | undefined,
  executionPlan: ShellExecutionPlan,
  requestedSandboxPolicy: ShellSandboxPolicy | undefined,
  surface: ShellToolSurface,
  signal: AbortSignal,
): Promise<ShellSmartModeDecision> {
  const isBackgroundAgent = settings.agentType === AgentType.BACKGROUND || settings.agentType === "background"
  const classifierControls = settings.smartModeClassifierControls ?? { automaticModeEnabled: false }
  const autoModeSelected = settings.smartModeClassifierMode === true && classifierControls.automaticModeEnabled
  const enabled = !isBackgroundAgent && autoModeSelected
  const shadowEnabled = !isBackgroundAgent && !enabled && settings.smartModeClassifierShadowMode === true
  if (!enabled && !shadowEnabled) return { kind: "allow", enabled: false }

  // A developer can force the next command to be blocked, which is how the refusal path is exercised.
  const consumedDevBlock = enabled && settings.devSmartModeClassifierBlockState?.consume() === true
  if (consumedDevBlock) {
    await delayDevSmartModeClassifierIfRequested(settings.devSmartModeClassifierDelayState)
    return { kind: "block", reason: "This is a dev block whatever just retry it" }
  }

  const targetEnrichment = await settings.smartModeShellTargetEnrichmentProvider?.(toolCtx, {
    resourceAccessor,
    command,
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    toolCallId: executionMeta.toolCallId,
  })
  // An approvalOutcome cannot be for a command whose content could not be resolved, so it is refused instead.
  if (settings.smartModeApprovalProvider !== undefined && missingApprovalBinding(targetEnrichment)) {
    throw new ShellToolRejectedError(command, workingDirectory, "The executable content could not be bound to this review. Run the resolved script directly or provide an explicit working directory.")
  }
  const targetEnrichmentHash = enrichmentHashOf(targetEnrichment)
  const conversationContext: SlateClassifierConversationMessage[] = executionMeta.stateHandler === undefined || !looksLikeConversationState(executionMeta.stateHandler)
    ? []
    : settings.extractSmartModeClassifierConversationContext === undefined
      ? await tryExtractSmartModeClassifierConversationContext(toolCtx, executionMeta.stateHandler)
      : [...await settings.extractSmartModeClassifierConversationContext(toolCtx, executionMeta.stateHandler)]
  const workspacePaths = settings.loadSmartModeWorkspacePermissionFiles === false ? undefined : executionMeta.workspacePaths
  const projectPermissions = await loadSmartModeProjectPermissionsContext(
    toolCtx,
    workspacePaths,
    executionMeta.userAutoRunInstructions ?? settings.userAutoRunInstructions,
    executionMeta.projectAutoRunInstructions ?? settings.projectAutoRunInstructions,
  )
  const target = createSmartModeRiskTargetInterop({
    action: "shell",
    arguments: jsonRecordFrom({
      command,
      ...(workingDirectory === undefined ? {} : { working_directory: workingDirectory }),
      surface,
      description,
      background: { start_in_background: executionPlan.shouldStartInBackground },
      timeout: {
        background_after_ms: executionPlan.backgroundAfterMs,
        hard_timeout_ms: executionPlan.hardTimeoutMs,
        timeout_behavior: executionPlan.timeoutBehavior,
      },
      sandbox_enabled: settings.sandboxEnabled === true,
      is_readonly: settings.isReadonly === true,
      requested_sandbox_policy: policyFingerprintOf(requestedSandboxPolicy),
      project_permissions: projectPermissions,
      target_enrichment: targetEnrichment,
    }),
  })

  const run = async (mode: "enforce" | "shadow"): Promise<ShellSmartModeDecision> => {
    const shellStreamExecutor = resourceAccessor.get(smartModeClassifierExecutorResource)
    await delayDevSmartModeClassifierIfRequested(settings.devSmartModeClassifierDelayState)
    const parentConversationId = getConversationId(toolCtx)
    const result = await executeSmartModeClassifierWithMeasurement(
      toolCtx,
      shellStreamExecutor,
      createSmartModeClassifierArgsInterop({
        toolCallId: executionMeta.toolCallId,
        ...(parentConversationId === undefined ? {} : { parentConversationId }),
        target,
        conversationContext,
      }),
      mode,
      workspacePaths,
      {
        suppressToolCallIdLogging: settings.suppressSmartModeClassifierTelemetryIds === true,
        maxAttempts: settings.smartModeClassifierMaxAttempts,
      },
    )
    const decision = projectSmartModeClassifierDecisionInterop(result)
    if (decision.kind === "block") {
      return {
        kind: "block",
        reason: decision.reason ?? AUTO_REVIEW_BLOCK_REASON,
        ...(decision.proposedAllowRule === undefined ? {} : { proposedAllowRule: decision.proposedAllowRule }),
        ...(targetEnrichmentHash === undefined ? {} : { targetEnrichmentHash }),
      }
    }
    if (decision.kind === "allow") {
      return { kind: "allow", enabled: mode === "enforce", ...(targetEnrichmentHash === undefined ? {} : { targetEnrichmentHash }) }
    }
    return { kind: "reject", reason: AUTO_REVIEW_FAILURE_REASON }
  }

  if (!enabled) {
    // A shadow run is not waited for: nothing depends on its answer.
    void run("shadow").catch(() => undefined)
    return { kind: "allow", enabled: false, ...(targetEnrichmentHash === undefined ? {} : { targetEnrichmentHash }) }
  }
  try {
    return await run("enforce")
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") throw error
    if (error instanceof ShellToolRejectedError) throw error
    if (signal.aborted) throw new ToolCallAbortedError()
    return { kind: "reject", reason: AUTO_REVIEW_FAILURE_REASON }
  }
}

/** The command as the shellStreamExecutor is asked to run it, including everything the parser found in it. */
function shellArgumentsOf(callArgs: Record<string, unknown>, parsedCommand: ShellCommandAnalysis, executionPlan: ShellExecutionPlan, settings: ShellToolOptions, executionMeta: ShellToolExecutionMeta, policy: ShellSandboxPolicy | undefined, skipApproval = false): ShellArgsInterop {
  const command = String(callArgs.command)
  const workingDirectory = typeof callArgs.working_directory === "string" ? callArgs.working_directory : ""
  const description = typeof callArgs.description === "string" ? callArgs.description : typeof callArgs.explanation === "string" ? callArgs.explanation : undefined
  return createShellArgsInterop({
    command,
    workingDirectory,
    timeout: executionPlan.backgroundAfterMs,
    toolCallId: executionMeta.toolCallId,
    simpleCommands: parsedCommand.legacy.simpleCommands,
    hasInputRedirect: parsedCommand.legacy.hasInputRedirect,
    hasOutputRedirect: parsedCommand.legacy.hasOutputRedirect,
    parsingResult: {
      parsingFailed: parsedCommand.structured.parsingFailed,
      hasRedirects: parsedCommand.structured.hasRedirects,
      hasCommandSubstitution: parsedCommand.structured.hasCommandSubstitution,
      ...(parsedCommand.structured.allRedirectsAreDevNull === undefined ? {} : { allRedirectsAreDevNull: parsedCommand.structured.allRedirectsAreDevNull }),
      executableCommands: parsedCommand.structured.executableCommands.map(commandValue => ({
        name: commandValue.name,
        fullText: commandValue.fullText,
        args: commandValue.args.map(argument => ({ type: argument.type, value: argument.value })),
      })),
      redirects: parsedCommand.structured.redirects.map(redirect => ({
        operator: redirect.operator,
        destinationFds: redirect.destinationFds,
        targetNodeType: redirect.targetNodeType,
        ...(redirect.targetText === undefined ? {} : { targetText: redirect.targetText }),
      })),
    },
    ...(policy === undefined ? {} : { requestedSandboxPolicy: policy }),
    isBackground: executionPlan.shouldStartInBackground,
    skipApproval,
    timeoutBehavior: executionPlan.timeoutBehavior,
    ...(executionPlan.hardTimeoutMs === undefined ? {} : { hardTimeout: executionPlan.hardTimeoutMs }),
    ...(description === undefined ? {} : { description }),
    adminCommandDenylist: settings.adminCommandDenylist ?? [],
  })
}

/** The result of a command that ran to its end, which is a success only when it exited cleanly and was not stopped. */
function streamResultOf(command: string, workingDirectory: string, stdout: string, stderr: string, interleavedOutput: string, exit: Extract<ShellStreamEventViewInterop, { readonly kind: "exit" }> | undefined, policy: ShellSandboxPolicy | undefined): ShellResultInterop {
  if (exit === undefined) throw new Error("Shell exec outputStream closed without an exit event; result is unknown")
  return createShellStreamResultInterop({ command, workingDirectory, stdout, stderr, interleavedOutput, exit, ...(policy === undefined ? {} : { sandboxPolicy: policy }) })
}

/** Reads the shellStreamExecutor's outputStream to its end, where a command that was moved to the background ends early. */
async function runStream(toolCtx: Context, shellStreamExecutor: ShellStreamExecutor, args: ShellStreamExecutorArgs, interactionBridge: ShellToolInteractionHandler, executionMeta: ShellToolExecutionMeta, settings: ShellToolOptions, policy: ShellSandboxPolicy | undefined): Promise<ShellResultInterop> {
  let stdout = ""
  let stderr = ""
  let interleavedOutput = ""
  let exit: Extract<ShellStreamEventViewInterop, { readonly kind: "exit" }> | undefined
  const executorOptions = {
    ...(executionMeta.execId === undefined ? {} : { execId: executionMeta.execId }),
    ...(executionMeta.hookContextCollector === undefined ? {} : { hookContextCollector: executionMeta.hookContextCollector }),
  }
  for await (const event of shellStreamExecutor.execute(toolCtx, args, executorOptions)) {
    await settings.onStreamEvent?.(toolCtx, event)
    const view = projectShellStreamEventInterop(event)
    switch (view.kind) {
      case "stdout": stdout += view.data; interleavedOutput += view.data; break
      case "stderr": stderr += view.data; interleavedOutput += view.data; break
      case "exit": exit = view; break
      case "rejected": throw new ShellToolRejectedError(view.command, view.workingDirectory, view.reason)
      case "permission-denied": throw new ShellToolPermissionDeniedError(view.command, view.workingDirectory, view.error, view.isReadonly)
      case "sandbox-unsupported": throw new ToolCallUnexpectedEnvironmentError(view.reason)
      case "backgrounded": {
        // The command has not finished; what it has produced so far is what the result carries.
        settings.onTelemetry?.(toolCtx, { type: "backgrounded", toolCallId: executionMeta.toolCallId })
        return createBackgroundShellSuccessInterop({
          command: view.command,
          workingDirectory: view.workingDirectory,
          shellId: view.shellId,
          ...(view.pid === undefined ? {} : { pid: view.pid }),
          ...(view.msToWait === undefined ? {} : { msToWait: view.msToWait }),
          ...(view.reason === undefined ? {} : { reason: view.reason }),
          stdout,
          stderr,
          interleavedOutput,
          ...(policy === undefined ? {} : { sandboxPolicy: policy }),
        })
      }
      case "other": break
    }
  }
  return streamResultOf(args.command, args.workingDirectory ?? "", stdout, stderr, interleavedOutput, exit, policy)
}

/** Every way a command can fail has its own shape in the result the model and the user read. */
function shellFailureCall(error: unknown): ShellToolEnvelopeInterop {
  if (error instanceof ShellToolRejectedError) {
    return createShellFailureToolCallInterop({ kind: "rejected", command: error.command, workingDirectory: error.workingDirectory ?? "", reason: error.reason })
  }
  if (error instanceof ShellToolPermissionDeniedError) {
    return createShellFailureToolCallInterop({ kind: "permission-denied", command: error.command, workingDirectory: error.workingDirectory ?? "", error: error.error, isReadonly: error.isReadonly })
  }
  if (error instanceof ShellToolTimeoutError) {
    return createShellFailureToolCallInterop({ kind: "timeout", command: error.command, workingDirectory: error.workingDirectory ?? "", timeoutMs: error.timeoutMs })
  }
  return createShellFailureToolCallInterop({ kind: "spawn-error", error: error instanceof Error ? error.message : String(error) })
}

function renderShellResult(result: ShellResultInterop, settings: ShellToolOptions): string {
  return formatShellResultInterop(result, {
    ...(settings.terminalsFolder === undefined ? {} : { terminalsFolder: settings.terminalsFolder }),
    ...(settings.promptVersion === undefined ? {} : { promptVersion: settings.promptVersion }),
    ...((settings.sandboxPromptEnabled ?? settings.sandboxEnabled) === undefined ? {} : { sandboxPromptEnabled: settings.sandboxPromptEnabled ?? settings.sandboxEnabled }),
    ...(settings.useMinimalHarness === undefined ? {} : { useMinimalHarness: settings.useMinimalHarness }),
  })
}

/**
 * The shell tool, uncomposed: the caller supplies the shellStreamExecutor through the resource key, and this module
 * deliberately does not register anything. The same contract serves the host machine and the isolated box.
 */
export function createShellTool(resourceAccessor: ShellToolResourceAccessor, settings: ShellToolOptions = {}): ReturnType<typeof createZodAgentTool> | undefined {
  if (settings.isPlatformEnabled?.(process.platform) === false) return undefined
  const surface = settings.surface ?? "host_machine"
  const promptVersion = settings.promptVersion
  const shellPromptProfile = shellPromptProfileFromInterop(promptVersion)
  const sandboxEnabled = settings.sandboxEnabled ?? false
  const defaultBlockUntilMs = settings.defaultBlockUntilMs ?? (settings.agentType === "background" ? BACKGROUND_SHELL_DEFAULT_BLOCK_UNTIL_MS : WAIT_TIMEOUT_MS)
  // A background agent has nobody to approve anything, so it is not offered the approvalOutcome arguments.
  const smartModeApprovalParametersEnabled = settings.agentType !== AgentType.BACKGROUND && settings.smartModeClassifierMode === true
  const parameters = withApprovalParameters(settings.parametersSchema ?? getShellToolParametersSchema(sandboxEnabled, shellPromptProfile, { isReadonly: settings.isReadonly, enableBlockUntilMs: settings.enableBlockUntilMs, requireBlockUntilMs: settings.requireBlockUntilMs, defaultBlockUntilMs }), smartModeApprovalParametersEnabled)
  const shellStreamExecutor = resourceAccessor.get(shellStreamExecutorResource)
  const execute = async (toolCtx: Context, interactionBridge: ShellToolInteractionHandler, callArgs: Record<string, unknown>, executionMeta: ShellToolExecutionMeta): Promise<ShellResultInterop> => {
    const command = String(callArgs.command)
    const workingDirectory = typeof callArgs.working_directory === "string" ? callArgs.working_directory : undefined
    const parsedCommand = analyzeShellCommand(command)
    const executionPlan = executionPlanOf(callArgs, settings)
    const policy = policyRequestedBy(callArgs, settings, executionMeta.workspacePaths)
    const request = { command, ...(workingDirectory === undefined ? {} : { workingDirectory }), isBackground: executionPlan.shouldStartInBackground, analysis: parsedCommand, executionPlan: executionPlan, ...(policy === undefined ? {} : { requestedSandboxPolicy: policy }), surface }
    const decision = await settings.preflight?.(toolCtx, request) ?? { allow: true as const }
    settings.onAudit?.(toolCtx, request, decision)
    if (!decision.allow) throw new ShellToolRejectedError(command, workingDirectory, decision.reason)
    // The platform's own guard refuses the commands that would look at the user's screen.
    if (settings.enforceModelFacingShellUiAutomationGuard === true) {
      const uiAutomationDecision = checkShellDesktopControl(command)
      if (!uiAutomationDecision.allow) throw new ShellToolRejectedError(command, workingDirectory, uiAutomationDecision.reason)
    }
    const smartModeDecision = await classifyShellCall(
      toolCtx,
      resourceAccessor,
      settings,
      callArgs,
      executionMeta,
      command,
      workingDirectory,
      typeof callArgs.description === "string" ? callArgs.description : typeof callArgs.explanation === "string" ? callArgs.explanation : undefined,
      executionPlan,
      policy,
      surface,
      interactionBridge.getAbortSignal(toolCtx),
    )
    if (smartModeDecision.kind === "reject") throw new ShellToolRejectedError(command, workingDirectory, smartModeDecision.reason)
    let approvedShellBinding: { readonly executionStateIdentity?: string; readonly targetEnrichmentHash?: string } | undefined
    let smartModeApprovalProviderApproved = false
    if (smartModeDecision.kind === "block") {
      // A blocked command is refused unless the model asked for the user's approvalOutcome and there is a way to ask.
      const approvalRequested = callArgs.request_smart_mode_approval === true
      const approvalProvider = settings.smartModeApprovalProvider
      if (!approvalRequested || approvalProvider === undefined) {
        throw new ShellToolRejectedError(command, workingDirectory, smartModeDecision.reason)
      }
      const approvalStateIdentity = settings.smartModeShellApprovalState?.getIdentity()
      const target: ShellSmartModeApprovalTarget = {
        surface: settings.smartModeApprovalSurface ?? (settings.awaitToolIdentifier === "BOX_AWAIT" ? "isolated_box" : "host_machine"),
        command,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
        ...(policy === undefined ? {} : { requestedSandboxPolicy: settings.isReadonly === true ? policy : escalatedPolicyFor(policy) }),
        isBackground: executionPlan.shouldStartInBackground,
        isReadonly: settings.isReadonly === true,
        executionPlan: executionPlan,
        ...(approvalStateIdentity === undefined ? {} : { executionStateIdentity: approvalStateIdentity }),
        ...(smartModeDecision.targetEnrichmentHash === undefined ? {} : { targetEnrichmentHash: smartModeDecision.targetEnrichmentHash }),
        blockReason: smartModeDecision.reason,
        ...(typeof callArgs.description === "string" && callArgs.description.trim().length > 0 ? { description: callArgs.description.trim() } : typeof callArgs.explanation === "string" && callArgs.explanation.trim().length > 0 ? { description: callArgs.explanation.trim() } : {}),
        ...(smartModeDecision.proposedAllowRule === undefined ? {} : { proposedAllowRule: smartModeDecision.proposedAllowRule }),
      }
      // Waiting for a user to approve something is not the command timing out, so the timeout is suspended.
      const approvalOutcome = await withToolExecutionTimeoutSuspended(toolCtx, () => approvalProvider.requestApproval({
        kind: "shell",
        target,
        fingerprint: approvalFingerprintOf(target),
        toolCallId: executionMeta.toolCallId,
        conversationId: getConversationId(toolCtx),
        signal: interactionBridge.getAbortSignal(toolCtx),
      }))
      if (interactionBridge.getAbortSignal(toolCtx).aborted) throw new ToolCallAbortedError()
      if (!approvalOutcome.approved) throw new ShellToolRejectedError(command, workingDirectory, approvalOutcome.reason ?? smartModeDecision.reason)
      smartModeApprovalProviderApproved = true
      approvedShellBinding = {
        ...(target.executionStateIdentity === undefined ? {} : { executionStateIdentity: target.executionStateIdentity }),
        ...(target.targetEnrichmentHash === undefined ? {} : { targetEnrichmentHash: target.targetEnrichmentHash }),
      }
    } else if (smartModeDecision.kind === "allow" && smartModeDecision.enabled && (settings.smartModeShellTargetEnrichmentProvider !== undefined || settings.smartModeShellApprovalState !== undefined)) {
      const approvalStateIdentity = settings.smartModeShellApprovalState?.getIdentity()
      approvedShellBinding = {
        ...(approvalStateIdentity === undefined ? {} : { executionStateIdentity: approvalStateIdentity }),
        ...(smartModeDecision.targetEnrichmentHash === undefined ? {} : { targetEnrichmentHash: smartModeDecision.targetEnrichmentHash }),
      }
    }
    settings.onTelemetry?.(toolCtx, { type: "started", toolCallId: executionMeta.toolCallId })
    const args = shellArgumentsOf(callArgs, parsedCommand, executionPlan, settings, executionMeta, policy, smartModeApprovalProviderApproved || (smartModeDecision.kind === "allow" && smartModeDecision.enabled))
    const toolCall = createShellToolCallInterop({ args })
    if (executionPlan.shouldStartInBackground) await interactionBridge.emitPartialToolCall?.(toolCtx, executionMeta.toolCallId, toolCall)
    const result = await interactionBridge.executeToolCall(toolCtx, toolCall, executionMeta.toolCallId, async runCtx => {
      if (interactionBridge.getAbortSignal(runCtx).aborted) throw new ToolCallAbortedError()
      // What was approved is checked against what is about to run, and an approvalOutcome is used once.
      if (approvedShellBinding !== undefined) {
        const currentIdentity = settings.smartModeShellApprovalState?.getIdentity()
        const currentEnrichment = await settings.smartModeShellTargetEnrichmentProvider?.(runCtx, {
          resourceAccessor,
          command,
          ...(workingDirectory === undefined ? {} : { workingDirectory }),
          toolCallId: executionMeta.toolCallId,
        })
        const currentHash = enrichmentHashOf(currentEnrichment)
        if (currentIdentity !== approvedShellBinding.executionStateIdentity || currentHash !== approvedShellBinding.targetEnrichmentHash) {
          throw new ShellToolRejectedError(command, workingDirectory, "The reviewed shell target changed before execution; retry the command for a new review.")
        }
        approvedShellBinding = undefined
      }
      settings.smartModeShellApprovalState?.markSideEffectStart()
      // A command that changes files waits for whatever else is changing them, since two writers at once is
      // how a workspace ends up inconsistent.
      const lock = settings.fileOperationLockManager === undefined ? undefined : await settings.fileOperationLockManager.waitForExclusiveLock(runCtx)
      try { return await runStream(runCtx, shellStreamExecutor, shellStreamArgsFromToolCallInterop(args), interactionBridge, executionMeta, settings, policy) }
      finally { lock?.[Symbol.dispose]() }
    }, mergedResult => createShellToolCallInterop({ args, result: mergedResult }), executionMeta.hookContextCollector)
    settings.onTelemetry?.(toolCtx, { type: "finished", toolCallId: executionMeta.toolCallId })
    return result
  }
  const toolName = settings.toolName ?? (surface === "isolated_box" ? "run-command" : "run_terminal_cmd")
  return createZodAgentTool(settings.toolIdentifier ?? "SHELL", {
    name: toolName,
    descriptionGenerator: (descriptionProps: { readonly allTools?: Record<string, { readonly name?: string }> } = {}) => getShellToolDescription(sandboxEnabled, shellPromptProfile, {
      isReadonly: settings.isReadonly,
      enableBlockUntilMs: settings.enableBlockUntilMs,
      requireBlockUntilMs: settings.requireBlockUntilMs,
      defaultBlockUntilMs,
      useMinimalHarness: settings.useMinimalHarness,
      enableJobCompletionNotifications: settings.enableJobCompletionNotifications,
      enableTerminalFiles: settings.enableTerminalFiles,
      // The other tools are named by the session's own names for them, not by their identifiers.
      awaitToolName: settings.awaitToolIdentifier === undefined ? undefined : descriptionProps.allTools?.[settings.awaitToolIdentifier]?.name ?? settings.awaitToolIdentifier,
      readToolName: settings.readToolIdentifier === undefined ? undefined : descriptionProps.allTools?.[settings.readToolIdentifier]?.name ?? settings.readToolIdentifier,
    }),
    parameters,
    execute: withSafeParsedArgs(parameters, execute as unknown as (toolCtx: Context, interactionHandler: unknown, args: unknown, executionMeta: unknown) => Promise<unknown>, createShellToolCallInterop({ args: emptyShellArgsInterop() })),
    render: async (_ctx: Context, result: ShellResultInterop) => createStringResult(renderShellResult(result, settings)),
    serializeError: shellFailureCall,
  })
}

/** Where the tool is placed in a session: with the external shell or with the box's own shell. */
export const SHELL_TOOL_FACTORY_PLACEMENT = "turn-toolset:externalShell|boxShell" as const
