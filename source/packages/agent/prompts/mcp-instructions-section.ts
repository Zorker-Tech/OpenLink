/**
 * The instructions MCP servers attach to themselves.
 *
 * A server can describe how it wants to be used — which tool to start from, what a resource means — and
 * those instructions are part of the prompt rather than part of a tool's description, because they apply
 * to the server as a whole. Each entry names its server so the model can tell them apart; a server that
 * did not name itself is still shown, labelled as unknown rather than dropped.
 */

import { jsx, type PromptElement } from "../../prompt-jsx/index.ts"
import type { UserInfoMcpInstructions } from "./user-info-data-contracts.ts"

export function McpInstructionsSection({ mcpEntries }: { readonly mcpEntries: readonly UserInfoMcpInstructions[] }): PromptElement {
  return jsx("section", {
    title: "mcp_instructions",
    description: "Instructions provided by MCP servers to help use them properly",
    children: mcpEntries.map(entry => `Server: ${entry.serverName ?? "unknown"}\n${entry.instructions}`).join("\n\n"),
  })
}
