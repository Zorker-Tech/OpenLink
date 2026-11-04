/** Agent-wide execution limits and paths owned by Slate's stores. */

export const MAX_AGENT_STEPS = 512

export const AUTOMATION_TOOLS_MCP_SERVER_ID = "Slate Automation Tools"
export const SUBSCRIPTIONS_MCP_SERVER_NAME = "slate-subscriptions"

/** Where a named agent's home store is mounted, and what it keeps there. */
export const NAMED_AGENT_HOME_STORE_PATH = "/slate/stores/home"
export const NAMED_AGENT_SELF_MEMORY_FILE = "SELF.md"
export const NAMED_AGENT_STORE_SELF_PATH = `${NAMED_AGENT_HOME_STORE_PATH}/${NAMED_AGENT_SELF_MEMORY_FILE}`
export const NAMED_AGENT_STORE_ACTIVITY_DIR = `${NAMED_AGENT_HOME_STORE_PATH}/activity`
