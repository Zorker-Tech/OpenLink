import type { SlateMcpDisplayRow } from "./mcp-display-runtime.ts";

export interface ListedMcpTool {
  readonly toolName: string;
}

export interface BackendMcpEntry {
  readonly accountLabel: string;
  readonly serverIdentifier?: string;
  readonly status?: string;
  readonly tools: ListedMcpTool[];
}

export interface BoxMcpEntry {
  readonly status?: string;
  readonly statusDetail?: string;
  readonly toolCount: number;
  readonly tools: ListedMcpTool[];
}

export interface McpListingSummaryDependencies {
  settingsStore(): {
    getMcpDisabledToolsByServerId(): Record<string, string[]>;
    getRawMcpCustomInstructionByServerId(id: string): string | undefined;
    getRawMcpCustomInstruction(name: string): string | undefined;
  };
  isBoxExecWired(): boolean;
}

export interface McpAccountSlot {
  readonly accountKey: string;
  readonly hasToken: boolean;
  readonly serverIdentifier?: string;
}

export type McpSummaryServer = SlateMcpDisplayRow;
