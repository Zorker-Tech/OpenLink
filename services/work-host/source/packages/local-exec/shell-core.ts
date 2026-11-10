/** Run one terminal command with Slate's session environment, bounded events, and project output files. */
import { resolve } from "node:path";
import type { Context } from "../context/context.ts";
import { SHELL_OUTPUT_SUPPRESSED_NOTICE } from "../shell-exec/output-suppression.ts";
import type { TerminalExecutor } from "../shell-exec/index.ts";
import { MAX_BUFFER_SIZE } from "./constants.ts";
import { addAskpassEnvironment, createShellCoreEnvironment } from "./shell-core-environment.ts";
import type { SandboxPolicy } from "./shell-core-contracts.ts";
import { addAgentStorePathsToPolicy } from "./shell-core-sandbox-policy.ts";
import { ShellCoreOutputCapture } from "./shell-core-output-capture.ts";

export type { SandboxRule } from "./sandbox-policy.ts";
export type { SandboxPolicy, ShellCoreArgs, ShellOutputBackpressureOptions } from "./shell-core-contracts.ts";

import type { ShellCoreArgs, ShellOutputBackpressureOptions } from "./shell-core-contracts.ts";

/** Slate's record of output that has spilled into a durable file. */
export interface ShellOutputLocation {
  readonly filePath: string;
  readonly sizeBytes: bigint;
  readonly lineCount: bigint;
}

export type ShellCoreEvent =
  | { readonly type: "start"; readonly sandboxed: boolean }
  | { readonly type: "stdout" | "stderr"; readonly data: string }
  | { readonly type: "stdout_trimmed" | "stderr_trimmed" }
  | { readonly type: "stdin_ready"; readonly stdin: NodeJS.WritableStream | undefined; readonly pid: number | undefined }
  | { readonly type: "sandbox_denies"; readonly events: readonly unknown[] }
  | {
    readonly type: "exit";
    readonly code: number | null;
    readonly aborted: boolean;
    readonly outputLocation?: ShellOutputLocation;
    readonly localExecutionTimeMs: number;
  };

export class BaseShellCoreExecutor {
  constructor(
    private readonly executor: TerminalExecutor,
    private readonly workspacePath?: string,
    private readonly projectDir?: string,
    private readonly shellOutputBackpressureOptions?: ShellOutputBackpressureOptions,
    private readonly extraEnvProvider?: (ctx: Context, args: ShellCoreArgs) => NodeJS.ProcessEnv | undefined,
  ) {}

  async *execute(ctx: Context, args: ShellCoreArgs): AsyncIterable<ShellCoreEvent> {
    const startedAt = performance.now();
    const requestedDirectory = args.workingDirectory || await this.executor.getCwd();
    const workingDirectory = this.workspacePath === undefined
      ? resolve(requestedDirectory)
      : resolve(this.workspacePath, requestedDirectory);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let suppressionNoticeSent = false;
    let stdoutWasTrimmed = false;
    let stderrWasTrimmed = false;
    const outputCapture = args.fileOutputThresholdBytes && this.projectDir
      ? new ShellCoreOutputCapture(this.projectDir, Number(args.fileOutputThresholdBytes))
      : undefined;
    const env = createShellCoreEnvironment(ctx, args, this.projectDir, this.extraEnvProvider);
    const sandboxPolicy = addAgentStorePathsToPolicy(args.sandboxPolicy, env);
    const sandboxMode = sandboxPolicy?.perRepo?.type
      ?? sandboxPolicy?.perUser?.type
      ?? sandboxPolicy?.teamAdmin?.type
      ?? "insecure_none";

    if (sandboxPolicy !== undefined) {
      yield { type: "start", sandboxed: sandboxMode === "workspace_readonly" || sandboxMode === "workspace_readwrite" };
    }
    addAskpassEnvironment(env, args);

    for await (const event of this.executor.execute(ctx, args.command, {
      ...(args.signal === undefined ? {} : { signal: args.signal }),
      workingDirectory,
      env,
      ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
      ...(this.workspacePath === undefined ? {} : { sandboxWorkspaceRoot: this.workspacePath }),
      pipeStdin: args.pipeStdin ?? false,
      ...(this.shellOutputBackpressureOptions?.bufferOutputEvents === undefined
        ? {}
        : { bufferOutputEvents: this.shellOutputBackpressureOptions.bufferOutputEvents }),
      ...(this.shellOutputBackpressureOptions?.outputLimiterOptions === undefined
        ? {}
        : { outputLimiterOptions: this.shellOutputBackpressureOptions.outputLimiterOptions }),
    })) {
      let text = "";
      let chunkBytes = 0;
      if (event.type === "stdout" || event.type === "stderr") {
        text = event.data.toString();
        chunkBytes = event.data.length;
        await outputCapture?.append(text, chunkBytes);
      }

      if (event.type === "stdout" && !stdoutWasTrimmed) {
        if (stdoutBytes + chunkBytes > MAX_BUFFER_SIZE) {
          stdoutWasTrimmed = true;
          yield { type: "stdout_trimmed" };
        } else {
          stdoutBytes += chunkBytes;
          yield { type: "stdout", data: text };
        }
      } else if (event.type === "suppressed_output" && !suppressionNoticeSent) {
        suppressionNoticeSent = true;
        yield { type: "stdout", data: SHELL_OUTPUT_SUPPRESSED_NOTICE };
      } else if (event.type === "stderr" && !stderrWasTrimmed) {
        if (stderrBytes + chunkBytes > MAX_BUFFER_SIZE) {
          stderrWasTrimmed = true;
          yield { type: "stderr_trimmed" };
        } else {
          stderrBytes += chunkBytes;
          yield { type: "stderr", data: text };
        }
      } else if (event.type === "stdin_ready") {
        yield { type: "stdin_ready", stdin: event.stdin, pid: event.pid };
      } else if (event.type === "sandbox_denies") {
        yield { type: "sandbox_denies", events: event.events };
      } else if (event.type === "exit") {
        const fileDetails = await outputCapture?.finish();
        const outputLocation: ShellOutputLocation | undefined = fileDetails === undefined
          ? undefined
          : {
            filePath: fileDetails.filePath,
            sizeBytes: BigInt(fileDetails.byteCount),
            lineCount: BigInt(fileDetails.lineCount),
          };
        yield {
          type: "exit",
          code: event.code,
          aborted: event.aborted,
          ...(outputLocation === undefined ? {} : { outputLocation }),
          localExecutionTimeMs: Math.max(0, Math.round(performance.now() - startedAt)),
        };
      }
    }
  }

  getCwd(): Promise<string> {
    return this.executor.getCwd();
  }

  getWorkspacePath(): string {
    if (!this.workspacePath) throw new Error("Workspace path is not configured");
    return this.workspacePath;
  }
}
