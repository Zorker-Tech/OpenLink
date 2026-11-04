import type { HostBox } from "../../boxes/forever-box/host-box.ts"

export interface TeachRecordingExtensionContext {
  deps: {
    experiments: { checkFeatureGate(name: string): boolean }
    "forever-box": { box: HostBox }
    "managed-setup": { ensureManagedSkill(id: string): Promise<boolean> }
    transcript: {
      sendPrompt(content: string, options: Record<string, unknown>): Promise<void>
      listAgentIds(): Promise<readonly string[]>
    }
    telemetry: {
      analytics: { trackEvent(name: string, event: Record<string, unknown>): void }
      logs: {
        reportTeachRecordingCapStopFailed(event: Record<string, unknown>): void
        reportTeachRecordingStartFailed(event: Record<string, unknown>): void
      }
    }
  }
  onStop(fn: () => Promise<void>): void
  host: { log(message: string): void }
}
