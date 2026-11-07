/** Slate's model-facing shell invocation and interaction port. */

import type { Context } from "../../../../context/context.ts";
import type { ShellExecResponse, ShellExecutorArgs } from "../../../../agent-exec/shell.ts";
import type { HookContextEntry } from "../../../../hooks-carriers/hook-additional-context.ts";

export interface ShellSandboxPolicy {
  readonly mode: "workspace_readonly" | "workspace_readwrite" | "unrestricted";
  readonly networkAccess?: boolean;
  readonly additionalReadwritePaths?: readonly string[];
  readonly enableSharedBuildCache?: boolean;
}

export interface SlateShellToolCall {
  readonly kind: "shell";
  readonly args?: ShellExecutorArgs;
  readonly result?: ShellExecResponse;
}

export interface ShellToolInteractionPort {
  executeToolCall(
    context: Context,
    call: SlateShellToolCall,
    callId: string,
    run: (context: Context) => Promise<ShellExecResponse>,
    merge: (result: ShellExecResponse) => SlateShellToolCall,
    hookContexts?: readonly HookContextEntry[],
  ): Promise<ShellExecResponse>;
  getAbortSignal(context: Context): AbortSignal;
  emitPartialToolCall?(context: Context, callId: string, call: SlateShellToolCall): Promise<void>;
}
