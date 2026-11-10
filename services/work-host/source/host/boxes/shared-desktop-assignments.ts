import { setTimeout as delay } from "node:timers/promises";
import { BoxFileUnreadableError } from "./box-transfer.ts";
import type { Context } from "../../packages/context/context.ts";
import { SLATE_BOX_FIRST_FORK_WINDOW_INDEX, isPrimaryWindowIndex } from "../ports/box.ts";
import type { SharedInnerBox } from "./shared-desktop-contracts.ts";
import {
  ASSIGNMENTS_LOAD_RETRY_INTERVAL_MS,
  ASSIGNMENTS_LOAD_TIMEOUT_MS,
  SHARED_DESKTOP_ASSIGNMENTS_BOX_PATH,
  type ParsedAssignments,
  type SharedDesktopOptions,
} from "./shared-desktop-contracts.ts";

export function parseAssignments(bytes: Uint8Array, maxWindowCount: number): ParsedAssignments {
  const assignments = new Map<string, number>();
  const tokens = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { assignments, tokens, isCorrupt: true };
  }
  if (!isRecord(parsed)) return { assignments, tokens, isCorrupt: false };
  const rawAssignments = parsed.assignments;
  if (!isRecord(rawAssignments)) return { assignments, tokens, isCorrupt: false };
  const rawTokens = isRecord(parsed.tokens) ? parsed.tokens : undefined;
  const usedForkIndices = new Set<number>();

  for (const agentId of Object.keys(rawAssignments).sort()) {
    const index = rawAssignments[agentId];
    if (typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > maxWindowCount) continue;
    if (index >= SLATE_BOX_FIRST_FORK_WINDOW_INDEX) {
      if (usedForkIndices.has(index)) continue;
      usedForkIndices.add(index);
    }
    assignments.set(agentId, index);
    const token = rawTokens?.[agentId];
    if (typeof token === "string" && token.length > 0) tokens.set(agentId, token);
  }
  return { assignments, tokens, isCorrupt: false };
}

export function resolveSharedBoxId(explicit?: string, env: Record<string, string | undefined> = process.env): string {
  if (explicit) return explicit;
  return env.SLATE_SHARED_BOX_ID?.trim() || "shared";
}

export class SharedDesktopAssignments<Accessor> {
  readonly agentWindows = new Map<string, number>();
  readonly agentWindowTokens = new Map<string, string>();
  readonly establishedForks = new Set<string>();
  readonly windowsTearingDown = new Set<number>();
  private loadPromise: Promise<void> | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    readonly sharedBoxId: string,
    readonly maxWindowCount: number,
    readonly persistEnabled: boolean,
    private readonly options: Pick<SharedDesktopOptions<Accessor>, "now" | "sleep" | "reportPersistFailure">,
  ) {}

  async load(ctx: Context, inner: SharedInnerBox<Accessor>): Promise<void> {
    if (!this.persistEnabled) return;
    this.loadPromise ??= this.loadUntilReady(ctx, inner);
    try {
      await this.loadPromise;
    } catch (error) {
      this.loadPromise = undefined;
      throw error;
    }
  }

  queuePersistence(ctx: Context, inner: SharedInnerBox<Accessor>): void {
    if (!this.persistEnabled) return;
    const assignmentEntries = [...this.agentWindows];
    const assignments = Object.fromEntries(assignmentEntries);
    const tokens = Object.fromEntries(assignmentEntries.flatMap(([agentId]) => {
      const token = this.agentWindowTokens.get(agentId);
      return token == null ? [] : [[agentId, token]];
    }));
    this.writeChain = this.writeChain.then(async () => {
      try {
        await inner.uploadFile(
          ctx,
          this.sharedBoxId,
          SHARED_DESKTOP_ASSIGNMENTS_BOX_PATH,
          new TextEncoder().encode(JSON.stringify({ assignments, tokens })),
        );
      } catch (error) {
        this.options.reportPersistFailure?.(error);
      }
    });
  }

  takeFreeForkIndex(agentId: string): number | undefined {
    const used = new Set(this.agentWindows.values());
    for (let index = SLATE_BOX_FIRST_FORK_WINDOW_INDEX; index <= this.maxWindowCount; index += 1) {
      if (used.has(index) || this.windowsTearingDown.has(index)) continue;
      this.agentWindows.set(agentId, index);
      return index;
    }
    return undefined;
  }

  assignWindow(agentId: string): number | undefined {
    return this.agentWindows.get(agentId) ?? this.takeFreeForkIndex(agentId);
  }

  migratePrimarySeat(agentId: string, assigned: number, hasForkSupport: boolean): number {
    if (!isPrimaryWindowIndex(assigned) || !hasForkSupport) return assigned;
    const current = this.agentWindows.get(agentId) ?? assigned;
    return !isPrimaryWindowIndex(current) ? current : this.takeFreeForkIndex(agentId) ?? current;
  }

  flush(): Promise<void> {
    return this.writeChain;
  }

  private async loadUntilReady(ctx: Context, inner: SharedInnerBox<Accessor>): Promise<void> {
    const deadline = (this.options.now?.() ?? Date.now()) + ASSIGNMENTS_LOAD_TIMEOUT_MS;
    for (;;) {
      let bytes: Uint8Array;
      try {
        bytes = await inner.downloadFile(ctx, this.sharedBoxId, SHARED_DESKTOP_ASSIGNMENTS_BOX_PATH);
      } catch (error) {
        if (error instanceof BoxFileUnreadableError) return;
        if ((this.options.now?.() ?? Date.now()) >= deadline) throw error;
        await this.sleep(ASSIGNMENTS_LOAD_RETRY_INTERVAL_MS);
        continue;
      }

      const stored = parseAssignments(bytes, this.maxWindowCount);
      const haveAssignments = stored.assignments.size > 0;
      const hasReadableContents = bytes.length > 0 && !stored.isCorrupt;
      const outOfTime = (this.options.now?.() ?? Date.now()) >= deadline;
      if (!haveAssignments && !hasReadableContents && !outOfTime) {
        await this.sleep(ASSIGNMENTS_LOAD_RETRY_INTERVAL_MS);
        continue;
      }

      const used = new Set(this.agentWindows.values());
      for (const [agentId, index] of stored.assignments) {
        if (this.agentWindows.has(agentId) || used.has(index)) continue;
        this.agentWindows.set(agentId, index);
        used.add(index);
        const token = stored.tokens.get(agentId);
        if (token != null && !this.agentWindowTokens.has(agentId)) this.agentWindowTokens.set(agentId, token);
      }
      return;
    }
  }

  private async sleep(ms: number): Promise<void> {
    if (this.options.sleep != null) await this.options.sleep(ms);
    else await delay(ms);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
