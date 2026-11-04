import { brandedErrno } from "../../../shared/errors/bounded-values.ts";
import type { JournalOutcome } from "./transcript-mirror-contracts.ts";

export class TranscriptMirrorOutcomeReporter {
  constructor(
    private readonly report: (outcome: JournalOutcome) => void,
    private readonly reportedFailures: WeakSet<object>,
  ) {}

  async run<Result extends { entryCount?: number; bytes?: number } | void>(
    operation: string,
    conversationId: string,
    makeFailure: (errno?: string) => unknown,
    perform: () => Promise<Result>,
  ): Promise<Result> {
    const startedAt = performance.now();
    try {
      const counts = await perform();
      this.report({
        op: operation,
        outcome: "ok",
        conversationId,
        ...(counts ?? {}),
        durationMs: performance.now() - startedAt,
      });
      return counts;
    } catch (error) {
      if (this.shouldReport(error)) {
        this.report({
          op: operation,
          outcome: "failed",
          conversationId,
          cause: makeFailure(readErrno(error)),
          durationMs: performance.now() - startedAt,
        });
      }
      throw error;
    }
  }

  private shouldReport(error: unknown): boolean {
    if (typeof error !== "object" || error == null) return true;
    if (this.reportedFailures.has(error)) return false;
    this.reportedFailures.add(error);
    return true;
  }
}

function readErrno(error: unknown): string | undefined {
  if (typeof error !== "object" || error == null || !("code" in error) || typeof error.code !== "string") return undefined;
  return brandedErrno(error.code);
}
