import type { TranscriptManager } from "./transcript-manager.ts"
import type {
  TranscriptExtensionHost,
  TranscriptListenerConnected,
  TranscriptRunLifecycle,
} from "./transcript-extension-contracts.ts"

export function bindTranscriptHostEvents(
  manager: TranscriptManager,
  host: TranscriptExtensionHost,
): void {
  const announce = (topic: string, payload: unknown): void => {
    void host.events.emit(topic, payload)
  }

  manager.setAutomationConfigChanged(() => announce("transcript.automation-config-changed", {}))
  manager.setListenerConnectObserver(({ agentId, platform }: TranscriptListenerConnected) => {
    announce("transcript.listener-connect-card", { agentId, platform })
  })
  manager.setAgentRunLifecycleObserver(({ type, requestId }: TranscriptRunLifecycle) => {
    const topic = type === "started" ? "transcript.run-started" : "transcript.run-ended"
    announce(topic, { requestId })
  })
}
