/** Maps Slate workspace-search contracts to the generated execution frame at the boundary. */

import {
  GrepArgs,
  GrepContentMatch,
  GrepContentResult,
  GrepError,
  GrepFileCount as InteropGrepFileCount,
  GrepFileMatch,
  GrepFilesResult,
  GrepResult,
  GrepSuccess,
  GrepUnionResult,
} from "../proto/generated/agent/v1/grep_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import {
  type GrepContentLine,
  type GrepExecutor,
  type GrepExecutorArgs,
  type GrepExecutorResult,
  type GrepFileContent,
  type GrepFileCount,
  type GrepOutputResult,
} from "../../../packages/agent-exec/grep.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";
import { adaptSandboxPolicyFromInterop, adaptSandboxPolicyToInterop } from "./sandbox-policy-adapter.ts";
import type { SandboxRule } from "../../../packages/local-exec/sandbox-policy.ts";

function sandboxRuleFromInterop(value: NonNullable<GrepArgs["sandboxPolicy"]>): SandboxRule {
  const policy = adaptSandboxPolicyFromInterop(value);
  return Object.fromEntries(Object.entries(policy).filter(([, field]) => field !== undefined)) as SandboxRule;
}

export function grepExecutorArgsFromInterop(value: GrepArgs): GrepExecutorArgs {
  return {
    query: value.pattern,
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.glob === undefined ? {} : { filePattern: value.glob }),
    ...(value.outputMode === undefined ? {} : { mode: value.outputMode }),
    ...(value.contextBefore === undefined ? {} : { contextBefore: value.contextBefore }),
    ...(value.contextAfter === undefined ? {} : { contextAfter: value.contextAfter }),
    ...(value.context === undefined ? {} : { contextLines: value.context }),
    ...(value.caseInsensitive === undefined ? {} : { ignoreCase: value.caseInsensitive }),
    ...(value.type === undefined ? {} : { fileType: value.type }),
    ...(value.headLimit === undefined ? {} : { resultLimit: value.headLimit }),
    ...(value.multiline === undefined ? {} : { multiline: value.multiline }),
    ...(value.sort === undefined ? {} : { sortBy: value.sort }),
    ...(value.sortAscending === undefined ? {} : { ascending: value.sortAscending }),
    ...(value.toolCallId.length === 0 ? {} : { toolCallId: value.toolCallId }),
    ...(value.sandboxPolicy === undefined ? {} : { sandboxPolicy: sandboxRuleFromInterop(value.sandboxPolicy) }),
    ...(value.offset === undefined ? {} : { offset: value.offset }),
  };
}

export function grepExecutorArgsToInterop(value: GrepExecutorArgs): GrepArgs {
  const sandboxPolicy = value.sandboxPolicy === undefined ? undefined : adaptSandboxPolicyToInterop(value.sandboxPolicy);
  return new GrepArgs({
    pattern: value.query,
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.filePattern === undefined ? {} : { glob: value.filePattern }),
    ...(value.mode === undefined ? {} : { outputMode: value.mode }),
    ...(value.contextBefore === undefined ? {} : { contextBefore: value.contextBefore }),
    ...(value.contextAfter === undefined ? {} : { contextAfter: value.contextAfter }),
    ...(value.contextLines === undefined ? {} : { context: value.contextLines }),
    ...(value.ignoreCase === undefined ? {} : { caseInsensitive: value.ignoreCase }),
    ...(value.fileType === undefined ? {} : { type: value.fileType }),
    ...(value.resultLimit === undefined ? {} : { headLimit: value.resultLimit }),
    ...(value.multiline === undefined ? {} : { multiline: value.multiline }),
    ...(value.sortBy === undefined ? {} : { sort: value.sortBy }),
    ...(value.ascending === undefined ? {} : { sortAscending: value.ascending }),
    ...(value.toolCallId === undefined ? {} : { toolCallId: value.toolCallId }),
    ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
    ...(value.offset === undefined ? {} : { offset: value.offset }),
  });
}

function grepFileCountFromInterop(value: InteropGrepFileCount): GrepFileCount {
  return { path: value.file, matches: value.count };
}

function grepFileCountToInterop(value: GrepFileCount): InteropGrepFileCount {
  return new InteropGrepFileCount({ file: value.path, count: value.matches });
}

function grepContentLineFromInterop(value: GrepContentMatch): GrepContentLine {
  return {
    lineNumber: value.lineNumber,
    content: value.content,
    contentTruncated: value.contentTruncated,
    isContextLine: value.isContextLine,
  };
}

function grepContentLineToInterop(value: GrepContentLine): GrepContentMatch {
  return new GrepContentMatch({
    lineNumber: value.lineNumber,
    content: value.content,
    contentTruncated: value.contentTruncated,
    isContextLine: value.isContextLine,
  });
}

function grepFileContentFromInterop(value: GrepFileMatch): GrepFileContent {
  return { path: value.file, lines: value.matches.map(grepContentLineFromInterop) };
}

function grepFileContentToInterop(value: GrepFileContent): GrepFileMatch {
  return new GrepFileMatch({ file: value.path, matches: value.lines.map(grepContentLineToInterop) });
}

