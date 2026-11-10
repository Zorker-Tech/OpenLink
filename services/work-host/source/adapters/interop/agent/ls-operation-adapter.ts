/** Maps Slate directory listing contracts to the generated transport frame at the boundary. */

import {
  LsArgs,
  LsDirectoryTreeNode,
  LsDirectoryTreeNode_File,
  LsError,
  LsRejected,
  LsResult,
  LsSuccess,
  LsTimeout,
  TerminalMetadata,
  TerminalMetadata_Command,
} from "../proto/generated/agent/v1/ls_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import {
  type LsExecutorArgs,
  type LsExecutorResult,
  type SlateDirectoryTreeFile,
  type SlateDirectoryTreeNode,
  type SlateTerminalCommand,
  type SlateTerminalMetadata,
} from "../../../packages/agent-exec/ls.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";
import { adaptSandboxPolicyFromInterop, adaptSandboxPolicyToInterop } from "./sandbox-policy-adapter.ts";
import type { SandboxRule } from "../../../packages/local-exec/sandbox-policy.ts";

function sandboxRuleFromInterop(value: NonNullable<LsArgs["sandboxPolicy"]>): SandboxRule {
  const policy = adaptSandboxPolicyFromInterop(value);
  return Object.fromEntries(Object.entries(policy).filter(([, field]) => field !== undefined)) as SandboxRule;
}

export function lsExecutorArgsFromInterop(value: LsArgs): LsExecutorArgs {
  return {
    path: value.path,
    ...(value.ignore.length === 0 ? {} : { ignore: [...value.ignore] }),
    ...(value.toolCallId.length === 0 ? {} : { toolCallId: value.toolCallId }),
    ...(value.sandboxPolicy === undefined ? {} : { sandboxPolicy: sandboxRuleFromInterop(value.sandboxPolicy) }),
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
  };
}

export function lsExecutorArgsToInterop(value: LsExecutorArgs): LsArgs {
  const sandboxPolicy = value.sandboxPolicy === undefined ? undefined : adaptSandboxPolicyToInterop(value.sandboxPolicy);
  return new LsArgs({
    path: value.path,
    ...(value.ignore === undefined ? {} : { ignore: [...value.ignore] }),
    ...(value.toolCallId === undefined ? {} : { toolCallId: value.toolCallId }),
    ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
  });
}

function terminalCommandFromInterop(value: TerminalMetadata_Command): SlateTerminalCommand {
  return {
    command: value.command,
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
    ...(value.timestampMs === undefined ? {} : { timestampMs: value.timestampMs }),
    ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
  };
}

function terminalCommandToInterop(value: SlateTerminalCommand): TerminalMetadata_Command {
  return new TerminalMetadata_Command({
    command: value.command,
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
    ...(value.timestampMs === undefined ? {} : { timestampMs: value.timestampMs }),
    ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
  });
}

function terminalMetadataFromInterop(value: TerminalMetadata): SlateTerminalMetadata {
  return {
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    ...(value.lastModifiedMs === undefined ? {} : { lastModifiedMs: value.lastModifiedMs }),
    ...(value.lastCommands.length === 0 ? {} : { lastCommands: value.lastCommands.map(terminalCommandFromInterop) }),
    ...(value.currentCommand === undefined ? {} : { currentCommand: terminalCommandFromInterop(value.currentCommand) }),
  };
}

function terminalMetadataToInterop(value: SlateTerminalMetadata): TerminalMetadata {
  return new TerminalMetadata({
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    ...(value.lastCommands === undefined ? {} : { lastCommands: value.lastCommands.map(terminalCommandToInterop) }),
    ...(value.lastModifiedMs === undefined ? {} : { lastModifiedMs: value.lastModifiedMs }),
    ...(value.currentCommand === undefined ? {} : { currentCommand: terminalCommandToInterop(value.currentCommand) }),
  });
}

