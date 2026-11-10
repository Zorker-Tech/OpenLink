/** Slate's request and result contract for searching workspace files. */

import type { Executor } from "./executor-resources.ts";
import type { SandboxRule } from "../local-exec/sandbox-policy.ts";

export interface GrepExecutorArgs {
  readonly query: string;
  readonly path?: string;
  readonly filePattern?: string;
  readonly mode?: string;
  readonly contextBefore?: number;
  readonly contextAfter?: number;
  readonly contextLines?: number;
  readonly ignoreCase?: boolean;
  readonly fileType?: string;
  readonly resultLimit?: number;
  readonly multiline?: boolean;
  readonly sortBy?: string;
  readonly ascending?: boolean;
  readonly toolCallId?: string;
  readonly sandboxPolicy?: SandboxRule;
  readonly offset?: number;
}

export interface GrepFileCount {
  readonly path: string;
  readonly matches: number;
}

export interface GrepContentLine {
  readonly lineNumber: number;
  readonly content: string;
  readonly contentTruncated: boolean;
  readonly isContextLine: boolean;
}

export interface GrepFileContent {
  readonly path: string;
  readonly lines: readonly GrepContentLine[];
}

interface GrepResultBounds {
  readonly resultTruncated: boolean;
  readonly searchTruncated: boolean;
  readonly resultLimitApplied?: number;
  readonly offsetApplied?: number;
}

export type GrepOutputResult =
  | ({ readonly kind: "count"; readonly files: readonly GrepFileCount[]; readonly totalFiles: number; readonly totalMatches: number } & GrepResultBounds)
  | ({ readonly kind: "files"; readonly files: readonly string[]; readonly totalFiles: number } & GrepResultBounds)
  | ({ readonly kind: "content"; readonly files: readonly GrepFileContent[]; readonly totalLines: number; readonly totalMatchedLines: number } & GrepResultBounds)
  | { readonly kind: "unrecognized" };

export type GrepExecutorResult =
  | {
      readonly kind: "success";
      readonly query: string;
      readonly rootPath: string;
      readonly mode: string;
      readonly workspaceResults: Readonly<Record<string, GrepOutputResult>>;
      readonly activeEditorResult?: GrepOutputResult;
    }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "unrecognized" };

export type GrepExecutor = Executor<GrepExecutorArgs, GrepExecutorResult>;

export { grepExecutorResource } from "../../adapters/interop/agent/grep-operation-adapter.ts";
