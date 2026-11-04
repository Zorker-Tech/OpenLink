export { persistAvatarAndBuildSummary as setAgentAvatarBytes } from "./session-avatar-mutation.ts"
export { recoverDurableSession as recoverAgentWithMissingDb } from "./session-missing-db-recovery.ts"
export type {
  MissingDbRecoveryInput,
  MutationDb,
  SessionMutationMemory,
  SessionRecoveryHost,
} from "./session-mutations-contracts.ts"
