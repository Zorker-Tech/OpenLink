/**
 * Running a child process, as a stream and as a promise.
 *
 * Long-running commands are watched (their output arrives line by line, or as stdout/stderr pairs) and
 * short ones are awaited. Either way the same guarantees hold: the process is resolved through the
 * executable lookup first, its output is decoded with the caller's encoding, a timeout kills it
 * instead of leaking it, and a failure carries the exit code plus whatever the process managed to
 * print — which is usually the only useful part of a build failure.
 */

import { spawn as spawnChild, type SpawnOptions } from "node:child_process"

import { AsyncSubject, Observable, Subscription, merge, of, timer, type Observer, type Subject } from "rxjs"
import { map, reduce, retry as rxRetry } from "rxjs/operators"

import { findActualExecutable } from "./executable-lookup.ts"

interface ProcessInfo {
  pid?: number | undefined
}

export interface SpawnExtras {
  /** Written to the process's stdin; completing it closes the stream. */
  readonly stdin?: Observable<string> | undefined
  /** Also copy the child's output to this process's stdout/stderr. */
  readonly echoOutput?: boolean | undefined
  /** Emit `{ source, text }` per chunk instead of a single concatenated stream. */
  readonly split?: boolean | undefined
  readonly encoding?: BufferEncoding | undefined
  readonly timeout?: number | undefined
  readonly retries?: number | undefined
  readonly retryDelay?: number | undefined
  readonly processInfo?: ProcessInfo | undefined
}

export type SpawnOptionsWithExtras = SpawnOptions & SpawnExtras

export interface OutputChunk {
  readonly source: "stdout" | "stderr"
  readonly text: string
}

/** A process that failed, timed out or could not be started, with everything it printed. */
export class SpawnError extends Error {
  readonly exitCode: number
  readonly code: number
  readonly stdout: string | undefined
  readonly stderr: string | undefined
  readonly command: string
  readonly args: string[]

  constructor(message: string, exitCode: number, command: string, args: string[], stdout?: string, stderr?: string) {
    super(message)
    this.name = "SpawnError"
    this.exitCode = exitCode
    this.code = exitCode
    this.stdout = stdout
    this.stderr = stderr
    this.command = command
    this.args = args
    Error.captureStackTrace?.(this, SpawnError)
  }
}

