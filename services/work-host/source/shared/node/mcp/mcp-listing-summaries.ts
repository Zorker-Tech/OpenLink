import { DEFAULT_MCP_ACCOUNT_KEY } from "../../mcp.ts";
import type { SlateMcpDisplayRow } from "./mcp-display-runtime.ts";
import {
  adminDisabledServerSummary,
  backendAccountSummary,
  boxServerSummary,
} from "./mcp-listing-summary-projectors.ts";
import type {
  BackendMcpEntry,
  BoxMcpEntry,
  McpListingSummaryDependencies,
} from "./mcp-listing-summary-contracts.ts";

export type { BackendMcpEntry, BoxMcpEntry, McpListingSummaryDependencies } from "./mcp-listing-summary-contracts.ts";

export class SlateMcpListingSummaries {
  constructor(private readonly dependencies: McpListingSummaryDependencies) {}

  createBackendServerSummaries(server: SlateMcpDisplayRow, entries: BackendMcpEntry[]) {
    const slots = server.accounts ?? [];
    if (slots.length === 0) {
      const fallback = entries.find((entry) => entry.accountLabel === DEFAULT_MCP_ACCOUNT_KEY) ?? entries[0];
      return [backendAccountSummary(server, fallback, DEFAULT_MCP_ACCOUNT_KEY, undefined, this.dependencies)];
    }
    return slots.map((slot) => {
      const backend = entries.find((entry) => entry.accountLabel === slot.accountKey);
      return backendAccountSummary(server, backend, slot.accountKey, slot, this.dependencies);
    });
  }

  createBoxServerSummary(server: SlateMcpDisplayRow, box: BoxMcpEntry | undefined, unavailable: boolean) {
    return boxServerSummary(server, box, unavailable, this.dependencies);
  }

  createAdminDisabledServerSummary(server: SlateMcpDisplayRow) {
    return adminDisabledServerSummary(server, this.dependencies);
  }
}
