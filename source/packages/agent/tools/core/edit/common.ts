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
import { WORKTREE_GUARD_ERROR } from "../../../../utils/paths.ts"
import { CustomToolCallError, ToolCallError, ToolCallUnexpectedEnvironmentError, ToolErrorClassification } from "../../tool-errors.ts"
import { generateSeededUuid } from "../../tool-support.ts"
import { decoratePostWriteResultForModel, type PostWriteDecorationOptions } from "./post-write-result-decoration.ts"
import { assertPlanModeAllowsFileEdit } from "./plan-mode-file-policy.ts"
import { isManagedCanvasEditPath } from "../../../../../adapters/interop/agent/plan-edit-policy-adapter.ts"
import { SlateMode, type SlateMode as SlateModeValue } from "../../../mode-processing.ts"
import { writeFileThroughInterop } from "../../../../../adapters/interop/agent/write-operation-adapter.ts"
import type { HookContextEntry } from "../../../../hooks-carriers/hook-additional-context.ts"

const editCommonPerformWriteCounter = createCounter("agent.tools.edit_common.perform_write.total", {
  description: "Total performWrite operations",
  labelNames: [],
});
const editCommonPerformWriteErrorCounter = createCounter("agent.tools.edit_common.perform_write.error", {
  description: "Failed performWrite operations",
  labelNames: ["error_type"],
});

const NOTEBOOK_EDITOR_UNAVAILABLE_MESSAGE = "This notebook cannot be edited in the current workspace because notebook editing support is unavailable. This is a workspace capability gap, not an edit failure; retrying will not help.";

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
  readonly hookContextCollector?: HookContextEntry[];
}

export type SlateWriteOutcome =
  | { readonly kind: "written"; readonly path: string }
  | { readonly kind: "permission-denied"; readonly message: string; readonly isReadonly: boolean }
  | { readonly kind: "device-full" }
  | { readonly kind: "user-rejected"; readonly reason: string }
  | { readonly kind: "editor-unavailable"; readonly message: string }
  | { readonly kind: "write-failed"; readonly message: string }
  | { readonly kind: "unknown" }

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
  stateHandler: FileStateWriter & { readonly mode: SlateModeValue },
): Promise<PerformWriteResult> {
  editCommonPerformWriteCounter.increment(ctx, 1);
  assertPlanModeAllowsFileEdit(path, stateHandler.mode === SlateMode.PLAN, isManagedCanvasEditPath(path));
  const writeExecId = generateSeededUuid(`${meta.toolCallId}-write`);
  const writeResult = await writeFileThroughInterop({
    context: ctx,
    resources: resourceAccessor,
    path,
    content,
    toolCallId: meta.toolCallId,
    execId: writeExecId,
    ...(meta.hookContextCollector === undefined ? {} : { hookContextCollector: meta.hookContextCollector }),
    enableConflictNotices: meta.enableAgentStoreConflictNotices === true,
  });
  if (writeResult.kind === "unknown") {
    editCommonPerformWriteErrorCounter.increment(ctx, 1, { error_type: "unknown" });
    throw new ToolCallError({ clientVisibleErrorMessage: "Unknown error", modelVisibleErrorMessage: "Unknown error", error: "Unknown error" });
  }
  switch (writeResult.kind) {
    case "written": {
      void stateHandler.recordFileState(writeResult.path, content, editInfo.originalContent);
      const resultForModel = await decoratePostWriteResultForModel(ctx, resourceAccessor, writeResult.path, editInfo.resultForModel, meta.toolCallId, meta);
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
    case "permission-denied": {
      editCommonPerformWriteErrorCounter.increment(ctx, 1, { error_type: "permission_denied" });
      const detail = writeResult.message ? `: ${writeResult.message}` : "";
      throw new WritePermissionDeniedError(writeResult.isReadonly, `Write permission denied: ${path}${detail}`, `Write permission denied: ${path}${detail}`);
    }
    case "device-full": {
      editCommonPerformWriteErrorCounter.increment(ctx, 1, { error_type: "no_space" });
      throw new CustomToolCallError(ToolErrorClassification.BAD_USER_DEVICE_STATE, { clientVisibleErrorMessage: "No space left on device", modelVisibleErrorMessage: "No space left on device", error: "No space left on device" });
    }
    case "user-rejected": {
      const reason = writeResult.reason;
      if (reason.includes("Failed to find tool call context")) {
        editCommonPerformWriteErrorCounter.increment(ctx, 1, { error_type: "write_error" });
        throw new ToolCallError({ clientVisibleErrorMessage: `Edit rejected: ${reason}`, modelVisibleErrorMessage: reason, error: `Edit rejected: ${reason}` });
      }
      editCommonPerformWriteErrorCounter.increment(ctx, 1, { error_type: "rejected" });
      throw new WriteRejectedError(reason, `Edit rejected: ${reason}`);
    }
    case "editor-unavailable": {
      editCommonPerformWriteErrorCounter.increment(ctx, 1, { error_type: "notebook_view_type_unresolved" });
      throw new CustomToolCallError(ToolErrorClassification.UNEXPECTED_ENVIRONMENT, {
        error: writeResult.message,
        clientVisibleErrorMessage: writeResult.message,
        modelVisibleErrorMessage: NOTEBOOK_EDITOR_UNAVAILABLE_MESSAGE,
      });
    }
    case "write-failed": {
      const writeError = writeResult.message;
      if (writeError === WORKTREE_GUARD_ERROR) throw new ToolCallUnexpectedEnvironmentError(writeError);
      editCommonPerformWriteErrorCounter.increment(ctx, 1, { error_type: "write_error" });
      throw new ToolCallError({ clientVisibleErrorMessage: writeError, modelVisibleErrorMessage: writeError, error: writeError });
    }
    default: {
      const exhaustiveCheck: never = writeResult;
      throw new Error(`Unhandled Slate write outcome: ${String(exhaustiveCheck)}`);
    }
  }
}
