/**
 * Running a command through a terminal executor with the platform's own environment.
 *
 * Everything a command needs to know about the session it is running in is put into its environment here: the marker
 * that says it is running under the agent, the conversation it belongs to, the folder its transcripts go to, the
 * askpass helper a sudo prompt reaches, and the variables that belong to one request rather than to the shell, which
 * are restored after the command so they cannot leak into the next one. The sandbox policy is widened by whatever the
 * agent store needs to be readable, and the command's own policy is what the executor is given.
 *
 * The output is bounded twice: each stream is cut off at the buffer size and says so, and output past a threshold is
 * written to a file in the project's own tool folder instead of being carried in the result, which is what keeps a
 * large build's log readable without keeping it in the conversation. What comes back is where the output went, how long
 * the command took, and how it ended.
 */
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { Context } from "../context/context.ts";
import { OutputLocation } from "../proto/generated/agent/v1/utils_pb.ts";
import { SHELL_OUTPUT_SUPPRESSED_NOTICE } from "../shell-exec/output-suppression.ts";
import type { TerminalExecutor } from "../shell-exec/index.ts";
import { getSafeConversationId, TRANSCRIPTS_SUBDIR } from "../utils/conversation-paths.ts";
import { MAX_BUFFER_SIZE } from "./constants.ts";
import type { SandboxRule } from "./sandbox-conversion.ts";

const REQUEST_SCOPED_SHELL_ENV_KEYS = ["SLATE_CONVERSATION_ID", "SLATE_AGENT_STORE_FILES_DIR", "SLATE_AGENT_STORE_SHARED_PATHS"] as const;
const MAX_OUTPUT_FILE_SIZE = 50 * 1024 * 1024;
const AGENT_TOOLS_DIR = "agent-tools";
const isWindows = process.platform === "win32";

export type { SandboxRule } from "./sandbox-conversion.ts";
export type SandboxPolicy = { perUser?: SandboxRule; perRepo?: SandboxRule; teamAdmin?: SandboxRule };
function shellSingleQuote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
function effectiveEnv(env: NodeJS.ProcessEnv, key: string): string | undefined { return env[key] ?? process.env[key]; }
function appendRequestScopedEnvRestore(env: NodeJS.ProcessEnv): void {
  const parts = [`builtin unset ${REQUEST_SCOPED_SHELL_ENV_KEYS.join(" ")} 2>/dev/null || true`];
  for (const key of REQUEST_SCOPED_SHELL_ENV_KEYS) { const value = effectiveEnv(env, key); if (value !== undefined) parts.push(`builtin export ${key}=${shellSingleQuote(value)}`); }
  env.__SLATE_SANDBOX_ENV_RESTORE = [process.env.__SLATE_SANDBOX_ENV_RESTORE?.trim(), env.__SLATE_SANDBOX_ENV_RESTORE?.trim(), parts.join("; ")].filter((part) => part !== undefined && part !== "").join("; ");
}
function appendUnique(paths: string[] | undefined, value: string): string[] { const next = paths === undefined ? [] : [...paths]; if (!next.includes(value)) next.push(value); return next; }
function parseSharedPaths(value: string | undefined): Array<{ path: string; readOnly: boolean }> {
  if (value === undefined) return [];
  try { const parsed: unknown = JSON.parse(value); if (typeof parsed !== "object" || parsed === null) return []; const result: Array<{ path: string; readOnly: boolean }> = []; for (const entry of Object.values(parsed)) if (typeof entry === "object" && entry !== null && "path" in entry && "readOnly" in entry && typeof entry.path === "string" && typeof entry.readOnly === "boolean") result.push({ path: entry.path, readOnly: entry.readOnly }); return result; } catch { return []; }
}
function agentStoreSandboxPolicyFromEnv(policy: SandboxPolicy | undefined, env: NodeJS.ProcessEnv): SandboxPolicy | undefined {
  const filesDir = effectiveEnv(env, "SLATE_AGENT_STORE_FILES_DIR"); const shared = parseSharedPaths(effectiveEnv(env, "SLATE_AGENT_STORE_SHARED_PATHS"));
  if (filesDir === undefined && shared.length === 0) return policy;
  const reference = policy?.perRepo ?? policy?.perUser ?? policy?.teamAdmin;
  if (reference?.type !== "workspace_readwrite" && reference?.type !== "workspace_readonly") return policy;
  const perUser = { type: reference.type, ...(policy?.perUser?.additionalReadwritePaths === undefined ? {} : { additionalReadwritePaths: [...policy.perUser.additionalReadwritePaths] }), ...(policy?.perUser?.additionalReadonlyPaths === undefined ? {} : { additionalReadonlyPaths: [...policy.perUser.additionalReadonlyPaths] }) };
  const add = (path: string, readOnly: boolean): void => { if (!readOnly && perUser.type === "workspace_readwrite") perUser.additionalReadwritePaths = appendUnique(perUser.additionalReadwritePaths, path); else perUser.additionalReadonlyPaths = appendUnique(perUser.additionalReadonlyPaths, path); };
  if (filesDir !== undefined) add(filesDir, false); for (const entry of shared) add(entry.path, entry.readOnly);
  return { ...policy, perUser };
}

