/**
 * The providers a production host binds: what the box, the transcript and the local machine are reached through, wired
 * once so the rest of the host asks a typed port rather than a global.
 */
import { createContext } from "../packages/context/context.ts";
import { HistoryVisibilityMode, convertConversationMessagesToTrace } from "./transcript/agent-transcript/trace-format.ts";
import type { ConversationMessage } from "../packages/proto/generated/aiserver/v1/chat_pb.ts";
import { createSecretsExtension } from "./extensions/secrets/extension.ts";
import { createStateBackstopExtension } from "./extensions/state-backstop/extension.ts";
import { readStoreDbBytes } from "./extensions/state-backstop/state-backstop-service.ts";
import { getSlateAgentsRootDir } from "./storage/agent-paths.ts";
import { checkpointSlateAgentDb } from "./storage/store-db.ts";

/**
 * Concrete production bindings whose complete construction is recoverable from
 * the immutable host bundle. Generated clients and context-dependent extension
 * factories deliberately do not appear here.
 */
export const productionSecretsContext:
  Parameters<typeof createSecretsExtension>[0] = createContext;

export function createProductionStateBackstop():
  Parameters<typeof createStateBackstopExtension>[0] {
  return {
    agentsRootDir: getSlateAgentsRootDir(),
    readDbBytes: dbPath => readStoreDbBytes(dbPath, checkpointSlateAgentDb)
  };
}

export function convertProductionCloudAgentConversationToTrace(
  conversation: unknown
): readonly unknown[] {
  return convertConversationMessagesToTrace(
    conversation as readonly ConversationMessage[],
    HistoryVisibilityMode.NO_PREAMBLE
  );
}
