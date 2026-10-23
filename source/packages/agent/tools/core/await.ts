/**
 * The tool a model uses to wait for background work without holding the turn open.
 *
 * Two kinds of work are waited on, and they are waited on differently. A shell job is polled through its
 * output file: the file's header says how long it has been running, its footer says it finished and with
 * what exit code, and everything between them is the output a regex is matched against. A subagent is
 * asked about instead, through the executor that knows whether it finished, and its answer is the
 * transcript path and length rather than output. The regex argument belongs to the shell case only: a
 * subagent's transcript is not a stream to match against, so asking for a regex there is refused rather
 * than silently ignored.
 *
 * Waiting is done in slices rather than in one sleep. A slice is short — a quarter second — and each
 * slice re-reads the file, so the wait ends as soon as the job finishes rather than at the end of the
 * requested duration. A wait with no task id is the exception: there is nothing to watch, so it sleeps
 * for the whole duration and says so.
 *
 * A user message arriving mid-wait ends the wait instead of being held behind it. The wait is released
 * with a wake reason, both when an injection is already pending and when one is admitted during a slice,
 * because a turn that is being steered must not keep sleeping.
 *
 * What the model is told about this tool is version-specific and mode-specific: a session that can be
 * notified about completed jobs is told not to poll reflexively, a session that cannot is told how to
 * poll well, and a session with no subagents is never told about waiting on them. The polling advice
 * also carries the prompt cache's own arithmetic, since a wait that lands just past the cache lifetime
 * costs a full re-read of the conversation.
 */

import { RE2JS } from "re2js"
import { z } from "zod"

import type { Context } from "../../../context/context.ts"
import { createSpan } from "../../../context/telemetry.ts"
import { createStringResult } from "../../../chat-inference/prompt-executor.ts"
import type { ResourceAccessor } from "../../../agent-exec/resource-provider.ts"
import type { RemoteExecManager } from "../../../agent-exec/executor-resources.ts"
import { lsExecutorResource } from "../../../agent-exec/ls.ts"
import { readExecutorResource } from "../../../agent-exec/read-operation.ts"
import { subagentExecutorResource } from "../../../agent-exec/subagent.ts"
import { subagentAwaitExecutorResource } from "../../../agent-exec/subagent-await.ts"
import { getConversationId } from "../../utils/request-scope.ts"
import { extractTerminalId } from "../../../utils/managed-paths.ts"
import {
  AwaitArgs,
  AwaitError,
  AwaitResult,
  AwaitSuccess,
  AwaitTaskComplete,
  AwaitTaskStillRunning,
  AwaitToolCall,
} from "../../../proto/generated/agent/v1/await_tool_pb.ts"
import { ReadArgs } from "../../../proto/generated/agent/v1/read_exec_pb.ts"
import { LsArgs } from "../../../proto/generated/agent/v1/ls_exec_pb.ts"
import {
  SubagentArgs,
  SubagentAwaitArgs,
  SubagentAwaitComplete,
  SubagentAwaitError,
  SubagentAwaitNotFound,
  SubagentAwaitResult,
  SubagentAwaitStillRunning,
} from "../../../proto/generated/agent/v1/subagent_exec_pb.ts"
import { ToolCall } from "../../../proto/generated/agent/v1/agent_pb.ts"
import { ToolCallAbortedError, ToolCallArgParseError, createZodAgentTool, withSafeParsedArgs } from "../tool-support.ts"
import { lenientNumber } from "../lenient-scalars.ts"

const DEFAULT_WAIT_MS = 30_000
const SHELL_POLL_SLICE_MS = 250
const TOOL_NAME_FULL = "Await"
const TOOL_NAME_SHELL_ONLY = "AwaitShell"
const SUBAGENT_WAIT_HINT = "Set this to true if you are waiting for subagent(s) to complete. Remember you should NOT be doing this and instead end your turn or do parallel work."
const SUBAGENT_WAIT_REFUSAL = "You should NOT wait for subagents to complete. End your turn instead; completions are queued, or do parallel work."
const STEER_WAKE_REASON = "context_injection"

type AwaitAccessor = ResourceAccessor<RemoteExecManager>

interface AwaitOptions {
  readonly toolName?: string
  readonly toolIdentifier?: string
  readonly terminalsFolder?: string | (() => string)
  readonly agentTranscriptsFolder?: string
  readonly enableSubagentAwaiting?: boolean
  readonly enableAwaitForSubagents?: boolean
  readonly useTrainingShellOnlyPrompt?: boolean
  readonly fixClaudeSubagentAwait?: boolean
  readonly enableBoundedSubagentAwait?: boolean
  readonly enableJobCompletionNotifications?: boolean
  readonly promptCacheTTLMs?: number
  readonly enableAwaitTerminalPathCompat?: boolean
  readonly defaultBlockUntilMs?: number
  readonly requireBlockUntilMs?: boolean
  readonly defaultSubagentType?: string
  readonly defaultModelId?: string
}

