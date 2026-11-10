/**
 * The instructions a user keeps for a connector.
 *
 * A user may write instructions for a connector, and they are followed whenever that connector's tools are used; a
 * connector the platform knows may also carry a default instruction for its own tools. What is stored is bounded and
 * what is sent says which connector it belongs to, and only the connectors that are actually connected are listed,
 * each once, in a stable order.
 */

/** The most text a stored instruction may hold; a longer one is cut, because a prompt has no room for it. */
export const MCP_CUSTOM_INSTRUCTIONS_MAX_LENGTH = 500;

/** One connector's instruction as the prompt lists it: the connector's name and what to follow while using it. */
interface ConnectorInstruction { name: string; instructions: string }

/** What a system prompt says before the list: these instructions are followed before the connector is ever called. */
const CUSTOM_INSTRUCTIONS_SECTION_INTRO = "Custom instructions are configured for some connected tools (MCP connectors). Always follow the matching instruction whenever you use that connector's tools, even before your first call to it:";

/** The heading that list sits under. */
const CUSTOM_INSTRUCTIONS_SECTION_HEADING = "## Connector custom instructions";

/** The instruction a connector carries when the user has not written one for it. */
const DEFAULT_MCP_CONNECTOR_INSTRUCTIONS = new Map([["hex", "When using Hex, get the underlying numbers as data: download/export the results as CSV or use the data the connector returns, and analyze those raw values directly. Don't read rendered charts or graphs from screenshots (computer-use chart reading is unreliable) — work from the actual data."]]);

/** An instruction longer than the platform keeps is cut to what fits. */
export function clampMcpCustomInstruction(raw: string): string {
  if (raw.length > MCP_CUSTOM_INSTRUCTIONS_MAX_LENGTH) return raw.slice(0, MCP_CUSTOM_INSTRUCTIONS_MAX_LENGTH);
  return raw;
}

/** The connector's own default instruction, matched by its name without padding or case. */
export function getDefaultMcpCustomInstruction(serverName: string): string {
  return DEFAULT_MCP_CONNECTOR_INSTRUCTIONS.get(serverName.trim().toLowerCase()) ?? "";
}

/** The instruction to follow for a connector: the stored one, trimmed, or the connector's own when none is stored. */
export function resolveMcpCustomInstruction(serverName: string, storedInstruction: string | undefined): string {
  if (storedInstruction !== undefined) return storedInstruction.trim();
  return getDefaultMcpCustomInstruction(serverName);
}

/** How an instruction is introduced in the tool's own note, naming the connector it belongs to. */
export function formatMcpCustomInstructionToolNote(serverName: string, instructions: string): string {
  return `Custom instructions for the "${serverName}" connector (always follow them when using this tool):\n${instructions.trim()}`;
}

/** Every connected connector that has an instruction, once, in the order of its name. */
export function selectConnectedMcpCustomInstructions(connectedServerNames: readonly string[], instructionsByServer: ReadonlyMap<string, string>): ConnectorInstruction[] {
  return [...new Set(connectedServerNames)]
    .map((name) => ({ name, instructions: resolveMcpCustomInstruction(name, instructionsByServer.get(name)) }))
    .filter((entry) => entry.instructions.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** One entry as the line it becomes in the prompt. */
const connectorInstructionLine = (entry: ConnectorInstruction): string => `- ${entry.name}: ${entry.instructions}`;

/** The system prompt's connector-instructions section, or null when no connected connector has an instruction. */
export function buildMcpCustomInstructionsSystemPromptSection(connectedServerNames: readonly string[], instructionsByServer: ReadonlyMap<string, string>): string | null {
  const entries = selectConnectedMcpCustomInstructions(connectedServerNames, instructionsByServer);
  if (entries.length === 0) return null;
  return [CUSTOM_INSTRUCTIONS_SECTION_HEADING, CUSTOM_INSTRUCTIONS_SECTION_INTRO, ...entries.map(connectorInstructionLine)].join("\n");
}
