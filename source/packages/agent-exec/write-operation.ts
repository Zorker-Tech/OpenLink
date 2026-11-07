/** Slate's contract for writing text or bytes to a workspace file. */

import type { Executor } from "./executor-resources.ts";

export interface WriteExecutorArgs {
  readonly path: string;
  readonly text?: string;
  readonly bytes?: Uint8Array;
  readonly toolCallId?: string;
  readonly includeContentAfterWrite?: boolean;
  readonly encoding?: string;
}

export type WriteExecutorResult =
  | {
      readonly kind: "success";
      readonly path: string;
      readonly linesWritten: number;
      readonly bytesWritten: number;
      readonly contentAfterWrite?: string;
    }
  | {
      readonly kind: "permission-denied";
      readonly path: string;
      readonly directory: string;
      readonly operation: string;
      readonly message: string;
      readonly isReadonly: boolean;
    }
  | { readonly kind: "no-space"; readonly path: string }
  | { readonly kind: "error"; readonly path: string; readonly error: string }
  | { readonly kind: "rejected"; readonly path: string; readonly reason: string }
  | { readonly kind: "unrecognized" };

export type WriteExecResult = WriteExecutorResult;
export type WriteExecResponse = WriteExecutorResult;
export type WriteExecutor = Executor<WriteExecutorArgs, WriteExecutorResult>;

export { writeExecutorResource } from "../../adapters/interop/agent/write-operation-adapter.ts";