interface ExecutionMeta {
  readonly toolCallId: string
  readonly contextInjectionSignal?: {
    hasPendingUserInjections(): boolean
    onUserInjectionAdmitted(listener: () => void): () => void
  }
}

interface InteractionHandlerBridge {
  executeToolCall(
    ctx: Context,
    toolCall: ToolCall,
    callId: string,
    execute: (ctx: Context) => Promise<AwaitResult>,
    merge: (result: AwaitResult) => ToolCall,
  ): Promise<AwaitResult>
}

function awaitCallOf(value: AwaitToolCall): ToolCall {
  return new ToolCall({ tool: { case: "awaitToolCall", value } })
}

function wholeNonNegative(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}

/** A task id of "none" is how some models say they have none, so it counts as omitted. */
function taskIdOrEmpty(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed.length === 0 || trimmed.toLowerCase() === "none" ? "" : trimmed
}

function looksLikeShellId(taskId: string): boolean {
  return /^[0-9]+$/.test(taskId)
}

/** The terminals folder is resolved late, since it is read when a wait actually needs it. */
function resolveTerminalsFolder(value: string | (() => string) | undefined): string {
  return typeof value === "function" ? value() : value ?? ""
}

function underFolder(base: string, leaf: string): string {
  return `${base.endsWith("/") ? base.slice(0, -1) : base}/${leaf}`
}

function failIfAborted(ctx: Context): void {
  if (ctx.signal.aborted) throw new ToolCallAbortedError()
}

/**
 * Sleeps for a slice, and gives up early when the user says something: an injection already pending
 * releases the wait before it starts, and one admitted during the slice releases it where it stands.
 */
function sleepUnlessSteered(ctx: Context, milliseconds: number, signal: ExecutionMeta["contextInjectionSignal"]): Promise<"timeout" | "steer_release"> {
  failIfAborted(ctx)
  if (signal?.hasPendingUserInjections()) return Promise.resolve("steer_release")
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined
    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout)
      ctx.signal.removeEventListener("abort", onAbort)
      unsubscribe?.()
    }
    const onAbort = () => {
      cleanup()
      reject(new ToolCallAbortedError())
    }
    ctx.signal.addEventListener("abort", onAbort, { once: true })
    timeout = setTimeout(() => {
      cleanup()
      resolve("timeout")
    }, milliseconds)
    unsubscribe = signal?.onUserInjectionAdmitted(() => {
      cleanup()
      resolve("steer_release")
    })
  })
}

/** The footer a finished job leaves: its exit code and how long it ran. */
function readJobFooter(content: string): { isComplete: boolean; runtimeMs?: number; exitCode?: number } {
  const match = content.match(/\n---\n([\s\S]*?)\n---\s*$/)
  if (match === null) return { isComplete: false }
  const jobEnding = match[1] ?? ""
  const exit = jobEnding.match(/(?:^|\n)exit_code:\s*([^\n]*)/)?.[1]?.trim() ?? ""
  const parsedExit = Number(exit)
  const elapsed = jobEnding.match(/(?:^|\n)elapsed_ms:\s*(\d+)/)?.[1]
  return {
    isComplete: true,
    ...(elapsed === undefined ? {} : { runtimeMs: Number(elapsed) }),
    ...(exit.length > 0 && Number.isInteger(parsedExit) ? { exitCode: parsedExit } : {}),
  }
}

/** The header a running job carries, which is how a wait reports progress before there is a footer. */
function readRunningMilliseconds(content: string): number | undefined {
  const match = content.match(/^---\r?\n[\s\S]*?(?:^|\r?\n)running_for_ms:\s*(\d+)[\s\S]*?\r?\n---/m)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/** A regex is matched against the output itself, never against the header or the footer. */
function jobOutputBody(content: string): string {
  let body = content
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---\n", 4)
    if (end >= 0) body = body.slice(end + 5)
  }
  const jobEnding = body.match(/\n---\n[\s\S]*?\n---\s*$/)
  return jobEnding?.index === undefined ? body : body.slice(0, jobEnding.index)
}

function compileOutputMatcher(pattern: string | undefined): { matched(content: string): { matched: boolean; firstMatch: string } } | undefined {
  if (pattern === undefined || pattern.trim().length === 0) return undefined
  const compiled = RE2JS.compile(pattern, RE2JS.MULTILINE)
  return {
    matched(content) {
      const outputMatcher = compiled.matcher(content)
      if (!outputMatcher.find()) return { matched: false, firstMatch: "" }
      return { matched: true, firstMatch: outputMatcher.group() ?? "" }
    },
  }
}

interface JobFileSnapshot { readonly exists: boolean; readonly content: string; readonly outputLength: number }

