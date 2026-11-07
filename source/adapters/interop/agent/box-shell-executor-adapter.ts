import type { ExecutorOptions } from "../../../packages/agent-exec/executor-resources.ts";
import { shellExecutorResource, type ShellExecResponse, type ShellExecutor } from "../../../packages/agent-exec/shell.ts";
import type { Context } from "../../../packages/context/context.ts";
import type { HostShellArgsInput } from "../../../host/boxes/box-shell-command.ts";
import { buildHostShellArgs } from "../../../host/boxes/box-shell-command.ts";

export type HostShellResult = ShellExecResponse;

export interface HostBoxShellExecutor {
  execute(context: unknown, input: HostShellArgsInput, options?: ExecutorOptions): Promise<HostShellResult>;
}

/** Encodes a Slate shell request, executes it through the registered resource and projects its result. */
export function createHostBoxShellExecutor(resourceAccessor: { get(resource: unknown): unknown }): HostBoxShellExecutor {
  const executor = resourceAccessor.get(shellExecutorResource) as ShellExecutor;
  return {
    async execute(context, input, options) {
      return await executor.execute(context as Context, buildHostShellArgs(input), options);
    },
  };
}