export interface ShellCoreArgs {
  readonly command: string; readonly workingDirectory?: string; readonly signal?: AbortSignal; readonly conversationId?: string;
  readonly sandboxPolicy?: SandboxPolicy; readonly pipeStdin?: boolean; readonly fileOutputThresholdBytes?: number;
  readonly askpassConfig?: { helperPath: string; socketPath: string; secret: string }; readonly toolCallId?: string; readonly showElapsedTime?: boolean;
}
export type ShellCoreEvent =
  | { readonly type: "start"; readonly sandboxed: boolean }
  | { readonly type: "stdout" | "stderr"; readonly data: string }
  | { readonly type: "stdout_trimmed" | "stderr_trimmed" }
  | { readonly type: "stdin_ready"; readonly stdin: NodeJS.WritableStream | undefined; readonly pid: number | undefined }
  | { readonly type: "sandbox_denies"; readonly events: readonly unknown[] }
  | { readonly type: "exit"; readonly code: number | null; readonly aborted: boolean; readonly outputLocation?: OutputLocation; readonly localExecutionTimeMs: number };

export interface ShellOutputBackpressureOptions { readonly bufferOutputEvents?: boolean; readonly outputLimiterOptions?: unknown }
export class BaseShellCoreExecutor {
  constructor(private readonly executor: TerminalExecutor, private readonly workspacePath?: string, private readonly projectDir?: string, private readonly shellOutputBackpressureOptions?: ShellOutputBackpressureOptions, private readonly extraEnvProvider?: (ctx: Context, args: ShellCoreArgs) => NodeJS.ProcessEnv | undefined) {}
  async *execute(ctx: Context, args: ShellCoreArgs): AsyncIterable<ShellCoreEvent> {
    const started = performance.now(); const requested = args.workingDirectory || await this.executor.getCwd(); const cwd = this.workspacePath === undefined ? resolve(requested) : resolve(this.workspacePath, requested);
    let stdoutSize = 0, stderrSize = 0, suppressionNoticeSent = false, stdoutTrimmed = false, stderrTrimmed = false;
    let merged: { buffer: string; lineCount: number; size: number; threshold: number; path?: string; file?: WriteStream } | undefined;
    if (args.fileOutputThresholdBytes && this.projectDir) merged = { buffer: "", lineCount: 0, size: 0, threshold: Number(args.fileOutputThresholdBytes) };
    const env: NodeJS.ProcessEnv = { SLATE_AGENT: "1" };
    if (args.conversationId) env.SLATE_CONVERSATION_ID = getSafeConversationId(args.conversationId);
    if (this.projectDir) env.SLATE_AGENT_TRANSCRIPTS = join(this.projectDir, TRANSCRIPTS_SUBDIR);
    Object.assign(env, this.extraEnvProvider?.(ctx, args)); appendRequestScopedEnvRestore(env);
    const sandboxPolicy = agentStoreSandboxPolicyFromEnv(args.sandboxPolicy, env); const policyType = sandboxPolicy?.perRepo?.type ?? sandboxPolicy?.perUser?.type ?? sandboxPolicy?.teamAdmin?.type ?? "insecure_none";
    if (sandboxPolicy !== undefined) yield { type: "start", sandboxed: policyType === "workspace_readonly" || policyType === "workspace_readwrite" };
    if (args.askpassConfig && !isWindows) { env.SUDO_ASKPASS = args.askpassConfig.helperPath; env.SLATE_ASKPASS_SOCKET = args.askpassConfig.socketPath; env.SLATE_ASKPASS_SECRET = args.askpassConfig.secret; }
    for await (const event of this.executor.execute(ctx, args.command, { ...(args.signal === undefined ? {} : { signal: args.signal }), workingDirectory: cwd, env, ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }), ...(this.workspacePath === undefined ? {} : { sandboxWorkspaceRoot: this.workspacePath }), pipeStdin: args.pipeStdin ?? false, ...(this.shellOutputBackpressureOptions?.bufferOutputEvents === undefined ? {} : { bufferOutputEvents: this.shellOutputBackpressureOptions.bufferOutputEvents }), ...(this.shellOutputBackpressureOptions?.outputLimiterOptions === undefined ? {} : { outputLimiterOptions: this.shellOutputBackpressureOptions.outputLimiterOptions }) })) {
      let text = "", size = 0;
      if (event.type === "stdout" || event.type === "stderr") { text = event.data.toString(); size = event.data.length; if (merged) { merged.size += size; merged.lineCount += text.split("\n").length - 1; if (merged.size <= MAX_OUTPUT_FILE_SIZE) { if (merged.file) merged.file.write(text); else { merged.buffer += text; if (merged.size > merged.threshold && this.projectDir) { const dir = join(this.projectDir, AGENT_TOOLS_DIR); merged.path = join(dir, `${randomUUID()}.txt`); await mkdir(dirname(merged.path), { recursive: true }); merged.file = createWriteStream(merged.path); merged.file.write(merged.buffer); merged.buffer = ""; } } } } }
      if (event.type === "stdout" && !stdoutTrimmed) { if (stdoutSize + size > MAX_BUFFER_SIZE) { stdoutTrimmed = true; yield { type: "stdout_trimmed" }; } else { stdoutSize += size; yield { type: "stdout", data: text }; } }
      else if (event.type === "suppressed_output" && !suppressionNoticeSent) { suppressionNoticeSent = true; yield { type: "stdout", data: SHELL_OUTPUT_SUPPRESSED_NOTICE }; }
      else if (event.type === "stderr" && !stderrTrimmed) { if (stderrSize + size > MAX_BUFFER_SIZE) { stderrTrimmed = true; yield { type: "stderr_trimmed" }; } else { stderrSize += size; yield { type: "stderr", data: text }; } }
      else if (event.type === "stdin_ready") yield { type: "stdin_ready", stdin: event.stdin, pid: event.pid };
      else if (event.type === "sandbox_denies") yield { type: "sandbox_denies", events: event.events };
      else if (event.type === "exit") { let outputLocation: OutputLocation | undefined; if (merged?.file && merged.path) { await new Promise<void>((done) => merged?.file?.end(done)); outputLocation = new OutputLocation({ filePath: merged.path, sizeBytes: BigInt(merged.size), lineCount: BigInt(merged.lineCount) }); } yield { type: "exit", code: event.code, aborted: event.aborted, ...(outputLocation === undefined ? {} : { outputLocation }), localExecutionTimeMs: Math.max(0, Math.round(performance.now() - started)) }; }
    }
  }
  getCwd(): Promise<string> { return this.executor.getCwd(); }
  getWorkspacePath(): string { if (!this.workspacePath) throw new Error("Workspace path is not configured"); return this.workspacePath; }
}
