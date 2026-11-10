import type { RemoteExecManager } from "./executor-resources.ts"
import { createResource, type ControlledExecManager } from "./resource-provider.ts"
import {
  conflictNoticeAck,
  conflictNoticeNoteDeferredEagerWrittenPaths,
  conflictNoticePeek,
  conflictNoticeRelease,
  conflictNoticeSyncAndPeek,
} from "./agent-store-conflict-notice-operations.ts"
import { RemoteAgentStoreConflictNoticeStub } from "./agent-store-conflict-notice-stub.ts"

export {
  conflictNoticeAck,
  conflictNoticeNoteDeferredEagerWrittenPaths,
  conflictNoticePeek,
  conflictNoticeRelease,
  conflictNoticeSyncAndPeek,
  RemoteAgentStoreConflictNoticeStub,
}
export type {
  ConflictNoticeCommand,
  ConflictNoticeConversation,
  ConflictNoticeSyncRequest,
  Executor,
} from "./agent-store-conflict-notice-contracts.ts"

export const agentStoreConflictNoticeExecutorResource = createResource<
  RemoteAgentStoreConflictNoticeStub,
  RemoteExecManager,
  ControlledExecManager
>(
  (_remote) => new RemoteAgentStoreConflictNoticeStub(),
  (_implementation, _controlled) => {},
)
