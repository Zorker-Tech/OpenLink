/** Slate's contract for removing a workspace file. */

import type { Executor } from "./executor-resources.ts";

export interface DeleteExecutorArgs {
  readonly path: string;
  readonly toolCallId?: string;
}

export type DeleteExecutorResult =
  | {
      readonly kind: "success";
      readonly path: string;
      readonly deletedPath: string;
      readonly fileSize: bigint;
      readonly previousContent: string;
    }
  | { readonly kind: "not-found"; readonly path: string }
  | { readonly kind: "not-file"; readonly path: string; readonly actualType: string }
  | { readonly kind: "permission-denied"; readonly path: string; readonly message: string; readonly isReadonly: boolean }
  | { readonly kind: "file-busy"; readonly path: string }
  | { readonly kind: "rejected"; readonly path: string; readonly reason: string }
  | { readonly kind: "error"; readonly path: string; readonly error: string }
  | { readonly kind: "unrecognized" };

export type DeleteExecutor = Executor<DeleteExecutorArgs, DeleteExecutorResult>;

export { deleteExecutorResource } from "../../adapters/interop/agent/delete-operation-adapter.ts";
