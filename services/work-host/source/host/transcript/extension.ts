/**
 * Registers transcript services with the host and closes the manager at shutdown.
 */
import { HostExtensions } from "../extensions/extension-ids.generated.ts"
import { defineHostExtension } from "../extensions/host-extensions.ts"
import { bindTranscriptHostEvents } from "./transcript-extension-host-events.ts"
import type {
  TranscriptExtensionDependencies,
  TranscriptExtensionHost,
} from "./transcript-extension-contracts.ts"
import { createTranscriptExtensionManager } from "./transcript-extension-services.ts"
import type { TranscriptManager } from "./transcript-manager.ts"

export const transcriptExtension = defineHostExtension<TranscriptManager, TranscriptExtensionHost>({
  id: HostExtensions.Transcript,
  dependencies: [
    HostExtensions.Attachments,
    HostExtensions.ContentSearch,
    HostExtensions.Memory,
    HostExtensions.Session,
    HostExtensions.Telemetry,
    HostExtensions.Trays,
    HostExtensions.TurnExecution,
  ],
  start(context) {
    const dependencies = context.deps as unknown as TranscriptExtensionDependencies
    const manager = createTranscriptExtensionManager(dependencies)
    bindTranscriptHostEvents(manager, context.host)
    context.onStop(() => manager.dispose())
    return manager
  },
})
