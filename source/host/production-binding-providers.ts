/**
 * The providers a production host binds: what the box, the transcript and the local machine are reached through, wired
 * once so the rest of the host asks a typed port rather than a global.
 */
import { createContext } from "../packages/context/context.ts";
import { HistoryVisibilityMode, convertConversationMessagesToTrace } from "../adapters/interop/agent/conversation-message-trace-adapter.ts";
import { createSecretsExtension } from "./extensions/secrets/extension.ts";
import { createStateBackstopExtension } from "./extensions/state-backstop/extension.ts";
import { readStoreDbBytes } from "./extensions/state-backstop/state-backstop-service.ts";
import { getSlateAgentsRootDir } from "./storage/agent-paths.ts";
import { checkpointSlateAgentDb } from "./storage/store-db.ts";

export interface ProductionBindingDependencies {
  readonly createSecretsContext: Parameters<typeof createSecretsExtension>[0];
  readonly getAgentsRootDir: typeof getSlateAgentsRootDir;
  readonly readDbBytes: typeof readStoreDbBytes;
  readonly checkpointDb: typeof checkpointSlateAgentDb;
  readonly convertConversationMessagesToTrace: typeof convertConversationMessagesToTrace;
}

/** Build the host-owned bindings from the local ports the production entrypoint selected. */
export function createProductionBindingProviders(dependencies: ProductionBindingDependencies) {
  return {
    secretsContext: dependencies.createSecretsContext,
    createStateBackstop: (): Parameters<typeof createStateBackstopExtension>[0] => ({
      agentsRootDir: dependencies.getAgentsRootDir(),
      readDbBytes: dbPath => dependencies.readDbBytes(dbPath, dependencies.checkpointDb)
    }),
    convertCloudAgentConversationToTrace: (conversation: unknown): readonly unknown[] =>
      dependencies.convertConversationMessagesToTrace(
        conversation,
        HistoryVisibilityMode.NO_PREAMBLE
      )
  };
}

const productionProviders = createProductionBindingProviders({
  createSecretsContext: createContext,
  getAgentsRootDir: getSlateAgentsRootDir,
  readDbBytes: readStoreDbBytes,
  checkpointDb: checkpointSlateAgentDb,
  convertConversationMessagesToTrace
});

/**
 * Concrete production bindings whose complete construction is recoverable from
 * the immutable host bundle. Generated clients and context-dependent extension
 * factories deliberately do not appear here.
 */
export const productionSecretsContext:
  Parameters<typeof createSecretsExtension>[0] = productionProviders.secretsContext;

export function createProductionStateBackstop():
  Parameters<typeof createStateBackstopExtension>[0] {
  return productionProviders.createStateBackstop();
}

export function convertProductionCloudAgentConversationToTrace(
  conversation: unknown
): readonly unknown[] {
  return productionProviders.convertCloudAgentConversationToTrace(conversation);
}
