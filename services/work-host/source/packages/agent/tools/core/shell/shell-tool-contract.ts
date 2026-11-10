/** Slate's model-facing shell invocation and interaction port. */

import type { Context } from "../../../../context/context.ts";
import type { ShellExecResponse } from "../../../../agent-exec/shell.ts";
import type { HookContextEntry } from "../../../../hooks-carriers/hook-additional-context.ts";
import type { SlateShellToolCall } from "../../../shell-tool-call-state.ts";

export type { SlateShellToolCall } from "../../../shell-tool-call-state.ts";

export interface ShellSandboxPolicy {
  readonly mode: "workspace_readonly" | "workspace_readwrite" | "unrestricted";
  readonly networkAccess?: boolean;
  readonly additionalReadwritePaths?: readonly string[];
  readonly enableSharedBuildCache?: boolean;
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
