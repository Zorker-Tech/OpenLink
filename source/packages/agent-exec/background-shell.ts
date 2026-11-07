/** Slate's request/results for starting a durable shell and writing to its input. */

import type { Executor } from "./executor-resources.ts";
import type { BackgroundShellSpawnInput } from "../local-exec/background-shell-contracts.ts";

export type BackgroundShellExecutorArgs = BackgroundShellSpawnInput;

export type BackgroundShellExecutorResult =
  | { readonly kind: "success"; readonly shellId: number; readonly command: string; readonly workingDirectory: string; readonly pid?: number }
  | { readonly kind: "rejected"; readonly command: string; readonly workingDirectory: string; readonly reason: string }
  | { readonly kind: "permission-denied"; readonly command: string; readonly workingDirectory: string; readonly message: string; readonly isReadonly: boolean }
  | { readonly kind: "sandbox-unsupported"; readonly command: string; readonly workingDirectory: string; readonly policyType: string; readonly reason: string; readonly isReadonly: boolean }
  | { readonly kind: "error"; readonly command: string; readonly workingDirectory: string; readonly error: string }
  | { readonly kind: "unrecognized" };

export type BackgroundShellExecutor = Executor<BackgroundShellExecutorArgs, BackgroundShellExecutorResult>;

export interface WriteBackgroundShellInputArgs {
  readonly shellId: number;
  readonly text: string;
}

export type WriteBackgroundShellInputResult =
  | { readonly kind: "success"; readonly shellId: number; readonly terminalLengthBeforeWrite: number }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "unrecognized" };

export type WriteBackgroundShellInputExecutor = Executor<WriteBackgroundShellInputArgs, WriteBackgroundShellInputResult>;

export {
  backgroundShellExecutorResource,
  writeBackgroundShellInputExecutorResource,
} from "../../adapters/interop/agent/background-shell-operation-adapter.ts";
