export interface RecentUserMessage {
  readonly id: string;
  readonly text: string;
}

export interface Usage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly [key: string]: unknown;
}

export type CompletedAwaitOutcome = "slept_full" | "completed_early";
