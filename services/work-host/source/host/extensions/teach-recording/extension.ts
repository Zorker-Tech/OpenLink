import { createDebouncePolicy, realClock } from "../scheduling.ts"
import { SLATE_TEACH_MAX_DURATION_MS } from "../../../shared/agents/teach-recording.ts"
import { createTeachRecordingService, LEARN_SKILL_NAME, type TeachRecordingDeps } from "./teach-recording-service.ts"
import { loadTeachQueueKey, parseTeachQueueKey } from "./teach-recording-queue-key.ts"
import type { TeachRecordingExtensionContext } from "./teach-recording-extension-contracts.ts"

export { loadTeachQueueKey, parseTeachQueueKey, TEACH_QUEUE_KEY_FILENAME } from "./teach-recording-queue-key.ts"
export type { TeachRecordingExtensionContext } from "./teach-recording-extension-contracts.ts"

export const CAP_SLACK_MS = 2_000

type ServiceFactory = (dependencies: TeachRecordingDeps) => ReturnType<typeof createTeachRecordingService>

export function createTeachRecordingExtension(makeService: ServiceFactory = createTeachRecordingService) {
  return {
    id: "teach-recording",
    dependencies: ["experiments", "forever-box", "managed-setup", "telemetry", "transcript"] as const,
    async start(context: TeachRecordingExtensionContext) {
      const analytics = context.deps.telemetry.analytics
      const service = makeService({
        box: context.deps["forever-box"].box,
        isEnabled: () => context.deps.experiments.checkFeatureGate("slate_teach_by_demonstration"),
        capPolicy: createDebouncePolicy(realClock, {
          name: "teach-recording-cap",
          delayMs: SLATE_TEACH_MAX_DURATION_MS + CAP_SLACK_MS,
        }),
        sendLearningPrompt: (agentId, prompt) => context.deps.transcript.sendPrompt(prompt.content, {
          agentId,
          clientNonce: prompt.clientNonce,
          directAddressedAcceptance: true,
          awaitTurn: false,
          richText: prompt.richText,
        }),
        listAgentIds: () => context.deps.transcript.listAgentIds(),
        queueSignatureKey: () => loadTeachQueueKey(),
        ensureLearningWorkflow: () => context.deps["managed-setup"].ensureManagedSkill(LEARN_SKILL_NAME),
        trackRecordingStarted: event => analytics.trackEvent("slate.teach.recording_started", event),
        trackRecordingStopped: event => analytics.trackEvent("slate.teach.recording_stopped", event),
        reportCapStopFailed: event => context.deps.telemetry.logs.reportTeachRecordingCapStopFailed(event),
        reportStartFailed: event => context.deps.telemetry.logs.reportTeachRecordingStartFailed(event),
      })

      try {
        await service.recoverPending()
      } catch {
        context.host.log("teach-recording: pending delivery recovery failed")
      }
      context.onStop(() => service.dispose())
      return service.api
    },
  }
}

export const teachRecordingExtension = createTeachRecordingExtension()
