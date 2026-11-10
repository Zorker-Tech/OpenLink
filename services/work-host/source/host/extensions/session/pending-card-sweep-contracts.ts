export interface PendingCardMessage {
  readonly type?: string;
  readonly approval?: { readonly requestId: string; readonly status: string };
  readonly ask?: { readonly requestId: string; readonly status: string };
}

export interface PendingTranscriptCard {
  readonly id: string;
  readonly kind: string;
  readonly timestampMs?: number | null;
  readonly message?: PendingCardMessage;
}

export interface SessionCardDatabase {
  getTranscriptEntries(): Array<Record<string, unknown>>;
  updateTranscriptEntry(
    id: string,
    update: (entry: Record<string, unknown>) => Record<string, unknown>,
  ): void;
}

export interface PendingCardSweepPlan<Card extends PendingTranscriptCard> {
  readonly messageType: string;
  readonly onlyRequestId?: string;
  readonly ifPendingBeforeMs?: number;
  readonly statusOf: (entry: Card) => string | undefined;
  readonly requestIdOf: (entry: Card) => string | undefined;
  readonly settle: (entry: Card, requestId: string) => Card | null;
}