export function directoryTreeFromInterop(value: LsDirectoryTreeNode): SlateDirectoryTreeNode {
  return {
    absPath: value.absPath,
    childrenDirs: value.childrenDirs.map(directoryTreeFromInterop),
    childrenFiles: value.childrenFiles.map((file): SlateDirectoryTreeFile => ({
      name: file.name,
      ...(file.terminalMetadata === undefined ? {} : { terminalMetadata: terminalMetadataFromInterop(file.terminalMetadata) }),
    })),
    childrenWereProcessed: value.childrenWereProcessed,
    fullSubtreeExtensionCounts: { ...value.fullSubtreeExtensionCounts },
    numFiles: value.numFiles,
  };
}

export function directoryTreeToInterop(value: SlateDirectoryTreeNode): LsDirectoryTreeNode {
  return new LsDirectoryTreeNode({
    absPath: value.absPath,
    childrenDirs: value.childrenDirs.map(directoryTreeToInterop),
    childrenFiles: value.childrenFiles.map((file) => new LsDirectoryTreeNode_File({
      name: file.name,
      ...(file.terminalMetadata === undefined ? {} : { terminalMetadata: terminalMetadataToInterop(file.terminalMetadata) }),
    })),
    childrenWereProcessed: value.childrenWereProcessed,
    fullSubtreeExtensionCounts: { ...value.fullSubtreeExtensionCounts },
    numFiles: value.numFiles,
  });
}

export function lsExecutorResultFromInterop(value: LsResult): LsExecutorResult {
  switch (value.result.case) {
    case "success":
      return {
        kind: "success",
        ...(value.result.value.directoryTreeRoot === undefined ? {} : { root: directoryTreeFromInterop(value.result.value.directoryTreeRoot) }),
      };
    case "timeout":
      return {
        kind: "timeout",
        ...(value.result.value.directoryTreeRoot === undefined ? {} : { root: directoryTreeFromInterop(value.result.value.directoryTreeRoot) }),
      };
    case "error":
      return { kind: "error", path: value.result.value.path, error: value.result.value.error };
    case "rejected":
      return { kind: "rejected", path: value.result.value.path, reason: value.result.value.reason };
    case undefined:
      return { kind: "unrecognized" };
  }
}

export function lsExecutorResultToInterop(value: LsExecutorResult): LsResult {
  switch (value.kind) {
    case "success":
      return new LsResult({ result: { case: "success", value: new LsSuccess({
        ...(value.root === undefined ? {} : { directoryTreeRoot: directoryTreeToInterop(value.root) }),
      }) } });
    case "timeout":
      return new LsResult({ result: { case: "timeout", value: new LsTimeout({
        ...(value.root === undefined ? {} : { directoryTreeRoot: directoryTreeToInterop(value.root) }),
      }) } });
    case "error":
      return new LsResult({ result: { case: "error", value: new LsError({ path: value.path, error: value.error }) } });
    case "rejected":
      return new LsResult({ result: { case: "rejected", value: new LsRejected({ path: value.path, reason: value.reason }) } });
    case "unrecognized":
      return new LsResult();
  }
}

export const lsExecutorResource = createResource<Executor<LsExecutorArgs, LsExecutorResult>, RemoteExecManager, ControlledExecManager>(
  (manager) => {
    const serializeArgs = createServerSerializer("lsArgs");
    const deserializeResult = createClientDeserializer("lsResult");
    return new ExecutorResource(
      manager,
      (id, args, options) => serializeArgs(id, lsExecutorArgsToInterop(args), options),
      (message) => {
        const decoded = deserializeResult(message);
        return {
          value: decoded.value === undefined ? undefined : lsExecutorResultFromInterop(decoded.value),
          ...(decoded.hookContexts === undefined ? {} : { hookContexts: decoded.hookContexts }),
        };
      },
    );
  },
  (implementation, manager) => {
    const interopImplementation: Executor<LsArgs, LsResult> = {
      async execute(ctx, args, options) {
        return lsExecutorResultToInterop(await implementation.execute(ctx, lsExecutorArgsFromInterop(args), options));
      },
    };
    manager.register(new SimpleControlledExecHandler(
      interopImplementation,
      createServerDeserializer("lsArgs"),
      createClientSerializer("lsResult"),
    ));
  },
);
