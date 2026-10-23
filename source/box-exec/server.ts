/** The box's own exec daemon: what runs commands inside the box and answers the host's calls.

 * It serves the box's controlElement and exec operations over the daemon's own connection, behind the token it was started
 * with: capabilities and environment, the MCP servers it may load, a command that streams as it runs, a runCommand that
 * keeps running after the call, and the terminal file a background runCommand writes into. Every path a caller names is
 * mapped into the workspace the daemon was given and checked against it, so a call can act on the box and on nothing
 * else. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { appendFile, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { connectNodeAdapter } from "@connectrpc/connect-node";
import { MethodKind, type ServiceType } from "@bufbuild/protobuf";

import { ControlService } from "../packages/proto/generated/agent/v1/control_service_connect.ts";
import { ExecService } from "../packages/proto/generated/agent/v1/exec_service_connect.ts";
import {
  GetCapabilitiesResponse,
  LoadMcpServersResponse,
  PingResponse,
  UpdateEnvironmentVariablesResponse,
  type UpdateEnvironmentVariablesRequest,
} from "../packages/proto/generated/agent/v1/control_service_pb.ts";
import {
  ExecClientControlMessage,
  ExecClientMessage,
  ExecClientStreamClose,
  ExecClientThrow,
  type ExecServerMessage,
} from "../packages/proto/generated/agent/v1/exec_pb.ts";
import { ExecStreamElement } from "../packages/proto/generated/agent/v1/exec_service_pb.ts";
import {
  BackgroundShellSpawnError,
  BackgroundShellSpawnResult,
  BackgroundShellSpawnSuccess,
  WriteShellStdinError,
  WriteShellStdinResult,
  WriteShellStdinSuccess,
  type BackgroundShellSpawnArgs,
  type WriteShellStdinArgs,
} from "../packages/proto/generated/agent/v1/background_shell_exec_pb.ts";
import {
  ReadError,
  ReadFileNotFound,
  ReadInvalidFile,
  ReadPermissionDenied,
  ReadRejected,
  ReadResult,
  ReadSuccess,
  type ReadArgs,
} from "../packages/proto/generated/agent/v1/read_exec_pb.ts";
import {
  ShellFailure,
  ShellResult,
  ShellSpawnError,
  ShellStream,
  ShellStreamExit,
  ShellStreamStart,
  ShellStreamStderr,
  ShellStreamStdout,
  ShellSuccess,
  ShellTimeout,
  type ShellArgs,
} from "../packages/proto/generated/agent/v1/shell_exec_pb.ts";

// Recovered generated descriptors predate `satisfies ServiceType` and therefore
// widen MethodKind during TypeScript reconstruction. Re-declaring only the
// daemon-owned routes preserves their exact names/message types and restores the
// literal method kinds required by Connect's implementation type inference.
const BoxControlService = {
  typeName: ControlService.typeName,
  methods: {
    ping: { ...ControlService.methods.ping, kind: MethodKind.Unary },
    getCapabilities: { ...ControlService.methods.getCapabilities, kind: MethodKind.Unary },
    updateEnvironmentVariables: { ...ControlService.methods.updateEnvironmentVariables, kind: MethodKind.Unary },
    loadMcpServers: { ...ControlService.methods.loadMcpServers, kind: MethodKind.Unary },
  },
} as const satisfies ServiceType;

const BoxExecService = {
  typeName: ExecService.typeName,
  methods: { exec: { ...ExecService.methods.exec, kind: MethodKind.ServerStreaming } },
} as const satisfies ServiceType;

export const BOX_EXEC_DAEMON_HOST = "127.0.0.1";
export const BOX_EXEC_DAEMON_PORT = 1337;
export const BOX_EXEC_DAEMON_AUTH_TOKEN = "local";
export const BOX_TERMINAL_VIRTUAL_PREFIX = "/root/.cursor/projects/workspace/terminals/";

export interface BoxExecDaemonOptions {
  readonly host?: string;
  readonly port?: number;
  readonly authToken?: string;
  readonly workspaceRoot: string;
  readonly terminalsDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface BoxExecDaemonHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly workspaceRoot: string;
  readonly terminalsDirectory: string;
  readonly ready: Promise<void>;
  isReady(): boolean;
  stop(): Promise<void>;
}

interface BackgroundProcess {
  readonly shellProcess: ChildProcessWithoutNullStreams;
  readonly terminalPath: string;
  readonly startedAt: number;
  writeQueue: Promise<void>;
}

interface ProcessOutcome {
  readonly code: number;
  readonly signal: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

class PathRejectedError extends Error {}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}

function terminalHeader(args: BackgroundShellSpawnArgs, pid: number | undefined, startedAt: number): string {
  return `---\n${pid == null ? "" : `pid: ${pid}\n`}cwd: ${jsonString(args.workingDirectory)}\ncommand: ${jsonString(args.command)}\nstatus: running\nstarted_at: ${new Date(startedAt).toISOString()}\nrunning_for_ms: 0\n---\n`;
}

function terminalTrailer(exitCode: number, startedAt: number): string {
  return `\n---\nexit_code: ${exitCode}\nelapsed_ms: ${Date.now() - startedAt}\nended_at: ${new Date().toISOString()}\n---\n`;
}

function clientElement(id: number, execId: string, message: ExecClientMessage["message"], elapsedMs?: number): ExecStreamElement {
  return new ExecStreamElement({
    element: {
      case: "execClientMessage",
      value: new ExecClientMessage({ id, execId, message, ...(elapsedMs == null ? {} : { localExecutionTimeMs: elapsedMs }) }),
    },
  });
}

function controlElement(id: number, message: ExecClientControlMessage["message"]): ExecStreamElement {
  return new ExecStreamElement({
    element: { case: "execClientControlMessage", value: new ExecClientControlMessage({ message }) },
  });
}

function closeElement(id: number): ExecStreamElement {
  return controlElement(id, { case: "streamClose", value: new ExecClientStreamClose({ id }) });
}

function throwElement(id: number, error: unknown, errorCode = "BOX_EXEC_DAEMON_ERROR"): ExecStreamElement {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return controlElement(id, {
    case: "throw",
    value: new ExecClientThrow({ id, error: normalized.message, ...(normalized.stack == null ? {} : { stackTrace: normalized.stack }), errorCode }),
  });
}

class BoxExecRuntime {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #foreground = new Set<ChildProcessWithoutNullStreams>();
  readonly #background = new Map<number, BackgroundProcess>();
  #nextShellId = 1;

  constructor(readonly workspaceRoot: string, readonly terminalsDirectory: string, environment: NodeJS.ProcessEnv) {
    this.#environment = { ...environment };
  }

  applyEnvPatch(call: UpdateEnvironmentVariablesRequest): { applied: number; removed: number } {
    let removed = 0;
    if (call.replace) {
      for (const key of Object.keys(this.#environment)) {
        if (!(key in call.env)) {
          delete this.#environment[key];
          removed += 1;
        }
      }
    }
    for (const [key, value] of Object.entries(call.env)) this.#environment[key] = value;
    return { applied: Object.keys(call.env).length, removed };
  }

  mapPath(requested: string): string {
    const logical = requested.length === 0 ? "/workspace" : requested;
    if (logical.startsWith(BOX_TERMINAL_VIRTUAL_PREFIX)) {
      const terminalName = logical.slice(BOX_TERMINAL_VIRTUAL_PREFIX.length);
      if (!/^\d+\.txt$/.test(terminalName)) throw new PathRejectedError(`Rejected terminal virtual path: ${requested}`);
      return path.join(this.terminalsDirectory, terminalName);
    }
    const mapped = logical === "/workspace"
      ? this.workspaceRoot
      : logical.startsWith("/workspace/")
        ? path.join(this.workspaceRoot, logical.slice("/workspace/".length))
        : path.isAbsolute(logical)
          ? logical
          : path.join(this.workspaceRoot, logical);
    const resolved = path.resolve(mapped);
    const relative = path.relative(this.workspaceRoot, resolved);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
    throw new PathRejectedError(`Path escapes configured workspace root: ${requested}`);
  }

  assertInsideRoots(target: string, requested: string): void {
    for (const allowedRoot of [this.workspaceRoot, this.terminalsDirectory]) {
      const relative = path.relative(allowedRoot, target);
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
    }
    throw new PathRejectedError(`Resolved path escapes configured roots: ${requested}`);
  }

  async *dispatchCall(call: ExecServerMessage, abortSignal: AbortSignal): AsyncGenerator<ExecStreamElement> {
    try {
      switch (call.message.case) {
        case "readArgs":
        case "redactedReadArgs": {
          const result = await this.readFileAttrs(call.message.value);
          const resultCase = call.message.case === "readArgs" ? "readResult" : "redactedReadResult";
          yield clientElement(call.id, call.execId, { case: resultCase, value: result } as ExecClientMessage["message"]);
          break;
        }
        case "shellArgs":
        case "miniSweAgentBashArgs": {
          const result = await this.runCommand(call.message.value, abortSignal);
          const resultCase = call.message.case === "shellArgs" ? "shellResult" : "miniSweAgentBashResult";
          yield clientElement(call.id, call.execId, { case: resultCase, value: result } as ExecClientMessage["message"]);
          break;
        }
        case "shellStreamArgs":
          yield* this.streamCommand(call, call.message.value, abortSignal);
          break;
        case "backgroundShellSpawnArgs":
          yield clientElement(call.id, call.execId, { case: "backgroundShellSpawnResult", value: await this.startBackgroundShell(call.message.value) });
          break;
        case "writeShellStdinArgs":
          yield clientElement(call.id, call.execId, { case: "writeShellStdinResult", value: await this.writeShellInput(call.message.value) });
          break;
        default:
          yield throwElement(call.id, `Unsupported ExecServerMessage case: ${call.message.case ?? "unset"}`, "BOX_EXEC_UNSUPPORTED");
      }
    } catch (error) {
      yield throwElement(call.id, error);
    } finally {
      yield closeElement(call.id);
    }
  }

  async readFileAttrs(args: ReadArgs): Promise<ReadResult> {
    try {
      const target = this.mapPath(args.path);
      const directInfo = await lstat(target);
      if (directInfo.isSymbolicLink()) throw new PathRejectedError(`Symbolic-link reads are not permitted: ${args.path}`);
      const canonical = await realpath(target);
      this.assertInsideRoots(canonical, args.path);
      const info = await stat(canonical);
      if (!info.isFile()) return new ReadResult({ result: { case: "invalidFile", value: new ReadInvalidFile({ path: args.path, reason: "Path is not a regular file" }) } });
      if (args.encodingHint != null && args.encodingHint !== "utf8" && args.encodingHint !== "utf-8" && args.encodingHint !== "latin1") {
        return new ReadResult({ result: { case: "invalidFile", value: new ReadInvalidFile({ path: args.path, reason: `Unsupported encoding hint: ${args.encodingHint}` }) } });
      }
      const data = await readFile(canonical);
      const text = data.toString(args.encodingHint === "latin1" ? "latin1" : "utf8");
      const lineList = text.split("\n");
      const offset = Math.max(0, args.offset ?? 0);
      const limit = args.limit == null ? lineList.length : Math.max(0, args.limit);
      const content = lineList.slice(offset, offset + limit).join("\n");
      return new ReadResult({ result: { case: "success", value: new ReadSuccess({
        path: args.path,
        output: { case: "content", value: content },
        totalLines: lineList.length,
        fileSize: BigInt(data.byteLength),
        truncated: offset > 0 || offset + limit < lineList.length,
        rangeApplied: args.offset != null || args.limit != null,
      }) } });
    } catch (error) {
      if (error instanceof PathRejectedError) return new ReadResult({ result: { case: "rejected", value: new ReadRejected({ path: args.path, reason: error.message }) } });
      const code = typeof error === "object" && error != null && "code" in error ? String(error.code) : undefined;
      if (code === "ENOENT" || code === "ENOTDIR") return new ReadResult({ result: { case: "fileNotFound", value: new ReadFileNotFound({ path: args.path }) } });
      if (code === "EACCES" || code === "EPERM") return new ReadResult({ result: { case: "permissionDenied", value: new ReadPermissionDenied({ path: args.path }) } });
      if (code === "EISDIR" || code === "EINVAL" || code === "ENAMETOOLONG") return new ReadResult({ result: { case: "invalidFile", value: new ReadInvalidFile({ path: args.path, reason: messageOf(error) }) } });
      return new ReadResult({ result: { case: "error", value: new ReadError({ path: args.path, error: messageOf(error) }) } });
    }
  }

  async runCommand(args: ShellArgs, abortSignal: AbortSignal): Promise<ShellResult> {
    let cwd: string;
    try {
      cwd = this.mapPath(args.workingDirectory);
    } catch (error) {
      return new ShellResult({ result: { case: "spawnError", value: new ShellSpawnError({ command: args.command, workingDirectory: args.workingDirectory, error: messageOf(error) }) } });
    }
    const runOutcome = await this.runCommandCollect(args.command, cwd, args.timeout > 0 ? args.timeout : undefined, abortSignal);
    if (runOutcome.timedOut) return new ShellResult({ result: { case: "timeout", value: new ShellTimeout({ command: args.command, workingDirectory: args.workingDirectory, timeoutMs: args.timeout }) } });
    const sharedOutcome = {
      command: args.command,
      workingDirectory: args.workingDirectory,
      exitCode: runOutcome.code,
      signal: runOutcome.signal,
      stdout: runOutcome.stdout,
      stderr: runOutcome.stderr,
      executionTime: runOutcome.elapsedMs,
      interleavedOutput: `${runOutcome.stdout}${runOutcome.stderr}`,
      localExecutionTimeMs: runOutcome.elapsedMs,
    };
    return runOutcome.code === 0 && !runOutcome.aborted
      ? new ShellResult({ result: { case: "success", value: new ShellSuccess(sharedOutcome) } })
      : new ShellResult({ result: { case: "failure", value: new ShellFailure({ ...sharedOutcome, aborted: runOutcome.aborted }) } });
  }

  async *streamCommand(call: ExecServerMessage, args: ShellArgs, abortSignal: AbortSignal): AsyncGenerator<ExecStreamElement> {
    const cwd = this.mapPath(args.workingDirectory);
    yield clientElement(call.id, call.execId, { case: "shellStream", value: new ShellStream({ event: { case: "start", value: new ShellStreamStart() } }) });
    const shellProcess = this.launchShell(args.command, cwd);
    this.#foreground.add(shellProcess);
    const startedAt = Date.now();
    const streamEvents: Array<{ case: "stdout" | "stderr"; data: string }> = [];
    let wake: (() => void) | undefined;
    let done = false;
    let exitCode = 1;
    let exitSignal = "";
    const notify = () => { wake?.(); wake = undefined; };
    shellProcess.stdout.on("data", data => { streamEvents.push({ case: "stdout", data: String(data) }); notify(); });
    shellProcess.stderr.on("data", data => { streamEvents.push({ case: "stderr", data: String(data) }); notify(); });
    shellProcess.once("close", (code, childSignal) => { exitCode = code ?? 1; exitSignal = childSignal ?? ""; done = true; notify(); });
    const abort = () => this.terminate(shellProcess);
    abortSignal.addEventListener("abort", abort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    if (args.timeout > 0) timer = setTimeout(() => this.terminate(shellProcess), args.timeout);
    try {
      while (!done || streamEvents.length > 0) {
        while (streamEvents.length > 0) {
          const event = streamEvents.shift()!;
          yield clientElement(call.id, call.execId, {
            case: "shellStream",
            value: new ShellStream({ event: event.case === "stdout"
              ? { case: "stdout", value: new ShellStreamStdout({ data: event.data }) }
              : { case: "stderr", value: new ShellStreamStderr({ data: event.data }) } }),
          });
        }
        if (!done) await new Promise<void>(resolve => { wake = resolve; });
      }
      yield clientElement(call.id, call.execId, { case: "shellStream", value: new ShellStream({ event: { case: "exit", value: new ShellStreamExit({
        code: exitCode,
        cwd: args.workingDirectory,
        aborted: abortSignal.aborted,
        localExecutionTimeMs: Date.now() - startedAt,
      }) } }) });
      void exitSignal;
    } finally {
      if (timer != null) clearTimeout(timer);
      abortSignal.removeEventListener("abort", abort);
      this.#foreground.delete(shellProcess);
      if (!done) this.terminate(shellProcess);
    }
  }

  async startBackgroundShell(args: BackgroundShellSpawnArgs): Promise<BackgroundShellSpawnResult> {
    try {
      const cwd = this.mapPath(args.workingDirectory);
      await mkdir(this.terminalsDirectory, { recursive: true });
      const shellId = this.#nextShellId++;
      const terminalPath = path.join(this.terminalsDirectory, `${shellId}.txt`);
      const startedAt = Date.now();
      const shellProcess = this.launchShell(args.command, cwd);
      const process: BackgroundProcess = {
        shellProcess,
        terminalPath,
        startedAt,
        writeQueue: writeFile(terminalPath, terminalHeader(args, shellProcess.pid, startedAt)),
      };
      this.#background.set(shellId, process);
      const queueWrite = (data: string | Uint8Array) => {
        process.writeQueue = process.writeQueue.then(() => appendFile(terminalPath, data));
      };
      shellProcess.stdout.on("data", data => { queueWrite(data); });
      shellProcess.stderr.on("data", data => { queueWrite(data); });
      shellProcess.once("close", code => {
        this.#background.delete(shellId);
        queueWrite(terminalTrailer(code ?? 1, startedAt));
      });
      return new BackgroundShellSpawnResult({ result: { case: "success", value: new BackgroundShellSpawnSuccess({ shellId, command: args.command, workingDirectory: args.workingDirectory, ...(shellProcess.pid == null ? {} : { pid: shellProcess.pid }) }) } });
    } catch (error) {
      return new BackgroundShellSpawnResult({ result: { case: "error", value: new BackgroundShellSpawnError({ command: args.command, workingDirectory: args.workingDirectory, error: messageOf(error) }) } });
    }
  }

  async writeShellInput(args: WriteShellStdinArgs): Promise<WriteShellStdinResult> {
    const running = this.#background.get(args.shellId);
    if (running == null) return new WriteShellStdinResult({ result: { case: "error", value: new WriteShellStdinError({ error: `Shell ${args.shellId} is not running` }) } });
    const before = Number((await stat(running.terminalPath)).size);
    await new Promise<void>((resolve, reject) => running.shellProcess.stdin.write(args.chars, error => error == null ? resolve() : reject(error)));
    return new WriteShellStdinResult({ result: { case: "success", value: new WriteShellStdinSuccess({ shellId: args.shellId, terminalFileLengthBeforeInputWritten: before }) } });
  }

  async stop(): Promise<void> {
    for (const shellProcess of this.#foreground) this.terminate(shellProcess);
    for (const process of this.#background.values()) this.terminate(process.shellProcess);
    this.#foreground.clear();
    this.#background.clear();
  }

  private launchShell(command: string, cwd: string): ChildProcessWithoutNullStreams {
    return spawn("/bin/sh", ["-lc", command], { cwd, env: this.#environment, detached: process.platform !== "win32", stdio: "pipe" });
  }

  private terminate(shellProcess: ChildProcessWithoutNullStreams): void {
    if (shellProcess.exitCode != null || shellProcess.signalCode != null) return;
    try {
      if (process.platform !== "win32" && shellProcess.pid != null) process.kill(-shellProcess.pid, "SIGTERM");
      else shellProcess.kill("SIGTERM");
    } catch {}
  }

  private async runCommandCollect(command: string, cwd: string, timeoutMs: number | undefined, abortSignal: AbortSignal): Promise<ProcessOutcome> {
    const shellProcess = this.launchShell(command, cwd);
    this.#foreground.add(shellProcess);
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    shellProcess.stdout.on("data", data => { stdout += String(data); });
    shellProcess.stderr.on("data", data => { stderr += String(data); });
    const abort = () => this.terminate(shellProcess);
    abortSignal.addEventListener("abort", abort, { once: true });
    const timer = timeoutMs == null ? undefined : setTimeout(() => { timedOut = true; this.terminate(shellProcess); }, timeoutMs);
    try {
      const runOutcome = await new Promise<{ code: number; signal: string }>((resolve, reject) => {
        shellProcess.once("error", reject);
        shellProcess.once("close", (code, childSignal) => resolve({ code: code ?? 1, signal: childSignal ?? "" }));
      });
      return { ...runOutcome, stdout, stderr, elapsedMs: Date.now() - startedAt, timedOut, aborted: abortSignal.aborted };
    } finally {
      if (timer != null) clearTimeout(timer);
      abortSignal.removeEventListener("abort", abort);
      this.#foreground.delete(shellProcess);
    }
  }
}

function closeServer(daemonServer: Server): Promise<void> {
  return new Promise((resolve, reject) => daemonServer.close(error => error == null ? resolve() : reject(error)));
}

export async function startBoxExecDaemon(settings: BoxExecDaemonOptions): Promise<BoxExecDaemonHandle> {
  const bindHost = settings.host ?? BOX_EXEC_DAEMON_HOST;
  const bindPort = settings.port ?? BOX_EXEC_DAEMON_PORT;
  const expectedToken = settings.authToken ?? BOX_EXEC_DAEMON_AUTH_TOKEN;
  const workspaceRootInput = path.resolve(settings.workspaceRoot);
  const terminalsDirectoryInput = path.resolve(settings.terminalsDirectory ?? path.join(tmpdir(), "slate-box-terminals"));
  await mkdir(workspaceRootInput, { recursive: true });
  await mkdir(terminalsDirectoryInput, { recursive: true });
  const [workspaceRoot, terminalsDirectory] = await Promise.all([
    realpath(workspaceRootInput),
    realpath(terminalsDirectoryInput),
  ]);
  await stat(workspaceRoot).then(info => {
    if (!info.isDirectory()) throw new Error(`workspaceRoot is not a directory: ${workspaceRoot}`);
  });
  const execRuntime = new BoxExecRuntime(workspaceRoot, terminalsDirectory, settings.environment ?? process.env);
  const connectHandler = connectNodeAdapter({
    routes(router) {
      router.service(BoxControlService, {
        ping: async () => new PingResponse(),
        getCapabilities: async () => new GetCapabilitiesResponse({ computerUseSupported: false, installPluginArtifactSupported: false }),
        updateEnvironmentVariables: async call => new UpdateEnvironmentVariablesResponse(execRuntime.applyEnvPatch(call)),
        loadMcpServers: async () => new LoadMcpServersResponse(),
      });
      router.service(BoxExecService, { exec: (call, context) => execRuntime.dispatchCall(call, context.signal) });
    },
  });
  let daemonReady = false;
  const daemonServer = createServer((call, reply) => {
    if (call.headers.authorization !== `Bearer ${expectedToken}`) {
      reply.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      reply.end("Unauthorized");
      return;
    }
    connectHandler(call, reply);
  });
  const ready = new Promise<void>((resolve, reject) => {
    daemonServer.once("error", reject);
    daemonServer.listen(bindPort, bindHost, () => { daemonServer.off("error", reject); daemonReady = true; resolve(); });
  });
  await ready;
  const bindAddress = daemonServer.address();
  if (bindAddress == null || typeof bindAddress === "string") throw new Error("Box exec daemon did not expose a TCP address");
  let isStopped = false;
  return {
    host: bindHost,
    port: bindAddress.port,
    url: `http://${bindHost}:${bindAddress.port}`,
    workspaceRoot,
    terminalsDirectory,
    ready,
    isReady: () => daemonReady && !isStopped,
    async stop() {
      if (isStopped) return;
      isStopped = true;
      daemonReady = false;
      await execRuntime.stop();
      await closeServer(daemonServer);
    },
  };
}
