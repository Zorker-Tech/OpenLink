/**
 * The one place a file is written, so every edit tool writes the same way.
 *
 * Reading, editing and writing a file all end in the same call, and putting it in one place is what keeps
 * them from disagreeing: the plan-mode policy is checked before anything is sent, the write goes over the
 * exec channel with an id derived from the call so a retry is the same write, and the result is decorated
 * with what happened afterwards — a canvas's type errors, a store conflict — before the model sees it. The
 * file's state is recorded on the conversation so the platform knows what it changed.
 *
 * What comes back is translated into the failure each case deserves, because they are not
 * interchangeable: a refusal is a permission problem the user may be able to change, a full disk is a
 * device problem the turn should not be judged for, and a write the user rejected is not an error at all
 * but a decision. Two of them carry wording of their own — a worktree guard failure is about the
 * environment, and a notebook whose editor support is missing cannot be fixed by trying again, so the model
 * is told that retrying will not help.
 */

import type { Context } from "../../../../context/context.ts"
import { createCounter } from "../../../../metrics/index.ts"
import type { ResourceAccessor } from "../../../../agent-exec/resource-provider.ts"
import type { RemoteExecManager } from "../../../../agent-exec/executor-resources.ts"
import { writeExecutorResource, type WriteExecutor } from "../../../../agent-exec/write-operation.ts"
import { WriteArgs, type WriteResult } from "../../../../proto/generated/agent/v1/write_exec_pb.ts"
import { WORKTREE_GUARD_ERROR } from "../../../../utils/paths.ts"
import { CustomToolCallError, ToolCallError, ToolCallUnexpectedEnvironmentError, ToolErrorClassification } from "../../tool-errors.ts"
import { generateSeededUuid } from "../../tool-support.ts"
import { decoratePostWriteResultForModel, type PostWriteDecorationOptions } from "./post-write-result-decoration.ts"
import { assertPlanModeAllowsFileEdit } from "./plan-mode-file-policy.ts"
import type { HookAdditionalContext } from "../../../../proto/generated/agent/v1/hook_additional_context_pb.ts"

const editCommonPerformWriteCounter = createCounter("agent.tools.edit_common.perform_write.total", {
  description: "Total performWrite operations",
  labelNames: [],
});
const editCommonPerformWriteErrorCounter = createCounter("agent.tools.edit_common.perform_write.error", {
  description: "Failed performWrite operations",
  labelNames: ["error_type"],
});

const NOTEBOOK_VIEW_TYPE_MODEL_ERROR = "This notebook could not be opened for editing because the editor environment has no notebook provider for it (for example, Jupyter/notebook support is unavailable). This is an environment limitation, not a problem with the edit itself — retrying will not help.";

function isNotebookViewTypeResolutionError(errorMessage: string): boolean {
  return errorMessage.includes("Missing viewType for");
}

export class WritePermissionDeniedError extends CustomToolCallError {
  readonly isReadonly: boolean;

  constructor(isReadonly: boolean, message: string, modelMessage: string) {
    super(ToolErrorClassification.UNEXPECTED_ENVIRONMENT, {
      error: message,
      clientVisibleErrorMessage: message,
      modelVisibleErrorMessage: modelMessage,
    });
    this.isReadonly = isReadonly;
  }
}

export class WriteRejectedError extends CustomToolCallError {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(ToolErrorClassification.USER_REJECTED, {
      error: message,
      clientVisibleErrorMessage: message,
      modelVisibleErrorMessage: reason,
    });
    this.reason = reason;
  }
}

export interface PerformWriteEditInfo {
  readonly resultForModel: string;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly diffString: string;
  readonly originalContent: string;
  readonly beforeContentToReturn?: string | undefined;
  readonly afterContentToReturn?: string | undefined;
}

export interface PerformWriteMeta extends PostWriteDecorationOptions {
  readonly toolCallId: string;
  readonly hookContextCollector?: HookAdditionalContext[];
}

export interface FileStateWriter {
  recordFileState(path: string, content: string | undefined, previousContent: string | undefined): void;
}

export interface PerformWriteResult {
  readonly modified: string;
  readonly edit: {
    readonly resultForModel: string;
    readonly linesAdded: number;
    readonly linesRemoved: number;
    readonly diffString: string;
    readonly beforeContentToReturn: string;
    readonly afterContentToReturn: string;
  };
}

