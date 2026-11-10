import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { appendFile, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { BOX_TERMINAL_VIRTUAL_PREFIX } from "./terminal-paths.ts"

export interface BoxEnvironmentPatch {
  readonly env: Readonly<Record<string, string>>
  readonly replace?: boolean
}

export interface BoxReadRequest {
  readonly path: string
  readonly encodingHint?: string
  readonly offset?: number
  readonly limit?: number
}

export type BoxReadResult =
  | { readonly kind: "success"; readonly path: string; readonly content: string; readonly totalLines: number; readonly fileSize: bigint; readonly truncated: boolean; readonly rangeApplied: boolean }
  | { readonly kind: "invalid-file"; readonly path: string; readonly reason: string }
  | { readonly kind: "rejected"; readonly path: string; readonly reason: string }
  | { readonly kind: "file-not-found"; readonly path: string }
  | { readonly kind: "permission-denied"; readonly path: string }
  | { readonly kind: "error"; readonly path: string; readonly error: string }

export interface BoxShellRequest {
  readonly command: string
  readonly workingDirectory: string
  readonly timeout: number
}

export type BoxShellResult =
  | { readonly kind: "spawn-error"; readonly command: string; readonly workingDirectory: string; readonly error: string }
  | { readonly kind: "timeout"; readonly command: string; readonly workingDirectory: string; readonly timeoutMs: number }
  | {
      readonly kind: "success" | "failure"
      readonly command: string
      readonly workingDirectory: string
      readonly exitCode: number
      readonly signal: string
      readonly stdout: string
      readonly stderr: string
      readonly executionTime: number
      readonly localExecutionTimeMs: number
      readonly interleavedOutput: string
      readonly aborted?: boolean
    }

export type BoxShellStreamEvent =
  | { readonly kind: "start" }
  | { readonly kind: "stdout" | "stderr"; readonly data: string }
  | { readonly kind: "exit"; readonly code: number; readonly cwd: string; readonly aborted: boolean; readonly localExecutionTimeMs: number }

export interface BoxBackgroundShellRequest {
  readonly command: string
  readonly workingDirectory: string
}

export type BoxBackgroundShellResult =
  | { readonly kind: "success"; readonly shellId: number; readonly command: string; readonly workingDirectory: string; readonly pid?: number }
  | { readonly kind: "error"; readonly command: string; readonly workingDirectory: string; readonly error: string }

export interface BoxWriteShellInputRequest {
  readonly shellId: number
  readonly chars: string
}

export type BoxWriteShellInputResult =
  | { readonly kind: "success"; readonly shellId: number; readonly terminalFileLengthBeforeInputWritten: number }
  | { readonly kind: "error"; readonly error: string }

interface BackgroundProcess {
  readonly shellProcess: ChildProcessWithoutNullStreams
  readonly terminalPath: string
  readonly startedAt: number
  writeQueue: Promise<void>
}

interface ProcessOutcome {
  readonly code: number
  readonly signal: string
  readonly stdout: string
  readonly stderr: string
  readonly elapsedMs: number
  readonly timedOut: boolean
  readonly aborted: boolean
}

class PathRejectedError extends Error {}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function jsonString(value: string): string {
  return JSON.stringify(value)
}

function terminalHeader(args: BoxBackgroundShellRequest, pid: number | undefined, startedAt: number): string {
  return `---\n${pid == null ? "" : `pid: ${pid}\n`}cwd: ${jsonString(args.workingDirectory)}\ncommand: ${jsonString(args.command)}\nstatus: running\nstarted_at: ${new Date(startedAt).toISOString()}\nrunning_for_ms: 0\n---\n`
}

function terminalTrailer(exitCode: number, startedAt: number): string {
  return `\n---\nexit_code: ${exitCode}\nelapsed_ms: ${Date.now() - startedAt}\nended_at: ${new Date().toISOString()}\n---\n`
}

export class BoxExecRuntime {
  readonly #environment: NodeJS.ProcessEnv
  readonly #foreground = new Set<ChildProcessWithoutNullStreams>()
  readonly #background = new Map<number, BackgroundProcess>()
  #nextShellId = 1

  constructor(readonly workspaceRoot: string, readonly terminalsDirectory: string, environment: NodeJS.ProcessEnv) {
    this.#environment = { ...environment }
  }

  applyEnvPatch(call: BoxEnvironmentPatch): { applied: number; removed: number } {
    let removed = 0
    if (call.replace) {
      for (const key of Object.keys(this.#environment)) {
        if (!(key in call.env)) {
          delete this.#environment[key]
          removed += 1
        }
      }
    }
    for (const [key, value] of Object.entries(call.env)) this.#environment[key] = value
    return { applied: Object.keys(call.env).length, removed }
  }

  mapPath(requested: string): string {
    const logical = requested.length === 0 ? "/workspace" : requested
    if (logical.startsWith(BOX_TERMINAL_VIRTUAL_PREFIX)) {
      const terminalName = logical.slice(BOX_TERMINAL_VIRTUAL_PREFIX.length)
      if (!/^\d+\.txt$/.test(terminalName)) throw new PathRejectedError(`Rejected terminal virtual path: ${requested}`)
      return path.join(this.terminalsDirectory, terminalName)
    }
    const mapped = logical === "/workspace"
      ? this.workspaceRoot
      : logical.startsWith("/workspace/")
        ? path.join(this.workspaceRoot, logical.slice("/workspace/".length))
        : path.isAbsolute(logical)
          ? logical
          : path.join(this.workspaceRoot, logical)
    const resolved = path.resolve(mapped)
    const relative = path.relative(this.workspaceRoot, resolved)
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved
    throw new PathRejectedError(`Path escapes configured workspace root: ${requested}`)
  }

  assertInsideRoots(target: string, requested: string): void {
    for (const allowedRoot of [this.workspaceRoot, this.terminalsDirectory]) {
      const relative = path.relative(allowedRoot, target)
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return
    }
    throw new PathRejectedError(`Resolved path escapes configured roots: ${requested}`)
  }

  async readFileAttrs(args: BoxReadRequest): Promise<BoxReadResult> {
    try {
      const target = this.mapPath(args.path)
      const directInfo = await lstat(target)
      if (directInfo.isSymbolicLink()) throw new PathRejectedError(`Symbolic-link reads are not permitted: ${args.path}`)
      const canonical = await realpath(target)
      this.assertInsideRoots(canonical, args.path)
      const info = await stat(canonical)
      if (!info.isFile()) return { kind: "invalid-file", path: args.path, reason: "Path is not a regular file" }
      if (args.encodingHint != null && args.encodingHint !== "utf8" && args.encodingHint !== "utf-8" && args.encodingHint !== "latin1") {
        return { kind: "invalid-file", path: args.path, reason: `Unsupported encoding hint: ${args.encodingHint}` }
      }
      const data = await readFile(canonical)
      const text = data.toString(args.encodingHint === "latin1" ? "latin1" : "utf8")
      const lines = text.split("\n")
      const offset = Math.max(0, args.offset ?? 0)
      const limit = args.limit == null ? lines.length : Math.max(0, args.limit)
      return {
        kind: "success",
        path: args.path,
        content: lines.slice(offset, offset + limit).join("\n"),
        totalLines: lines.length,
        fileSize: BigInt(data.byteLength),
        truncated: offset > 0 || offset + limit < lines.length,
        rangeApplied: args.offset != null || args.limit != null,
      }
    } catch (error) {
      if (error instanceof PathRejectedError) return { kind: "rejected", path: args.path, reason: error.message }
      const code = typeof error === "object" && error != null && "code" in error ? String(error.code) : undefined
      if (code === "ENOENT" || code === "ENOTDIR") return { kind: "file-not-found", path: args.path }
      if (code === "EACCES" || code === "EPERM") return { kind: "permission-denied", path: args.path }
      if (code === "EISDIR" || code === "EINVAL" || code === "ENAMETOOLONG") return { kind: "invalid-file", path: args.path, reason: messageOf(error) }
      return { kind: "error", path: args.path, error: messageOf(error) }
    }
  }

  async runCommand(args: BoxShellRequest, abortSignal: AbortSignal): Promise<BoxShellResult> {
    let cwd: string
    try {
      cwd = this.mapPath(args.workingDirectory)
    } catch (error) {
      return { kind: "spawn-error", command: args.command, workingDirectory: args.workingDirectory, error: messageOf(error) }
    }
    const outcome = await this.runCommandCollect(args.command, cwd, args.timeout > 0 ? args.timeout : undefined, abortSignal)
    if (outcome.timedOut) return { kind: "timeout", command: args.command, workingDirectory: args.workingDirectory, timeoutMs: args.timeout }
    const kind = outcome.code === 0 && !outcome.aborted ? "success" : "failure"
    return {
      kind,
      command: args.command,
      workingDirectory: args.workingDirectory,
      exitCode: outcome.code,
      signal: outcome.signal,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      executionTime: outcome.elapsedMs,
      localExecutionTimeMs: outcome.elapsedMs,
      interleavedOutput: `${outcome.stdout}${outcome.stderr}`,
      ...(kind === "failure" ? { aborted: outcome.aborted } : {}),
    }
  }

  async *streamCommand(args: BoxShellRequest, abortSignal: AbortSignal): AsyncGenerator<BoxShellStreamEvent> {
    const cwd = this.mapPath(args.workingDirectory)
    yield { kind: "start" }
    const shellProcess = this.launchShell(args.command, cwd)
    this.#foreground.add(shellProcess)
    const startedAt = Date.now()
    const streamEvents: Array<{ kind: "stdout" | "stderr"; data: string }> = []
    let wake: (() => void) | undefined
    let done = false
    let exitCode = 1
    let exitSignal = ""
    const notify = () => { wake?.(); wake = undefined }
    shellProcess.stdout.on("data", data => { streamEvents.push({ kind: "stdout", data: String(data) }); notify() })
    shellProcess.stderr.on("data", data => { streamEvents.push({ kind: "stderr", data: String(data) }); notify() })
    shellProcess.once("close", (code, childSignal) => { exitCode = code ?? 1; exitSignal = childSignal ?? ""; done = true; notify() })
    const abort = () => this.terminate(shellProcess)
    abortSignal.addEventListener("abort", abort, { once: true })
    const timer = args.timeout > 0 ? setTimeout(() => this.terminate(shellProcess), args.timeout) : undefined
    try {
      while (!done || streamEvents.length > 0) {
        while (streamEvents.length > 0) yield streamEvents.shift()!
        if (!done) await new Promise<void>(resolve => { wake = resolve })
      }
      yield { kind: "exit", code: exitCode, cwd: args.workingDirectory, aborted: abortSignal.aborted, localExecutionTimeMs: Date.now() - startedAt }
      void exitSignal
    } finally {
      if (timer != null) clearTimeout(timer)
      abortSignal.removeEventListener("abort", abort)
      this.#foreground.delete(shellProcess)
      if (!done) this.terminate(shellProcess)
    }
  }

  async startBackgroundShell(args: BoxBackgroundShellRequest): Promise<BoxBackgroundShellResult> {
    try {
      const cwd = this.mapPath(args.workingDirectory)
      await mkdir(this.terminalsDirectory, { recursive: true })
      const shellId = this.#nextShellId++
      const terminalPath = path.join(this.terminalsDirectory, `${shellId}.txt`)
      const startedAt = Date.now()
      const shellProcess = this.launchShell(args.command, cwd)
      const process: BackgroundProcess = {
        shellProcess,
        terminalPath,
        startedAt,
        writeQueue: writeFile(terminalPath, terminalHeader(args, shellProcess.pid, startedAt)),
      }
      this.#background.set(shellId, process)
      const queueWrite = (data: string | Uint8Array) => {
        process.writeQueue = process.writeQueue.then(() => appendFile(terminalPath, data))
      }
      shellProcess.stdout.on("data", data => { queueWrite(data) })
      shellProcess.stderr.on("data", data => { queueWrite(data) })
      shellProcess.once("close", code => {
        this.#background.delete(shellId)
        queueWrite(terminalTrailer(code ?? 1, startedAt))
      })
      return { kind: "success", shellId, command: args.command, workingDirectory: args.workingDirectory, ...(shellProcess.pid == null ? {} : { pid: shellProcess.pid }) }
    } catch (error) {
      return { kind: "error", command: args.command, workingDirectory: args.workingDirectory, error: messageOf(error) }
    }
  }

  async writeShellInput(args: BoxWriteShellInputRequest): Promise<BoxWriteShellInputResult> {
    const running = this.#background.get(args.shellId)
    if (running == null) return { kind: "error", error: `Shell ${args.shellId} is not running` }
    const before = Number((await stat(running.terminalPath)).size)
    await new Promise<void>((resolve, reject) => running.shellProcess.stdin.write(args.chars, error => error == null ? resolve() : reject(error)))
    return { kind: "success", shellId: args.shellId, terminalFileLengthBeforeInputWritten: before }
  }

  async stop(): Promise<void> {
    for (const shellProcess of this.#foreground) this.terminate(shellProcess)
    for (const process of this.#background.values()) this.terminate(process.shellProcess)
    this.#foreground.clear()
    this.#background.clear()
  }

  private launchShell(command: string, cwd: string): ChildProcessWithoutNullStreams {
    return spawn("/bin/sh", ["-lc", command], { cwd, env: this.#environment, detached: process.platform !== "win32", stdio: "pipe" })
  }

  private terminate(shellProcess: ChildProcessWithoutNullStreams): void {
    if (shellProcess.exitCode != null || shellProcess.signalCode != null) return
    try {
      if (process.platform !== "win32" && shellProcess.pid != null) process.kill(-shellProcess.pid, "SIGTERM")
      else shellProcess.kill("SIGTERM")
    } catch {}
  }

  private async runCommandCollect(command: string, cwd: string, timeoutMs: number | undefined, abortSignal: AbortSignal): Promise<ProcessOutcome> {
    const shellProcess = this.launchShell(command, cwd)
    this.#foreground.add(shellProcess)
    const startedAt = Date.now()
    let stdout = ""
    let stderr = ""
    let timedOut = false
    shellProcess.stdout.on("data", data => { stdout += String(data) })
    shellProcess.stderr.on("data", data => { stderr += String(data) })
    const abort = () => this.terminate(shellProcess)
    abortSignal.addEventListener("abort", abort, { once: true })
    const timer = timeoutMs == null ? undefined : setTimeout(() => { timedOut = true; this.terminate(shellProcess) }, timeoutMs)
    try {
      const outcome = await new Promise<{ code: number; signal: string }>((resolve, reject) => {
        shellProcess.once("error", reject)
        shellProcess.once("close", (code, childSignal) => resolve({ code: code ?? 1, signal: childSignal ?? "" }))
      })
      return { ...outcome, stdout, stderr, elapsedMs: Date.now() - startedAt, timedOut, aborted: abortSignal.aborted }
    } finally {
      if (timer != null) clearTimeout(timer)
      abortSignal.removeEventListener("abort", abort)
      this.#foreground.delete(shellProcess)
    }
  }
}
