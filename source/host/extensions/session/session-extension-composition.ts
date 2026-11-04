/** Builds the host's session store and the services that share its lifetime. */

import { BoxHandoffService } from "./box-handoff-service.ts"
import { resolveConversationBlobStorePath } from "./conversation-blobs-path.ts"
import {
  pinConversationGc,
  pinConversationSizeLimitsReader,
} from "./conversation-size-limits.ts"
import { SlateAgentSessionStore } from "./agent-session.ts"
import {
  pinLegacyStoreBlobRetirement,
  pinStaleRootGc,
} from "./session-maintenance.ts"
import type { SessionExtensionApi, SessionExtensionContext } from "./session-extension-contracts.ts"

const BOOT_GATES = [
  ["slate_stale_root_gc", pinStaleRootGc],
  ["slate_legacy_store_blob_retirement", pinLegacyStoreBlobRetirement],
  ["slate_conversation_gc", pinConversationGc],
] as const

export function startSessionExtension(context: SessionExtensionContext): SessionExtensionApi {
  const resolveUserTimeZone = () => context.deps.settings.getUserTimeZone()
  const store = context.createStore?.(resolveUserTimeZone) ??
    new SlateAgentSessionStore(context.rootDir, resolveUserTimeZone)

  for (const [gateName, pinGate] of BOOT_GATES) {
    context.deps.experiments.pinGateOnAuthenticatedBootstrap(gateName, pinGate)
  }
  pinConversationSizeLimitsReader(() =>
    context.deps.experiments.getDynamicConfig("slate_conversation_size_limits"),
  )

  const handoff = new BoxHandoffService(context.createHandoffDeps())
  context.onStop?.(() => store.closeWorkerPool())

  return {
    store,
    transcriptsDir: () => context.getTranscriptsDir(),
    conversationBlobsPath: resolveConversationBlobStorePath,
    pendingHandoff: agentId => handoff.get(agentId),
    startHandoff: request => handoff.start(request),
    endHandoff: (agentId, trigger) => handoff.end(agentId, trigger),
    forgetHandoff: agentId => handoff.forget(agentId),
  }
}