export function grepOutputResultFromInterop(value: GrepUnionResult): GrepOutputResult {
  switch (value.result.case) {
    case "count":
      return {
        kind: "count",
        files: value.result.value.counts.map(grepFileCountFromInterop),
        totalFiles: value.result.value.totalFiles,
        totalMatches: value.result.value.totalMatches,
        resultTruncated: value.result.value.clientTruncated,
        searchTruncated: value.result.value.ripgrepTruncated,
        ...(value.result.value.headLimitApplied === undefined ? {} : { resultLimitApplied: value.result.value.headLimitApplied }),
        ...(value.result.value.offsetApplied === undefined ? {} : { offsetApplied: value.result.value.offsetApplied }),
      };
    case "files":
      return {
        kind: "files",
        files: [...value.result.value.files],
        totalFiles: value.result.value.totalFiles,
        resultTruncated: value.result.value.clientTruncated,
        searchTruncated: value.result.value.ripgrepTruncated,
        ...(value.result.value.headLimitApplied === undefined ? {} : { resultLimitApplied: value.result.value.headLimitApplied }),
        ...(value.result.value.offsetApplied === undefined ? {} : { offsetApplied: value.result.value.offsetApplied }),
      };
    case "content":
      return {
        kind: "content",
        files: value.result.value.matches.map(grepFileContentFromInterop),
        totalLines: value.result.value.totalLines,
        totalMatchedLines: value.result.value.totalMatchedLines,
        resultTruncated: value.result.value.clientTruncated,
        searchTruncated: value.result.value.ripgrepTruncated,
        ...(value.result.value.headLimitApplied === undefined ? {} : { resultLimitApplied: value.result.value.headLimitApplied }),
        ...(value.result.value.offsetApplied === undefined ? {} : { offsetApplied: value.result.value.offsetApplied }),
      };
    case undefined:
      return { kind: "unrecognized" };
  }
}

export function grepOutputResultToInterop(value: GrepOutputResult): GrepUnionResult {
  switch (value.kind) {
    case "count":
      return new GrepUnionResult({ result: { case: "count", value: {
        counts: value.files.map(grepFileCountToInterop),
        totalFiles: value.totalFiles,
        totalMatches: value.totalMatches,
        clientTruncated: value.resultTruncated,
        ripgrepTruncated: value.searchTruncated,
        ...(value.resultLimitApplied === undefined ? {} : { headLimitApplied: value.resultLimitApplied }),
        ...(value.offsetApplied === undefined ? {} : { offsetApplied: value.offsetApplied }),
      } } });
    case "files":
      return new GrepUnionResult({ result: { case: "files", value: {
        files: [...value.files],
        totalFiles: value.totalFiles,
        clientTruncated: value.resultTruncated,
        ripgrepTruncated: value.searchTruncated,
        ...(value.resultLimitApplied === undefined ? {} : { headLimitApplied: value.resultLimitApplied }),
        ...(value.offsetApplied === undefined ? {} : { offsetApplied: value.offsetApplied }),
      } } });
    case "content":
      return new GrepUnionResult({ result: { case: "content", value: {
        matches: value.files.map(grepFileContentToInterop),
        totalLines: value.totalLines,
        totalMatchedLines: value.totalMatchedLines,
        clientTruncated: value.resultTruncated,
        ripgrepTruncated: value.searchTruncated,
        ...(value.resultLimitApplied === undefined ? {} : { headLimitApplied: value.resultLimitApplied }),
        ...(value.offsetApplied === undefined ? {} : { offsetApplied: value.offsetApplied }),
      } } });
    case "unrecognized":
      return new GrepUnionResult();
  }
}

export function grepExecutorResultFromInterop(value: GrepResult): GrepExecutorResult {
  switch (value.result.case) {
    case "success":
      return {
        kind: "success",
        query: value.result.value.pattern,
        rootPath: value.result.value.path,
        mode: value.result.value.outputMode,
        workspaceResults: Object.fromEntries(Object.entries(value.result.value.workspaceResults).map(
          ([workspace, result]) => [workspace, grepOutputResultFromInterop(result)],
        )),
        ...(value.result.value.activeEditorResult === undefined
          ? {}
          : { activeEditorResult: grepOutputResultFromInterop(value.result.value.activeEditorResult) }),
      };
    case "error":
      return { kind: "error", message: value.result.value.error };
    case undefined:
      return { kind: "unrecognized" };
  }
}

export function grepExecutorResultToInterop(value: GrepExecutorResult): GrepResult {
  switch (value.kind) {
    case "success":
      return new GrepResult({ result: { case: "success", value: new GrepSuccess({
        pattern: value.query,
        path: value.rootPath,
        outputMode: value.mode,
        workspaceResults: Object.fromEntries(Object.entries(value.workspaceResults).map(
          ([workspace, result]) => [workspace, grepOutputResultToInterop(result)],
        )),
        ...(value.activeEditorResult === undefined
          ? {}
          : { activeEditorResult: grepOutputResultToInterop(value.activeEditorResult) }),
      }) } });
    case "error":
      return new GrepResult({ result: { case: "error", value: new GrepError({ error: value.message }) } });
    case "unrecognized":
      return new GrepResult();
  }
}

export const grepExecutorResource = createResource<GrepExecutor, RemoteExecManager, ControlledExecManager>(
  (manager) => {
    const serializeArgs = createServerSerializer("grepArgs");
    const deserializeResult = createClientDeserializer("grepResult");
    return new ExecutorResource(
      manager,
      (id, args, options) => serializeArgs(id, grepExecutorArgsToInterop(args), options),
      (message) => {
        const decoded = deserializeResult(message);
        return {
          value: decoded.value === undefined ? undefined : grepExecutorResultFromInterop(decoded.value),
          ...(decoded.hookContexts === undefined ? {} : { hookContexts: decoded.hookContexts }),
        };
      },
    );
  },
  (implementation, manager) => {
    const interopImplementation: Executor<GrepArgs, GrepResult> = {
      async execute(ctx, args, options) {
        return grepExecutorResultToInterop(await implementation.execute(ctx, grepExecutorArgsFromInterop(args), options));
      },
    };
    manager.register(new SimpleControlledExecHandler(
      interopImplementation,
      createServerDeserializer("grepArgs"),
      createClientSerializer("grepResult"),
    ));
  },
);
