import { createDebouncePolicy, realClock } from "../extensions/scheduling.ts"
import { getSlateRootDir } from "../host-paths.ts"
import { PromptAcceptanceLedger } from "./prompt-acceptance-ledger.ts"
import { OUTLINE_STREAM_COALESCE_MS } from "./roster-projection.ts"
import { SlateAckObligationStore } from "./slate-ack-obligation-store.ts"
import { SlatePendingWakeStore } from "./slate-pending-wake-store.ts"
import { SlateUpgradeResumeStore } from "./slate-upgrade-resume-store.ts"
import { TranscriptManager, type TurnExecutionPort } from "./transcript-manager.ts"
import type { TranscriptExtensionDependencies } from "./transcript-extension-contracts.ts"

function connectTurnExecution(
  manager: TranscriptManager,
  source: TranscriptExtensionDependencies["turn-execution"],
): void {
  const execution = {
    get canExecute() { return source.canExecute },
    get canExecuteGroupMember() { return source.canExecute },
    isRunReady: () => source.isRunReady(),
    createRunner: (...args: Parameters<TurnExecutionPort["createRunner"]>) => source.createRunner(...args),
    createGroupMemberRunner: (...args: Parameters<TurnExecutionPort["createGroupMemberRunner"]>) =>
      source.createGroupMemberRunner(...args),
  } satisfies TurnExecutionPort
  manager.setTurnExecution(execution)
}

function coalesceOutlineUpdates(manager: TranscriptManager): void {
  const policy = createDebouncePolicy(realClock, {
    name: "transcript-outline-stream",
    delayMs: OUTLINE_STREAM_COALESCE_MS,
  })
  const roster = manager.roster as unknown as {
    setOutlineStreamCoalescing?: (next: typeof policy) => void
  }
  roster.setOutlineStreamCoalescing?.call(manager.roster, policy)
}

export function createTranscriptExtensionManager(
  dependencies: TranscriptExtensionDependencies,
  rootDirectory = getSlateRootDir(),
): TranscriptManager {
  const manager = new TranscriptManager(
    dependencies.session.store,
    new SlateUpgradeResumeStore(rootDirectory),
    new SlateAckObligationStore(rootDirectory),
    new PromptAcceptanceLedger(rootDirectory),
    new SlatePendingWakeStore(rootDirectory),
  )
  manager.setTelemetry(dependencies.telemetry.brain)
  manager.setProductAnalytics(dependencies.telemetry.analytics)
  manager.setTraceFlusher(dependencies.telemetry.flushTracing)
  manager.setMemory(dependencies.memory)
  manager.setContentSearch(dependencies["content-search"])
  manager.setAttachments(dependencies.attachments)
  manager.setTrayErrors(dependencies.trays)
  connectTurnExecution(manager, dependencies["turn-execution"])
  coalesceOutlineUpdates(manager)
  return manager
}
