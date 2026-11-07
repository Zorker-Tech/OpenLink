/** Slate's contract for reading a workspace file. */

import type { Executor } from "./executor-resources.ts";

export interface ReadExecutorArgs {
  readonly path: string;
  readonly toolCallId?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly encodingHint?: string;
}

export type ReadExecutorOutput =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "data"; readonly bytes: Uint8Array };

export type ReadExecutorResult =
  | {
      readonly kind: "success";
      readonly path: string;
      readonly output?: ReadExecutorOutput;
      readonly totalLines: number;
      readonly fileSize: bigint;
      readonly truncated: boolean;
      readonly outputBlobId?: Uint8Array;
      readonly rangeApplied: boolean;
    }
  | { readonly kind: "error"; readonly path: string; readonly error: string }
  | { readonly kind: "rejected"; readonly path: string; readonly reason: string }
  | { readonly kind: "not-found"; readonly path: string }
  | { readonly kind: "permission-denied"; readonly path: string }
  | { readonly kind: "invalid-file"; readonly path: string; readonly reason: string }
  | { readonly kind: "unrecognized"; readonly caseName?: string };

export type ReadExecutor = Executor<ReadExecutorArgs, ReadExecutorResult>;

export { readExecutorResource, redactedReadExecutorResource } from "../../adapters/interop/agent/read-exec-operation-adapter.ts";