export function spawn(
  executable: string,
  params: string[],
  options: SpawnOptionsWithExtras & { split: true },
): Observable<OutputChunk>
export function spawn(
  executable: string,
  params: string[],
  options?: SpawnOptionsWithExtras & { split?: false | undefined },
): Observable<string>
export function spawn(
  executable: string,
  params: string[],
  options?: SpawnOptionsWithExtras,
): Observable<string> | Observable<OutputChunk> {
  const settings = options ?? {}
  const chunks = new Observable<OutputChunk>((observer: Observer<OutputChunk>) => {
    const { encoding, timeout, ...spawnOptions } = settings
    const { cmd, args } = findActualExecutable(executable, params)
    const stdin = spawnOptions.stdin
    if (stdin) {
      delete spawnOptions.stdin
      spawnOptions.stdio ??= ["pipe", "pipe", "pipe"]
    }
    spawnOptions.stdio ??= ["ignore", "pipe", "pipe"]
    const child = spawnChild(cmd, args, spawnOptions)
    if (settings.processInfo && child.pid !== undefined) settings.processInfo.pid = child.pid

    let timeoutHandle: NodeJS.Timeout | null = null
    if (timeout && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        if (!child.killed) child.kill()
        observer.error(new SpawnError(`Process timed out after ${timeout}ms`, -1, cmd, args))
      }, timeout)
    }

    const emit = (source: OutputChunk["source"]) => (buffer: string | Buffer) => {
      if (buffer.length < 1) return
      if (settings.echoOutput) {
        (source === "stdout" ? globalThis.process.stdout : globalThis.process.stderr).write(buffer)
      }
      let text: string
      try {
        text = typeof buffer === "string" ? buffer : buffer.toString(encoding || "utf8")
      } catch {
        // A chunk in the wrong encoding must not take the stream down: report its size instead.
        text = `<< Lost chunk of process output for ${executable} - length was ${buffer.length}>>`
      }
      observer.next({ source, text })
    }

    const subscription = new Subscription()
    if (stdin) {
      if (child.stdin) {
        const input = child.stdin
        subscription.add(stdin.subscribe({
          next: value => input.write(value),
          error: error => observer.error(error),
          complete: () => input.end(),
        }))
      } else {
        observer.error(new Error("opts.stdio conflicts with provided spawn opts.stdin observable, 'pipe' is required"))
      }
    }

    // Completion waits for both pipes to close, so no output is lost to the exit.
    const stdoutClosed = pipeClosed(child.stdout, "stdout", emit("stdout"))
    const stderrClosed = pipeClosed(child.stderr, "stderr", emit("stderr"))

    let exited = false
    child.on("error", error => {
      exited = true
      if (timeoutHandle) clearTimeout(timeoutHandle)
      observer.error(error)
    })
    child.on("close", code => {
      exited = true
      if (timeoutHandle) clearTimeout(timeoutHandle)
      const pipesClosed = merge(stdoutClosed, stderrClosed).pipe(reduce(() => true, true))
      if (code === 0) pipesClosed.subscribe(() => observer.complete())
      else {
        pipesClosed.subscribe(() =>
          observer.error(new SpawnError(`Process failed with exit code: ${code}`, code ?? -1, cmd, args)))
      }
    })
    subscription.add(new Subscription(() => {
      if (exited) return
      if (timeoutHandle) clearTimeout(timeoutHandle)
      child.kill()
    }))
    return subscription
  })

  let stream: Observable<OutputChunk> = chunks
  if (settings.retries && settings.retries > 0) {
    const retryDelay = settings.retryDelay ?? 1000
    stream = stream.pipe(rxRetry({
      count: settings.retries,
      delay: (error: unknown) => {
        // A process that ran and failed is worth retrying; one that never started is not.
        if (error instanceof SpawnError && error.exitCode !== 0) return timer(retryDelay)
        throw error
      },
    }))
  }
  return settings.split ? stream : stream.pipe(map(chunk => chunk?.text))
}

/** An observable that emits once when the pipe closes — or immediately when there is no pipe. */
function pipeClosed(
  pipe: NodeJS.ReadableStream | null,
  source: OutputChunk["source"],
  emit: (buffer: string | Buffer) => void,
): Observable<boolean> | Subject<boolean> {
  if (!pipe) return of(true)
  const closed = new AsyncSubject<boolean>()
  pipe.on("data", emit)
  pipe.on("close", () => {
    closed.next(true)
    closed.complete()
  })
  return closed
}

function outputOf(observable: Observable<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ""
    observable.subscribe({
      next: value => { output += value },
      error: (error: unknown) => reject(withOutput(output, error)),
      complete: () => resolve(output),
    })
  })
}

function splitOutputOf(observable: Observable<OutputChunk>): Promise<[string, string]> {
  return new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    observable.subscribe({
      next: chunk => {
        if (chunk.source === "stdout") stdout += chunk.text
        else stderr += chunk.text
      },
      error: (error: unknown) => reject(withOutput(stdout, error, stderr)),
      complete: () => resolve([stdout, stderr]),
    })
  })
}

/** What was printed before the failure is part of the failure. */
function withOutput(output: string, error: unknown, errorOutput?: string): Error {
  if (error instanceof SpawnError) {
    return new SpawnError(
      `${output}\n${error.message}`,
      error.exitCode,
      error.command,
      error.args,
      output,
      errorOutput ?? error.stderr,
    )
  }
  return new Error(`${output}\n${error instanceof Error ? error.message : String(error)}`)
}

export function spawnPromise(
  executable: string,
  params: string[],
  options: SpawnOptionsWithExtras & { split: true },
): Promise<[string, string]>
export function spawnPromise(
  executable: string,
  params: string[],
  options?: SpawnOptionsWithExtras,
): Promise<string>
export function spawnPromise(
  executable: string,
  params: string[],
  options?: SpawnOptionsWithExtras,
): Promise<string> | Promise<[string, string]> {
  if (options?.split) return splitOutputOf(spawn(executable, params, { ...options, split: true }))
  return outputOf(spawn(executable, params, { ...options, split: false }))
}