/** The file as it stands right now, which is what every wait slice is decided from. */
async function readJobFile(ctx: Context, resourceAccessor: AwaitAccessor, path: string, toolCallId: string): Promise<JobFileSnapshot> {
  const result = await resourceAccessor.get(readExecutorResource).execute(ctx, new ReadArgs({ path, toolCallId }))
  switch (result.result.case) {
    case "success": {
      const output = result.result.value.output
      const content = output.case === "content" ? output.value : output.case === "data" ? Buffer.from(output.value).toString("utf8") : ""
      const outputLength = Number(result.result.value.fileSize)
      return { exists: true, content, outputLength: Number.isFinite(outputLength) && outputLength > 0 ? outputLength : content.length }
    }
    case "fileNotFound": return { exists: false, content: "", outputLength: 0 }
    case "permissionDenied": throw new Error(`Permission denied reading ${path}`)
    case "rejected": throw new Error(result.result.value.reason || `Read rejected for ${path}`)
    case "invalidFile": throw new Error(result.result.value.reason || `Invalid file: ${path}`)
    case "error": throw new Error(result.result.value.error || `Read failed for ${path}`)
    case undefined: throw new Error(`Unknown read result for ${path}`)
  }
}

/** A transcript is found by walking the listing, since the folder it lands in depends on the run. */
function findInTree(root: { absPath: string; childrenFiles: readonly { name: string }[]; childrenDirs: readonly { absPath: string; childrenFiles: readonly { name: string }[]; childrenDirs: readonly unknown[] }[] } | undefined, name: string): string | undefined {
  if (root === undefined) return undefined
  const stack: Array<typeof root> = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    const file = node.childrenFiles.find(candidate => candidate.name === name)
    if (file !== undefined) return underFolder(node.absPath, file.name)
    for (const child of node.childrenDirs) stack.push(child as typeof root)
  }
  return undefined
}

/**
 * Where a subagent's transcript is: tried at the paths it is known to land in, then found by listing,
 * and left unknown rather than guessed when none of them has it.
 */
async function findSubagentTranscript(ctx: Context, resourceAccessor: AwaitAccessor, taskId: string, folder: string | undefined, toolCallId: string, parentConversationId: string | undefined): Promise<string | undefined> {
  if (folder === undefined || folder.length === 0) return undefined
  const candidates = [underFolder(folder, `${taskId}.jsonl`), underFolder(folder, `${taskId}/${taskId}.jsonl`), ...(parentConversationId === undefined ? [] : [underFolder(folder, `${parentConversationId}/subagents/${taskId}.jsonl`)])]
  for (const candidate of candidates) {
    if ((await readJobFile(ctx, resourceAccessor, candidate, toolCallId).catch(() => undefined))?.exists === true) return candidate
  }
  const listed = await resourceAccessor.get(lsExecutorResource).execute(ctx, new LsArgs({ path: folder, toolCallId, timeoutMs: 2_000 })).catch(() => undefined)
  const tree = listed?.result.case === "success" || listed?.result.case === "timeout" ? listed.result.value.directoryTreeRoot : undefined
  return findInTree(tree, `${taskId}.jsonl`)
}

/** A success that carries no await result at all is reported as an unknown result, not as a success. */
function awaitResultShape(result: AwaitResult["result"]): AwaitResult["result"] {
  if (result.case === "success") return result.value.awaitResult?.case === undefined ? { case: undefined } : result.value.awaitResult
  if (result.case === "error") return result
  return { case: undefined }
}

function awaitParameters(options: { enableSubagentAwaiting: boolean; defaultBlockUntilMs: number; requireBlockUntilMs: boolean; training: boolean; includeWaitingSignal: boolean }) {
  const blockDescription = options.requireBlockUntilMs ? `Max sleep time to block before returning (in milliseconds). Required. Set to 0 for non-blocking status check.` : `Max sleep time to block before returning (in milliseconds). Defaults to ${options.defaultBlockUntilMs}ms. Set to 0 for non-blocking status check.`
  const block = (options.requireBlockUntilMs ? lenientNumber() : lenientNumber().optional()).describe(blockDescription)
  const idNoun = options.enableSubagentAwaiting && !options.training ? "shell or subagent" : "shell"
  const id = z.preprocess(value => typeof value === "number" ? String(value) : value, z.string().optional()).describe(`Optional ${idNoun} id to poll. If omitted, this tool sleeps for the full block_until_ms duration and then returns. Required when block_until_ms is 0.`)
  const pattern = z.string().optional().describe(options.enableSubagentAwaiting
    ? "Block until the regex matches stdout/stderr stream (or task completes). Matches anywhere in the shell output, not just new output. Will not match terminal file headers or footers, e.g. exit_code. Accepts JavaScript regex patterns (compiled with the multiline `m` flag). Not supported for awaiting subagents: you MUST leave this argument unset."
    : "Block until the regex matches stdout/stderr stream (or task completes). Matches anywhere in the shell output, not just new output. Will not match terminal file headers or footers, e.g. exit_code. Accepts JavaScript regex patterns (compiled with the multiline `m` flag).")
  // Without subagent awaiting the tool only knows the shell's own argument name, so the model's shell_id is
  // read as a task id; the waiting signal exists only for the version that asks for it.
  if (!options.enableSubagentAwaiting && !options.training) {
    return z.preprocess(raw => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw
      const normalized = { ...(raw as Record<string, unknown>) }
      if (normalized.shell_id === undefined && normalized.task_id !== undefined) normalized.shell_id = normalized.task_id
      return normalized
    }, z.object({ shell_id: id, block_until_ms: block, pattern, ...(options.includeWaitingSignal ? { waiting_for_subagent: z.boolean().optional().describe(SUBAGENT_WAIT_HINT) } : {}) }).transform(({ shell_id, ...rest }) => ({ task_id: shell_id, ...rest })))
  }
  return z.object({ task_id: id, block_until_ms: block, pattern })
}

