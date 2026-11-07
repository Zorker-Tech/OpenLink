/** Slate's control request and outcome for handing a foreground shell to background ownership. */

import type { Executor } from "./executor-resources.ts";
import type { ShellExecResponse } from "./shell.ts";

export interface ShellControlArgs {
  readonly toolCallId: string;
}

export type ShellControlResult =
  | { readonly kind: "accepted"; readonly shellResult?: ShellExecResponse }
  | { readonly kind: "not-found"; readonly shellResult?: ShellExecResponse }
  | { readonly kind: "unrecognized"; readonly code: number; readonly shellResult?: ShellExecResponse };

export type ShellControlExecutor = Executor<ShellControlArgs, ShellControlResult>;

export { forceBackgroundShellExecutorResource } from "../../adapters/interop/agent/shell-control-exec-adapter.ts";
