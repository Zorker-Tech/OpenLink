/** The methods the coordinator's main connection answers to, and how one is recognized. */

/** The methods that take no argument at all; every other method is called with an object. */
const WITHOUT_ARGUMENTS: readonly string[] = ["getHostSettings", "getHostStatus", "listAgents"];

/** Every method of the surface, in the order the table names them. */
const METHOD_NAMES = [
  "uploadAttachment",
  "readAttachmentImage",
  "readAttachmentText",
  "readAttachmentChunk",
  "getHostSettings",
  "setHostSettings",
  "setBoxSecrets",
  "refreshMcp",
  "listBoxMcpServers",
  "updateForeverBox",
  "setWindowFocused",
  "getHostStatus",
  "listAgents",
  "createAgent",
  "deleteAgents",
  "getConversationOutline",
  "getSubagents",
  "setDevGatewayOffline",
  "setGatewayPaused",
] as const;

type CoordinatorMainMethodTable = Readonly<Record<(typeof METHOD_NAMES)[number], { readonly args: "object" | "none" }>>;

const WITHOUT_ARGUMENTS_SET: ReadonlySet<string> = new Set(WITHOUT_ARGUMENTS);

/** The methods, each saying whether it is called with an object or with nothing. */
export const COORDINATOR_MAIN_METHOD_TABLE: CoordinatorMainMethodTable = Object.fromEntries(
  METHOD_NAMES.map((method) => [method, { args: WITHOUT_ARGUMENTS_SET.has(method) ? "none" : "object" }]),
) as CoordinatorMainMethodTable;

export type CoordinatorMainMethod = keyof typeof COORDINATOR_MAIN_METHOD_TABLE;

export function isCoordinatorMainMethod(name: string): name is CoordinatorMainMethod {
  return Object.hasOwn(COORDINATOR_MAIN_METHOD_TABLE, name);
}
