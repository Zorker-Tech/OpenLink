/** Shared records and callbacks for work that survives the foreground turn. */

export interface BackgroundWorkRecord {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly ownerId?: string;
  readonly abort?: () => void;
  readonly metadata?: unknown;
}

export interface BackgroundWakeup {
  readonly id?: string;
  readonly conversationId?: string;
  readonly payload: {
    readonly kind: string;
    readonly reason?: string;
    readonly taskId: string;
    readonly title?: string;
    readonly status?: string;
    readonly detail?: string;
    readonly outputPath?: string;
  };
}

export interface BackgroundWorkFilter {
  readonly kind?: string;
}

export interface BackgroundWatchesHost {
  getConversationId(): string;
  emitAsyncTasksChanged(): void;
  pendingWakeArmedHandler(): ((event: unknown) => void) | undefined;
  backgroundShellSettledHandler(): ((event: unknown) => void) | undefined;
  notifyBackgroundWorkSettled(completion: unknown): void;
  cloudAgentWatcher(): {
    awaitCompletion(id: string, options: { waitForRestart: boolean }): Promise<{ status: string; text: string }>;
  } | null;
  pollShellTerminalFile(
    id: string,
    cancelled: () => boolean,
    settle: (status: string, detail?: string, outputPath?: string) => void,
  ): void;
}