/** An older client sends the terminal file's path instead of its id, and the id is what a wait needs. */
function legacyPathArguments(raw: unknown, compat: boolean): unknown {
  if (!compat || raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw
  const value = { ...(raw as Record<string, unknown>) }
  if (value.task_id !== undefined || value.shell_id !== undefined) return value
  if (typeof value.path !== "string") throw new Error("path must be a path to a terminal file")
  const terminal = extractTerminalId(value.path)
  if (terminal === null) throw new Error("path must be a path to a terminal file")
  value.task_id = String(terminal.id)
  return value
}

function hoursLabel(minutes: number): string {
  const hours = minutes / 60
  return Number.isInteger(hours) ? `${hours}` : hours.toFixed(1)
}

/**
 * How long to wait, given how long the prompt cache lasts: a slice just under the cache lifetime is
 * cheap, and a wait just past it pays for the conversation to be read again.
 */
function cacheWaitGuidance(milliseconds: number): string {
  const ttlSeconds = Math.round(milliseconds / 1_000)
  const ttlMinutes = Math.round(ttlSeconds / 60)
  if (ttlMinutes === 1) return `When waiting further, avoid round 1-minute waits: prefer slices of up to ${ttlSeconds - 30}s (keeps prompt cache warm) or ${ttlSeconds * 4}s+ (one cache miss buys a long wait).`
  if (ttlMinutes >= 1 && ttlMinutes <= 30) return `When waiting further, avoid round ${ttlMinutes}-minute waits: prefer slices of 60–${ttlSeconds - 30}s (keeps prompt cache warm) or ${ttlSeconds * 4}s+ (one cache miss buys a long wait).`
  if (ttlMinutes <= 6 * 60) return `When waiting further, avoid waiting ${hoursLabel(ttlMinutes)}h or more: prefer slices of 60s-${ttlMinutes - 1}m (keeps prompt cache warm). Size slices based on expected progress; when progress is unclear, exponential backoff is useful.`
  return "When waiting further, size slices based on expected progress. When progress is unclear, exponential backoff is useful."
}

function legacyDescription(options: { enableSubagentAwaiting: boolean; hasShell: boolean }): string {
  const idNoun = options.enableSubagentAwaiting ? "task id" : "shell id"
  const idArg = options.enableSubagentAwaiting ? "task_id" : "shell_id"
  const shellOnlyGuidance = options.hasShell ? `
- Shell only guidance:
  - Waiting until a regex matches the output can be useful for e.g. known startup/status/error logs.
  - HARD STOPPING CONSTRAINT: Don't stop polling until (a) job terminates, (b) the command reaches a healthy steady state (only for non-terminating command, e.g. dev server/watcher), or (c) command is hung - follow guidance below.
  - Output file header has \`pid\` and \`running_for_ms\` (updated every 5000ms).
  - When finished, footer with \`exit_code\` and \`elapsed_ms\` appears (regex only matches the body, not header/footer).
  - If taking longer than expected and the command seems like it is hung (use judgment based on type of command), kill the process if safe to do so using the pid that appears in the header. If possible, try to fix the hang and proceed.` : ""
  return `Poll a background ${options.enableSubagentAwaiting ? "shell or subagent" : "shell"} job. For work that does not have a ${idNoun}, you can omit the ${idArg} arg to sleep for the full \`block_until_ms\` duration (prefer this over sleeping in the shell, because it renders nicely to the user).

Monitor backgrounded jobs as follows:
- Never poll a task whose tool result says it was "manually backgrounded by the user".
- When you spawn a command directly into the background (\`block_until_ms: 0\`), check status immediately by reading the output file to confirm the command didn't fail to start.
- Poll repeatedly to monitor by using this tool between checks (set \`block_until_ms\` to control how long to wait). If the file gets large, read from the end of the file to capture the latest content.
- Pick your polling intervals using best guess/judgment based on any knowledge you have about the command and its expected runtime, and any output from monitoring the job. When no new output, exponential backoff is useful, e.g. 2000ms, 4000ms, 8000ms, 16000ms...${shellOnlyGuidance}`
}

function notifyFirstDescription(options: { enableSubagentAwaiting: boolean; hasShell: boolean; toolName: string; taskToolName?: string; promptCacheTTLMs?: number }): string {
  const jobNoun = options.enableSubagentAwaiting ? "shell or subagent" : "shell"
  const idNoun = options.enableSubagentAwaiting ? "task id" : "shell id"
  const idArg = options.enableSubagentAwaiting ? "task_id" : "shell_id"
  const promptCacheGuidance = options.promptCacheTTLMs === undefined ? "When waiting further, avoid round 5-minute waits: prefer slices of 60–270s (keeps prompt cache warm) or 1200s+ (one cache miss buys a long wait)." : cacheWaitGuidance(options.promptCacheTTLMs)
  // A session that is notified when a subagent finishes is told not to wait for one at all.
  const neverPollSubagent = options.taskToolName !== undefined && !options.enableSubagentAwaiting ? `
- NEVER USE THIS TO POLL OR WAIT VACUOUSLY FOR A SUBAGENT LAUNCHED WITH THE ${options.taskToolName} TOOL — rely on the end-of-turn completion notification instead (it is delivered as soon as the subagent finishes; guessing a wait time is inefficient).` : ""
  const subagentRule = options.enableSubagentAwaiting ? `
- Subagents: never wait on a subagent with ${options.toolName}. Subagents are always notify-on-completion — multitask on independent work (or respond to the user if there is nothing else productive to do) and wait to be woken up. The only valid use of ${options.toolName} on a subagent is a non-blocking status check (\`block_until_ms: 0\`); never use it to block on the subagent finishing.` : ""
  const shellGuidance = options.hasShell ? `
- Shell: only poll with ${options.toolName} when the command requires close monitoring. Close monitoring means a long-running job that can silently hang, degrade, or need a course correction before it completes — e.g. training runs, eval runs, deployments, long builds, datagen pipelines, DB migrations, large data transfers. For fire-and-forget commands (tests, installs, dev servers/watchers, short scripts, etc.) the completion notification is enough — start them, keep working, and only poll with ${options.toolName} later if you end up blocked on the result.
- Shell sanity check (regardless of close monitoring): when you spawn a command directly into the background (\`block_until_ms: 0\`), do a single status check by reading the output file to confirm the command didn't fail to start. This is a one-shot smoke check, not a polling loop.
- Shell close-monitoring guidance:
  - HARD STOPPING CONSTRAINT: once you've decided to actively poll, don't stop until (a) the job terminates, (b) the command reaches a healthy steady state (only for non-terminating commands, e.g. dev server/watcher), or (c) the command is hung — follow the hang guidance below.
  - Waiting until a regex matches the output can be useful for e.g. known startup/status/error logs.
  - Size \`block_until_ms\` to the command's expected runtime. ${promptCacheGuidance}
  - Output file header has \`pid\` and \`running_for_ms\` (updated every 5000ms).
  - When finished, footer with \`exit_code\` and \`elapsed_ms\` appears (regex only matches the body, not header/footer).
  - If the command is taking longer than expected and appears hung, kill it if safe using the pid in the header. If possible, fix the hang and proceed.` : ""
  const blockedScope = options.enableSubagentAwaiting ? " (shell jobs only — never wait on a subagent)" : ""
  const closeMonitoringClause = options.enableSubagentAwaiting ? " Subagents are never a candidate for close monitoring." : ""
  const positivePollBlock = options.hasShell ? `

Prefer NOT to poll reflexively with ${options.toolName}. Multitask on independent work while backgrounded jobs run, or finish your turn and rely on the end-of-turn completion notification. Poll with ${options.toolName} only when one of the following is true:
- Your very next step is blocked on this specific job's result and you have no other productive work to do${blockedScope}, OR
- The task requires close monitoring (see shell guidance below).${closeMonitoringClause}` : `

Prefer NOT to poll reflexively with ${options.toolName}. Multitask on independent work while backgrounded jobs run, or finish your turn and rely on the end-of-turn completion notification.`
  return `Check or poll a backgrounded ${jobNoun} job. For work that does not have a ${idNoun}, you can omit the ${idArg} arg to sleep for the full \`block_until_ms\` duration (prefer this over sleeping in the shell, because it renders nicely to the user). At the end of your turn, you will be notified about any unawaited jobs that completed. If you think a job completed (e.g. because you killed it), observe it with ${options.toolName} to skip the notification, because stale notifications can confuse the user.${positivePollBlock}
- Never poll a task whose tool result says it was "manually backgrounded by the user".${neverPollSubagent}${subagentRule}${shellGuidance}`
}

export type AwaitToolResourceAccessor = AwaitAccessor
export interface AwaitToolOptions extends AwaitOptions {}

/** What one wait is asked to watch, read from the arguments the wrapper already parsed. */
interface AwaitRequest {
  readonly taskId: string
  readonly blockUntilMs: number
  readonly pattern?: string
}

/** The fields the handler needs from a parsed call: the wait itself, and whether it was asking for a subagent wait. */
function awaitRequestOf(raw: unknown, fallbackBlockUntilMs: number): { request: AwaitRequest; waitingRequested: boolean } {
  const values = raw as { task_id?: string; shell_id?: string; block_until_ms?: number; pattern?: string; waiting_for_subagent?: boolean }
  return {
    waitingRequested: values.waiting_for_subagent === true,
    request: {
      taskId: taskIdOrEmpty(values.task_id ?? values.shell_id),
      blockUntilMs: wholeNonNegative(values.block_until_ms, fallbackBlockUntilMs),
      ...(values.pattern === undefined ? {} : { pattern: values.pattern }),
    },
  }
}

/** The result of a wait with nothing to watch: the duration slept, or a sleep the user's message cut short. */
function sleptAwaitResult(startMs: number, outcome: "timeout" | "steer_release"): AwaitResult {
  return new AwaitResult({ result: { case: "success", value: new AwaitSuccess({ awaitResult: { case: "complete", value: new AwaitTaskComplete({ taskId: "", runtimeMs: BigInt(Date.now() - startMs), outputFilePath: "", outputLength: 0n, regexRequested: false, ...(outcome === "steer_release" ? { wakeReason: STEER_WAKE_REASON } : {}) }) } }) } })
}

/** The result a finished shell job reports, with its exit code when the footer carried one. */
function completedShellResult(request: AwaitRequest, runtimeMs: number, jobFile: string, outputLength: number, matchedText: string | undefined, exitCode: number | undefined): AwaitResult {
  return new AwaitResult({ result: { case: "success", value: new AwaitSuccess({ awaitResult: { case: "complete", value: new AwaitTaskComplete({ taskId: request.taskId, runtimeMs: BigInt(runtimeMs), outputFilePath: jobFile, outputLength: BigInt(outputLength), regexRequested: typeof request.pattern === "string" && request.pattern.trim().length > 0, ...(matchedText === undefined ? {} : { regexMatch: matchedText }), ...(exitCode === undefined ? {} : { exitCode }) }) } }) } })
}

/** The result a shell job that is still running reports, whether the wait ran out, was a status check, or was steered. */
function runningShellResult(request: AwaitRequest, runtimeMs: number, jobFile: string, outputLength: number, matchedText: string | undefined, steered: boolean): AwaitResult {
  return new AwaitResult({ result: { case: "success", value: new AwaitSuccess({ awaitResult: { case: "stillRunning", value: new AwaitTaskStillRunning({ taskId: request.taskId, runtimeMs: BigInt(runtimeMs), outputFilePath: jobFile, outputLength: BigInt(outputLength), regexRequested: typeof request.pattern === "string" && request.pattern.trim().length > 0, ...(matchedText === undefined ? {} : { regexMatch: matchedText }), ...(steered ? { wakeReason: STEER_WAKE_REASON } : {}) }) } }) } })
}

/**
 * Waits on a subagent task: a bounded wait asks the subagent-await executor, and a plain resume asks the
 * subagent executor read-only. Either way the answer is the transcript path and its length, found by
 * listing when the executor did not name its own path.
 */
async function subagentAwaitResult(
  toolCtx: Context,
  resourceAccessor: AwaitAccessor,
  options: AwaitToolOptions,
  toolCallId: string,
  request: AwaitRequest,
  startMs: number,
): Promise<AwaitResult> {
  const parentConversationId = getConversationId(toolCtx)
  if (!parentConversationId) throw new Error("Awaiting subagent tasks requires a non-empty conversationId in the agent context")
  // A bounded wait is one call that returns when the subagent finishes; otherwise the wait is a
  // read-only resume of the subagent, which is what reports its transcript.
  const result = options.enableBoundedSubagentAwait === true
    ? await resourceAccessor.get(subagentAwaitExecutorResource).execute(toolCtx, new SubagentAwaitArgs({ agentId: request.taskId, timeoutMs: request.blockUntilMs }))
    : await resourceAccessor.get(subagentExecutorResource).execute(toolCtx, new SubagentArgs({ toolCallId, resumeAgentId: request.taskId, parentConversationId, prompt: "", readonly: true, runInBackground: false, subagentType: options.defaultSubagentType ?? "generalPurpose", modelId: options.defaultModelId ?? "default-model" }))
  if (!("result" in result) || result.result.case !== "complete") throw new Error("Failed to await subagent task")
  const complete = result.result.value
  const transcriptPath = "transcriptPath" in complete ? complete.transcriptPath : await findSubagentTranscript(toolCtx, resourceAccessor, request.taskId, options.agentTranscriptsFolder, toolCallId, parentConversationId)
  const jobFileSnapshot = transcriptPath === undefined ? undefined : await readJobFile(toolCtx, resourceAccessor, transcriptPath, toolCallId).catch(() => undefined)
  return new AwaitResult({ result: { case: "success", value: new AwaitSuccess({ awaitResult: { case: "complete", value: new AwaitTaskComplete({ taskId: request.taskId, runtimeMs: BigInt(Date.now() - startMs), outputFilePath: transcriptPath ?? "", outputLength: BigInt(jobFileSnapshot?.outputLength ?? 0) }) } }) } })
}

/**
 * Waits on a shell job in quarter-second slices: every slice re-reads the output file, and the wait stops
 * as soon as the job finished, the pattern matched, the time is up, the caller wanted a status check, or
 * the user said something.
 */
async function shellAwaitResult(
  toolCtx: Context,
  resourceAccessor: AwaitAccessor,
  options: AwaitToolOptions,
  toolCallId: string,
  request: AwaitRequest,
  startMs: number,
  injectionSignal: ExecutionMeta["contextInjectionSignal"],
): Promise<AwaitResult> {
  const regexRequested = typeof request.pattern === "string" && request.pattern.trim().length > 0
  const outputMatcher = compileOutputMatcher(request.pattern)
  const terminalsRoot = resolveTerminalsFolder(options.terminalsFolder)
  if (!terminalsRoot) throw new Error("Cannot await shell task: terminals folder is unavailable")
  const jobFile = underFolder(terminalsRoot, `${request.taskId}.txt`)
  const waitDeadline = Date.now() + request.blockUntilMs
  let steeredDuringSlice = false
  while (true) {
    failIfAborted(toolCtx)
    const jobFileSnapshot = await readJobFile(toolCtx, resourceAccessor, jobFile, toolCallId)
    if (!jobFileSnapshot.exists) throw new Error(`No shell found for id ${request.taskId}`)
    const jobEnding = readJobFooter(jobFileSnapshot.content)
    const runtimeMs = jobEnding.runtimeMs ?? readRunningMilliseconds(jobFileSnapshot.content) ?? Math.max(0, Date.now() - startMs)
    const matchFound = outputMatcher?.matched(jobOutputBody(jobFileSnapshot.content))
    const matchedText = regexRequested && matchFound?.matched === true ? matchFound.firstMatch.slice(0, 500) : undefined
    // A wait ends when the job finished, when there is no time left to wait, when the caller asked for a
    // status check, or when the user has something to say.
    const steerNow = steeredDuringSlice || injectionSignal?.hasPendingUserInjections() === true
    const outcome = jobEnding.isComplete ? "complete" : request.blockUntilMs === 0 || Date.now() >= waitDeadline || steerNow ? "stillRunning" : undefined
    if (outcome === "complete") return completedShellResult(request, runtimeMs, jobFile, jobFileSnapshot.outputLength, matchedText, jobEnding.exitCode)
    if (outcome === "stillRunning") return runningShellResult(request, runtimeMs, jobFile, jobFileSnapshot.outputLength, matchedText, steerNow)
    // The pattern matched before the job finished, which is an answer in itself.
    if (matchFound?.matched === true) return runningShellResult(request, runtimeMs, jobFile, jobFileSnapshot.outputLength, matchFound.firstMatch.slice(0, 500), false)
    if (await sleepUnlessSteered(toolCtx, SHELL_POLL_SLICE_MS, injectionSignal) === "steer_release") steeredDuringSlice = true
  }
}

/** What the model is told a wait returned: a sleep, a finished job, a still-running one, or a failure. */
function renderAwaitResult(output: AwaitResult): string {
  const normalized = awaitResultShape(output.result)
  if (normalized.case === "complete") {
    const value = normalized.value
    if (!value.taskId) return value.wakeReason === STEER_WAKE_REASON ? "Slept briefly. Sleep released early: a new user message is arriving." : "Slept briefly."
    return `Task completed in ${value.runtimeMs.toString()}ms with exit code: ${value.exitCode ?? "unknown"}.\noutput_file_path: ${value.outputFilePath}\noutput_length: ${value.outputLength.toString()}`
  }
  if (normalized.case === "stillRunning") return `Task still running after ${normalized.value.runtimeMs.toString()}ms...\noutput_file_path: ${normalized.value.outputFilePath}\noutput_length: ${normalized.value.outputLength.toString()}`
  if (normalized.case === "error") return `Error awaiting task: ${normalized.value.error}`
  return "Unknown error"
}

/** The prompt versions whose wait advice this tool knows, checked before any description is built. */
const KNOWN_PROMPT_VERSIONS = ["cursor-0226", "dsv3-1205", "dsv3-1018", "gpt5-codex", "codex-cloud", "latest", "haiku"]

/** The description the model is given for this tool, by prompt version and by how it is configured. */
function awaitDescriptionFor(
  promptVersion: string,
  toolName: string,
  training: boolean,
  enableSubagentAwaiting: boolean,
  mentionSubagents: boolean,
  shellToolName: string | undefined,
  taskToolName: string | undefined,
  options: AwaitToolOptions,
): string {
  if (training) return "Poll a background shell."
  if (!KNOWN_PROMPT_VERSIONS.includes(promptVersion)) throw new Error(`Unhandled version: ${promptVersion}`)
  return options.enableJobCompletionNotifications === true
    ? notifyFirstDescription({ enableSubagentAwaiting: mentionSubagents, hasShell: shellToolName !== undefined, toolName, ...(taskToolName === undefined ? {} : { taskToolName }), ...(options.promptCacheTTLMs === undefined ? {} : { promptCacheTTLMs: options.promptCacheTTLMs }) })
    : legacyDescription({ enableSubagentAwaiting: mentionSubagents, hasShell: shellToolName !== undefined })
}

export function createAwaitTool(resourceAccessor: AwaitAccessor, options: AwaitToolOptions, promptVersion = "latest") {
  const training = options.useTrainingShellOnlyPrompt === true
  const enableSubagentAwaiting = options.enableSubagentAwaiting === true && options.enableAwaitForSubagents !== false && !training
  const derivedName = !enableSubagentAwaiting && !training ? TOOL_NAME_SHELL_ONLY : TOOL_NAME_FULL
  const name = options.toolName ?? derivedName
  const includeWaitingSignal = options.fixClaudeSubagentAwait === true && derivedName === TOOL_NAME_SHELL_ONLY
  const defaultBlockUntilMs = options.defaultBlockUntilMs ?? DEFAULT_WAIT_MS
  const parameters = awaitParameters({ enableSubagentAwaiting, defaultBlockUntilMs, requireBlockUntilMs: options.requireBlockUntilMs === true, training, includeWaitingSignal })
  const parsing = z.preprocess(raw => legacyPathArguments(raw, options.enableAwaitTerminalPathCompat === true), parameters)

  // The wrapper hands the handler and the parsed arguments over as unknowns, since it does not know this
  // tool's own types; the arguments have just been parsed against this tool's schema, so they are asserted
  // here rather than re-checked.
  const execute = async (parent: Context, bridge: unknown, raw: unknown, meta: ExecutionMeta): Promise<AwaitResult> => {
    const callBridge = bridge as InteractionHandlerBridge
    const { request, waitingRequested } = awaitRequestOf(raw, defaultBlockUntilMs)
    using executionSpan = createSpan(parent.withName("awaitExecute"))
    const ctx = executionSpan.ctx
    const baseAwaitCall = new AwaitToolCall({ args: new AwaitArgs({ taskId: request.taskId, blockUntilMs: request.blockUntilMs, ...(request.pattern === undefined ? {} : { regex: request.pattern }) }) })
    return callBridge.executeToolCall(ctx, awaitCallOf(baseAwaitCall), meta.toolCallId, async toolCtx => {
      // Waiting for a subagent is the one thing this tool must not be used for, so asking for it is refused.
      if (includeWaitingSignal && waitingRequested) throw new ToolCallArgParseError(SUBAGENT_WAIT_REFUSAL)
      const startMs = Date.now()
      if (request.taskId.length === 0) {
        if (request.blockUntilMs === 0) throw new Error("Must pass a task id or wait for a nonzero duration.")
        return sleptAwaitResult(startMs, await sleepUnlessSteered(toolCtx, request.blockUntilMs, meta.contextInjectionSignal))
      }
      if (!looksLikeShellId(request.taskId)) {
        if (!enableSubagentAwaiting) throw new ToolCallArgParseError(SUBAGENT_WAIT_REFUSAL)
        if (typeof request.pattern === "string" && request.pattern.trim().length > 0) throw new ToolCallArgParseError("Regex awaiting is not available for subagents. Run Await without regex, or await a shell task id instead.")
        return subagentAwaitResult(toolCtx, resourceAccessor, options, meta.toolCallId, request, startMs)
      }
      return shellAwaitResult(toolCtx, resourceAccessor, options, meta.toolCallId, request, startMs, meta.contextInjectionSignal)
    }, result => awaitCallOf(new AwaitToolCall({ ...baseAwaitCall, result })))
  }

  return createZodAgentTool(options.toolIdentifier ?? "AWAIT", {
    name,
    contextType: { type: "dynamic", conciseStaticContext: "Use to sleep and check shell progress. Never sleep using shell." },
    descriptionGenerator: (props: { allTools: Record<string, { name?: string }> }) => {
      const shellToolName = props.allTools.SHELL?.name
      const taskToolName = props.allTools.TASK?.name
      const mentionSubagents = enableSubagentAwaiting && taskToolName !== undefined
      return awaitDescriptionFor(promptVersion, name, training, enableSubagentAwaiting, mentionSubagents, shellToolName, taskToolName, options)
    },
    parameters,
    execute: withSafeParsedArgs(parsing, execute, awaitCallOf(new AwaitToolCall())),
    render: async (_ctx: Context, output: AwaitResult) => createStringResult(renderAwaitResult(output)),
    serializeError: error => awaitCallOf(new AwaitToolCall({ result: new AwaitResult({ result: { case: "error", value: new AwaitError({ error: error instanceof Error ? error.message : String(error) }) } }) })),
  })
}
