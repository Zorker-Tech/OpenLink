/** Slate's contract for listing the contents of a workspace directory. */

import type { Executor } from "./executor-resources.ts";
import type { SandboxRule } from "../local-exec/sandbox-policy.ts";

export interface SlateTerminalCommand {
  readonly command: string;
  readonly exitCode?: number;
  readonly timestampMs?: bigint;
  readonly durationMs?: bigint;
}

export interface SlateTerminalMetadata {
  readonly cwd?: string;
  readonly lastModifiedMs?: bigint;
  readonly lastCommands?: readonly SlateTerminalCommand[];
  readonly currentCommand?: SlateTerminalCommand;
}

export interface SlateDirectoryTreeFile {
  readonly name: string;
  readonly terminalMetadata?: SlateTerminalMetadata;
}

export interface SlateDirectoryTreeNode {
  readonly absPath: string;
  readonly childrenWereProcessed: boolean;
  readonly childrenFiles: readonly SlateDirectoryTreeFile[];
  readonly childrenDirs: readonly SlateDirectoryTreeNode[];
  readonly numFiles: number;
  readonly fullSubtreeExtensionCounts: Readonly<Record<string, number>>;
}

export interface LsExecutorArgs {
  readonly path: string;
  readonly ignore?: readonly string[];
  readonly toolCallId?: string;
  readonly sandboxPolicy?: SandboxRule;
  readonly timeoutMs?: number;
}

export type LsExecutorResult =
  | { readonly kind: "success"; readonly root?: SlateDirectoryTreeNode }
  | { readonly kind: "timeout"; readonly root?: SlateDirectoryTreeNode }
  | { readonly kind: "error"; readonly path: string; readonly error: string }
  | { readonly kind: "rejected"; readonly path: string; readonly reason: string }
  | { readonly kind: "unrecognized" };

export type LsExecutor = Executor<LsExecutorArgs, LsExecutorResult>;

export { lsExecutorResource } from "../../adapters/interop/agent/ls-operation-adapter.ts";
