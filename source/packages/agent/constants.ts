/**
 * The names and paths the agent's automation and store surfaces are addressed by.
 *
 * These are strings other parts of the platform match against: a tool name the model is told to call,
 * the identifier a server registers itself under, and the virtual path a store is mounted at. They live
 * in one place because the prompt that describes a tool and the code that dispatches it must agree on
 * the name exactly, and a typo in one of them is a tool that is described but never callable.
 */

export const MAX_AGENT_STEPS = 512

/** Slack and automation tools, as the platform names them when talking to the model. */
export const SEND_SLACK_MESSAGE_V2_TOOL_NAME = "SendSlackMessageV2"
export const OFFER_REPOSITORY_SWITCH_TOOL_NAME = "OfferRepositorySwitch"
export const START_SLACK_STREAMING_TOOL_NAME = "StartSlackStreaming"

/** The MCP servers those tools are served from, and the tools inside them. */
export const SLACK_AGENT_TOOLS_MCP_SERVER_ID = "Slate Slack Tools"
export const SLACK_SEND_MESSAGE_MCP_TOOL_NAME = "send_slack_message"
export const SLACK_OFFER_REPOSITORY_SWITCH_MCP_TOOL_NAME = "offer_repository_switch"
export const SLACK_START_STREAMING_MCP_TOOL_NAME = "start_slack_streaming"
export const SLACK_SET_STATUS_MCP_TOOL_NAME = "set_slack_status"
export const AUTOMATION_TOOLS_MCP_SERVER_ID = "Slate Automation Tools"
export const SUBSCRIPTIONS_MCP_SERVER_NAME = "slate-subscriptions"

/** Where a named agent's home store is mounted, and what it keeps there. */
export const NAMED_AGENT_HOME_STORE_PATH = "/slate/stores/home"
export const NAMED_AGENT_SELF_MEMORY_FILE = "SELF.md"
export const NAMED_AGENT_STORE_SELF_PATH = `${NAMED_AGENT_HOME_STORE_PATH}/${NAMED_AGENT_SELF_MEMORY_FILE}`
export const NAMED_AGENT_STORE_ACTIVITY_DIR = `${NAMED_AGENT_HOME_STORE_PATH}/activity`
