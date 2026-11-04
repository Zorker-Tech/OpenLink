import type { Executor, ExecutorOptions } from "../../../packages/agent-exec/executor-resources.ts";
import { shellExecutorResource } from "../../../packages/agent-exec/shell.ts";
import type { Context } from "../../../packages/context/context.ts";
import type { HostShellArgsInput } from "../../../host/boxes/box-shell-command.ts";
import type { ShellArgs, ShellResult as GeneratedShellResult } from "../../interop/proto/generated/agent/v1/shell_exec_pb.ts";
import { buildHostShellArgs } from "./box-shell-command-adapter.ts";

export interface HostShellResult {
  readonly result: {
    readonly case: string;
    readonly value?: { readonly stdout?: string; readonly stderr?: string; readonly exitCode?: number };
  };
}

export interface HostBoxShellExecutor {
  execute(context: unknown, input: HostShellArgsInput, options?: ExecutorOptions): Promise<HostShellResult>;
}

function slateShellResult(result: GeneratedShellResult): HostShellResult {
  if (result.result.case === "success") {
    return {
      result: {
        case: "success",
        value: {
          stdout: result.result.value.stdout,
          stderr: result.result.value.stderr,
          exitCode: result.result.value.exitCode,
        },
      },
    };
  }
  return { result: { case: result.result.case ?? "" } };
}

/** Encodes a Slate shell request, executes it through the registered resource and projects its result. */
export function createHostBoxShellExecutor(resourceAccessor: { get(resource: unknown): unknown }): HostBoxShellExecutor {
  const executor = resourceAccessor.get(shellExecutorResource) as Executor<ShellArgs, GeneratedShellResult>;
  return {
    async execute(context, input, options) {
      const result = await executor.execute(context as Context, buildHostShellArgs(input), options);
      return slateShellResult(result);
    },
  };
}
