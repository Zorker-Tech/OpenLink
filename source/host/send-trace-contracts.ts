export interface TraceSpan {
  setAttribute(key: string, value: unknown): void;
  recordException(error: Error): void;
  setStatus(status: { code: number }): void;
  end(): void;
}

export interface HostTrace {
  span: TraceSpan;
  context?: unknown;
}

export type TraceFactory = (options: {
  name: string;
  traceparent?: string;
  parentCtx?: unknown;
  startTime?: number;
  inheritableAttributes?: Record<string, unknown>;
}) => HostTrace | undefined;

export const SLATE_TURN_ROOT_SPAN_NAME = "slate.turn.run";