export async function performWrite(
  ctx: Context,
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  path: string,
  content: string,
  editInfo: PerformWriteEditInfo,
  meta: PerformWriteMeta,
  stateHandler: FileStateWriter & { readonly mode: Parameters<typeof assertPlanModeAllowsFileEdit>[1]["mode"] },
): Promise<PerformWriteResult> {
  editCommonPerformWriteCounter.increment(ctx, 1);
  assertPlanModeAllowsFileEdit(path, stateHandler);
  const writeExecutor: WriteExecutor = resourceAccessor.get(writeExecutorResource);
  const writeArgs = new WriteArgs({ path, fileText: content, toolCallId: meta.toolCallId });
  const writeExecId = generateSeededUuid(`${meta.toolCallId}-write`);
  const writeResult: WriteResult = await writeExecutor.execute(ctx, writeArgs, {
    execId: writeExecId,
    ...(meta.hookContextCollector !== undefined ? { hookContextCollector: meta.hookContextCollector } : {}),
    enableAgentStoreConflictNotices: meta.enableAgentStoreConflictNotices === true,
  });
  if (writeResult.result.case === undefined) {
    editCommonPerformWriteErrorCounter.increment(ctx, 1, { error_type: "unknown" });
    throw new ToolCallError({ clientVisibleErrorMessage: "Unknown error", modelVisibleErrorMessage: "Unknown error", error: "Unknown error" });
  }
  switch (writeResult.result.case) {
    case "success": {
      void stateHandler.recordFileState(writeResult.result.value.path, content, editInfo.originalContent);
      const resultForModel = await decoratePostWriteResultForModel(ctx, resourceAccessor, writeResult.result.value.path, editInfo.resultForModel, meta.toolCallId, meta);
      return {
        modified: content,
        edit: {
          resultForModel,
          linesAdded: editInfo.linesAdded,
          linesRemoved: editInfo.linesRemoved,
          diffString: editInfo.diffString,
          beforeContentToReturn: editInfo.beforeContentToReturn ?? editInfo.originalContent,
          afterContentToReturn: editInfo.afterContentToReturn ?? content,
        },
      };
    }
    case "permissionDenied": {
      editCommonPerformWriteErrorCounter.increment(ctx, 1, { error_type: "permission_denied" });
      const permissionDenied = writeResult.result.value;
      const detail = permissionDenied.error ? `: ${permissionDenied.error}` : "";
      throw new WritePermissionDeniedError(permissionDenied.isReadonly ?? false, `Write permission denied: ${path}${detail}`, `Write permission denied: ${path}${detail}`);
    }
    case "noSpace": {
      editCommonPerformWriteErrorCounter.increment(ctx, 1, { error_type: "no_space" });
      throw new CustomToolCallError(ToolErrorClassification.BAD_USER_DEVICE_STATE, { clientVisibleErrorMessage: "No space left on device", modelVisibleErrorMessage: "No space left on device", error: "No space left on device" });
    }
    case "rejected": {
      const reason = writeResult.result.value.reason;
      if (reason.includes("Failed to find tool call context")) {
        editCommonPerformWriteErrorCounter.increment(ctx, 1, { error_type: "write_error" });
        throw new ToolCallError({ clientVisibleErrorMessage: `Edit rejected: ${reason}`, modelVisibleErrorMessage: reason, error: `Edit rejected: ${reason}` });
      }
      editCommonPerformWriteErrorCounter.increment(ctx, 1, { error_type: "rejected" });
      throw new WriteRejectedError(reason, `Edit rejected: ${reason}`);
    }
    case "error": {
      const writeError = writeResult.result.value.error;
      if (writeError === WORKTREE_GUARD_ERROR) throw new ToolCallUnexpectedEnvironmentError(writeError);
      if (isNotebookViewTypeResolutionError(writeError)) {
        editCommonPerformWriteErrorCounter.increment(ctx, 1, { error_type: "notebook_view_type_unresolved" });
        throw new CustomToolCallError(ToolErrorClassification.UNEXPECTED_ENVIRONMENT, { error: writeError, clientVisibleErrorMessage: writeError, modelVisibleErrorMessage: NOTEBOOK_VIEW_TYPE_MODEL_ERROR });
      }
      editCommonPerformWriteErrorCounter.increment(ctx, 1, { error_type: "write_error" });
      throw new ToolCallError({ clientVisibleErrorMessage: writeError, modelVisibleErrorMessage: writeError, error: writeError });
    }
    default: {
      const exhaustiveCheck: never = writeResult.result;
      throw new Error(`Unhandled writeResult.result: ${String(exhaustiveCheck)}`);
    }
  }
}
