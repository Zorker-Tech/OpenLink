import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { SLATE_DISK_PRESSURE_REMINDERS_FILE_NAME } from "../../durable-file-policy.ts";
import type { PressureLevel } from "./disk-pressure-guard.ts";
import {
  persistDiskPressureReminderLedger,
  restoreDiskPressureReminderLedger,
} from "./disk-pressure-reminder-persistence.ts";

export type { DiskPressureReminderLedgerState, RestoredDiskPressureReminderLedger } from "./disk-pressure-reminder-persistence.ts";
export { SlateDiskPressureLedgerError } from "./disk-pressure-reminder-persistence.ts";

export interface DiskPressureReminderEpisodes {
  claim(value: { agentId: string; claimId: string }): string | null;
  release(value: { agentId: string; claimId: string }): void;
  enroll(agentIds: Iterable<string>): void;
  commit(value: { agentId: string; claimId: string }): boolean;
  forgetAgent(agentId: string): void;
  observePressure(level: PressureLevel, complete?: boolean): void;
}

interface EpisodeLease {
  readonly claimId: string;
  readonly episodeId: string;
}

interface ReminderLedgerOptions {
  readonly rootDir?: string;
  readonly createEpisodeId?: () => string;
  readonly onLedgerError?: (error: unknown) => void;
}

function appendEpisode(queue: Map<string, string[]>, agentId: string, episodeId: string): boolean {
  const outstanding = queue.get(agentId) ?? [];
  if (outstanding.includes(episodeId)) return false;
  queue.set(agentId, [...outstanding, episodeId]);
  return true;
}

/** Owns episode identity, delivery leases, and recovery transitions for one host. */
class PressureEpisodeLedger {
  #filePath: string | undefined;
  #newEpisodeId: () => string;
  #reportFailure: ((error: unknown) => void) | undefined;
  #active: string | null;
  #seenByAgent: Set<string>;
  #deliveries: Map<string, string[]>;
  #leases = new Map<string, EpisodeLease>();
  #startupNeedsPressure: boolean;
  #writeNeedsRetry = false;

  constructor(options?: ReminderLedgerOptions) {
    this.#filePath = options?.rootDir === undefined
      ? undefined
      : join(options.rootDir, SLATE_DISK_PRESSURE_REMINDERS_FILE_NAME);
    this.#reportFailure = options?.onLedgerError;
    this.#newEpisodeId = options?.createEpisodeId ?? randomUUID;
    this.#deliveries = new Map();
    const restored = restoreDiskPressureReminderLedger({
      filePath: this.#filePath,
      enqueue: (agentId, episodeId) => appendEpisode(this.#deliveries, agentId, episodeId),
      onLedgerError: this.#reportFailure,
    });
    this.#active = restored.activeEpisodeId;
    this.#seenByAgent = restored.handledAgentIds;
    this.#startupNeedsPressure = this.#active !== null;
  }

  publicApi(): DiskPressureReminderEpisodes {
    return {
      claim: (value) => this.reserve(value.agentId, value.claimId),
      release: (value) => this.release(value.agentId, value.claimId),
      enroll: (agentIds) => this.enrollAgents(agentIds),
      commit: (value) => this.acknowledge(value.agentId, value.claimId),
      forgetAgent: (agentId) => this.forget(agentId),
      observePressure: (level, complete = true) => this.advance(level, complete),
    };
  }

  private reserve(agentId: string, claimId: string): string | null {
    const existingLease = this.#leases.get(agentId);
    if (existingLease !== undefined) return existingLease.claimId === claimId ? existingLease.episodeId : null;

    if (this.#active !== null && !this.#seenByAgent.has(agentId) && this.enqueue(agentId, this.#active)) this.persist();
    const episodeId = this.#deliveries.get(agentId)?.[0];
    if (episodeId === undefined) return null;
    this.#leases.set(agentId, { claimId, episodeId });
    return episodeId;
  }

  private release(agentId: string, claimId: string): void {
    if (this.#leases.get(agentId)?.claimId === claimId) this.#leases.delete(agentId);
  }

  private enrollAgents(agentIds: Iterable<string>): void {
    if (this.#active === null) return;
    let queuedAnother = false;
    for (const agentId of agentIds) {
      if (!this.#seenByAgent.has(agentId)) queuedAnother = this.enqueue(agentId, this.#active) || queuedAnother;
    }
    if (queuedAnother) this.persist();
  }

  private acknowledge(agentId: string, claimId: string): boolean {
    const lease = this.#leases.get(agentId);
    const deliveries = this.#deliveries.get(agentId);
    if (lease?.claimId !== claimId || deliveries?.[0] !== lease.episodeId) return false;

    const remaining = deliveries.slice(1);
    if (remaining.length === 0) this.#deliveries.delete(agentId);
    else this.#deliveries.set(agentId, remaining);

    const wasAlreadySeen = this.#seenByAgent.has(agentId);
    if (this.#active === lease.episodeId) this.#seenByAgent.add(agentId);
    if (!this.persist()) {
      this.#deliveries.set(agentId, deliveries);
      if (!wasAlreadySeen) this.#seenByAgent.delete(agentId);
      return false;
    }
    this.#leases.delete(agentId);
    return true;
  }

  private forget(agentId: string): void {
    this.#leases.delete(agentId);
    const removedDelivery = this.#deliveries.delete(agentId);
    const removedSeenMark = this.#seenByAgent.delete(agentId);
    if (removedDelivery || removedSeenMark) this.persist();
  }

  private advance(level: PressureLevel, complete: boolean): void {
    if (level === "healthy") {
      if (this.#active === null || (!complete && this.#startupNeedsPressure)) return;
    } else if (this.#active !== null) {
      this.#startupNeedsPressure = false;
      if (this.#writeNeedsRetry && this.persist()) this.#writeNeedsRetry = false;
      return;
    }

    const previous = {
      episodeId: this.#active,
      awaitingFirstPressure: this.#startupNeedsPressure,
      seenAgents: [...this.#seenByAgent],
    };
    this.#active = level === "healthy" ? null : this.#newEpisodeId();
    this.#startupNeedsPressure = false;
    this.#seenByAgent.clear();

    if (this.persist()) {
      this.#writeNeedsRetry = false;
      return;
    }
    if (level !== "healthy") {
      this.#writeNeedsRetry = true;
      return;
    }

    this.#active = previous.episodeId;
    this.#startupNeedsPressure = previous.awaitingFirstPressure;
    for (const agentId of previous.seenAgents) this.#seenByAgent.add(agentId);
  }

  private enqueue(agentId: string, episodeId: string): boolean {
    return appendEpisode(this.#deliveries, agentId, episodeId);
  }

  private persist(): boolean {
    return persistDiskPressureReminderLedger({
      filePath: this.#filePath,
      state: {
        activeEpisodeId: this.#active,
        handledAgentIds: this.#seenByAgent,
        pendingEpisodeIds: this.#deliveries,
      },
      onLedgerError: this.#reportFailure,
    });
  }
}

/** Construct the same delivery ledger for file-backed and in-memory hosts. */
export function createDiskPressureReminderEpisodes(options?: ReminderLedgerOptions): DiskPressureReminderEpisodes {
  return new PressureEpisodeLedger(options).publicApi();
}
