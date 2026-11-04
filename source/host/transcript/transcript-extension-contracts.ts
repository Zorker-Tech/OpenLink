import type { TranscriptManager, TurnExecutionPort } from "./transcript-manager.ts"

export interface TranscriptExtensionHost {
  readonly events: {
    emit(topic: string, payload: unknown): Promise<void> | void
  }
}

export interface TranscriptTurnExecutionSource {
  readonly canExecute: boolean
  isRunReady(): Promise<boolean>
  createRunner(...args: Parameters<TurnExecutionPort["createRunner"]>): ReturnType<TurnExecutionPort["createRunner"]>
  createGroupMemberRunner(
    ...args: Parameters<TurnExecutionPort["createGroupMemberRunner"]>
  ): ReturnType<TurnExecutionPort["createGroupMemberRunner"]>
}

export interface TranscriptExtensionDependencies {
  readonly session: { readonly store: ConstructorParameters<typeof TranscriptManager>[0] }
  readonly telemetry: {
    readonly brain: Parameters<TranscriptManager["setTelemetry"]>[0]
    readonly analytics: Parameters<TranscriptManager["setProductAnalytics"]>[0]
    readonly flushTracing: () => void
  }
  readonly memory: Parameters<TranscriptManager["setMemory"]>[0]
  readonly "content-search": Parameters<TranscriptManager["setContentSearch"]>[0]
  readonly attachments: Parameters<TranscriptManager["setAttachments"]>[0]
  readonly trays: Parameters<TranscriptManager["setTrayErrors"]>[0]
  readonly "turn-execution": TranscriptTurnExecutionSource
}

export interface TranscriptListenerConnected {
  readonly agentId: string
  readonly platform: string
}

export interface TranscriptRunLifecycle {
  readonly type: "started" | "ended"
  readonly requestId: string
}
