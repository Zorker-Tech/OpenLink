/**
 * The order in which a surface is replicated.
 *
 * Every write is stamped with the epoch of the writer and the sequence it is at, so a reader can tell what it already
 * has and what came before it, and a snapshot carries the coverage it was taken with.
 */
import { randomUUID } from "node:crypto";

export interface WriteStamp {
  replicaKey: string;
  epoch: string;
  sequence: number;
}

export interface ReplicaView<T, C = string> {
  replicaKey: string;
  epoch: string;
  throughSequence: number;
  coverage: C;
  value: T;
}

/**
 * The ordering authority for every independently replicated surface in this process.
 *
 * A sequence belongs to a surface, not to the process: two surfaces replicated at the same time count separately, and
 * the epoch is what tells a reader that a different process is writing now.
 */
export class HostReplicaWriter {
  readonly #epoch: string;
  readonly #counters = new Map<string, number>();

  constructor(epoch = randomUUID()) {
    this.#epoch = epoch;
  }

  get processEpoch(): string {
    return this.#epoch;
  }

  /** The sequence a surface is at, without moving it. */
  sequenceOf(replicaKey: string): number {
    return this.#counters.get(replicaKey) ?? 0;
  }

  /** The next sequence for a surface: reserved before the content it describes is read. */
  nextStamp(replicaKey: string): WriteStamp {
    const sequence = this.sequenceOf(replicaKey) + 1;
    this.#counters.set(replicaKey, sequence);
    return { replicaKey, epoch: this.#epoch, sequence };
  }

  /**
   * What this surface looked like when it was read: the sequence it had reached, and the coverage it was read with.
   *
   * Taken without reserving a sequence — a snapshot describes a position, it does not take one.
   */
  viewOf<T, C = string>(replicaKey: string, coverage: C, value: T): ReplicaView<T, C> {
    return { replicaKey, epoch: this.#epoch, throughSequence: this.sequenceOf(replicaKey), coverage, value };
  }
}
