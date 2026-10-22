/**
 * Noticing that the disk a box's store lives on is filling up.
 *
 * Two levels are watched: a soft one that warns while there is still room to act, and a hard one that has to be
 * recovered from before the level is cleared — the recovery thresholds sit above the entry ones so the level does not
 * oscillate around a single boundary.
 */
import { stat, statfs } from "node:fs/promises";

export const GIB = 1024 ** 3;
export const DISK_PRESSURE_HEARTBEAT_MS = 5 * 60_000;

export const DISK_PRESSURE_THRESHOLDS = {
  softAvailableBytes: 8 * GIB,
  softAvailableRatio: 0.15,
  hardAvailableBytes: 2 * GIB,
  hardAvailableRatio: 0.05,
  softRecoveryBytes: 10 * GIB,
  softRecoveryRatio: 0.2,
  hardRecoveryBytes: 3 * GIB,
  hardRecoveryRatio: 0.08,
} as const;

export type PressureLevel = "healthy" | "soft" | "hard";

export interface VolumeReading {
  readonly volume: string;
  readonly deviceId: string;
  readonly totalBytes: number;
  readonly availableBytes: number;
}

export interface VolumeSample {
  readonly snapshots: readonly VolumeReading[];
  readonly complete: boolean;
}

interface DiskPressureState {
  readonly level: PressureLevel;
  readonly lastReportedAtMs: number;
}

/** Whether a volume is at or below this many bytes, or this share of itself. */
function atOrBelow(snapshot: Pick<VolumeReading, "totalBytes" | "availableBytes">, bytes: number, ratio: number): boolean {
  return snapshot.availableBytes <= bytes || snapshot.availableBytes / snapshot.totalBytes <= ratio;
}

/** The worst level any of these volumes is at: a hard volume makes the box hard, and so on. */
export function worstLevel(states: ReadonlyMap<string, DiskPressureState>): PressureLevel {
  const levels = [...states.values()].map((state) => state.level);
  if (levels.includes("hard")) return "hard";
  return levels.includes("soft") ? "soft" : "healthy";
}

/**
 * The level one volume is at now, given the level it was at last time.
 *
 * The entry thresholds decide when a level starts, and the recovery ones — higher, so the level cannot oscillate around
 * a single boundary — decide when it ends. A volume this build cannot measure reads as healthy rather than as full.
 */
export function levelOfVolume(snapshot: Pick<VolumeReading, "totalBytes" | "availableBytes">, previous: PressureLevel = "healthy"): PressureLevel {
  if (snapshot.totalBytes <= 0) return "healthy";
  const thresholds = DISK_PRESSURE_THRESHOLDS;
  if (atOrBelow(snapshot, thresholds.hardAvailableBytes, thresholds.hardAvailableRatio)) return "hard";
  if (previous === "hard" && atOrBelow(snapshot, thresholds.hardRecoveryBytes, thresholds.hardRecoveryRatio)) return "hard";
  if (atOrBelow(snapshot, thresholds.softAvailableBytes, thresholds.softAvailableRatio)) return "soft";
  if (previous === "soft" && atOrBelow(snapshot, thresholds.softRecoveryBytes, thresholds.softRecoveryRatio)) return "soft";
  return "healthy";
}

/** One volume's reading, taken from the platform: what it is, where it is, and how much room is left. */
async function readVolume(root: { readonly volume: string; readonly path: string }): Promise<VolumeReading> {
  const [pathStat, fileSystem] = await Promise.all([stat(root.path, { bigint: true }), statfs(root.path, { bigint: true })]);
  return {
    volume: root.volume,
    deviceId: String(pathStat.dev),
    totalBytes: Number(fileSystem.blocks * fileSystem.bsize),
    availableBytes: Number(fileSystem.bavail * fileSystem.bsize),
  };
}

/**
 * What the platform says about these volumes, once each — two roots on one device are one volume — and whether every
 * one of them could be read at all.
 */
export async function sampleVolumes(roots: readonly { readonly volume: string; readonly path: string }[]): Promise<VolumeSample> {
  const snapshots: VolumeReading[] = [];
  const seenDevices = new Set<string>();
  let complete = true;
  for (const root of roots) {
    try {
      const snapshot = await readVolume(root);
      if (seenDevices.has(snapshot.deviceId)) continue;
      seenDevices.add(snapshot.deviceId);
      snapshots.push(snapshot);
    } catch {
      complete = false;
    }
  }
  return { snapshots, complete };
}

export interface DiskPressureReport extends VolumeReading {
  readonly level: PressureLevel;
  readonly trigger: "transition" | "heartbeat";
  readonly usedPercent: number;
}

export interface DiskPressureGuard {
  onTick(): void;
  dispose(): void;
}

/** How full a volume is, as the percentage a report carries. */
function usedPercentOf(snapshot: Pick<VolumeReading, "totalBytes" | "availableBytes">): number {
  return snapshot.totalBytes > 0 ? ((snapshot.totalBytes - snapshot.availableBytes) / snapshot.totalBytes) * 100 : 0;
}

/**
 * Watches the box's disks, one tick at a time.
 *
 * A tick reads every volume, decides each one's level against the level it had, and reports what changed — a volume that
 * changed level, or one that is still under pressure and has not been reported for a heartbeat. A volume that is no
 * longer there is forgotten, but only when the reading was complete: a failed read is not a disk that went away.
 */
export function diskPressureGuard(options: {
  readonly readVolumes: () => Promise<VolumeSample>;
  readonly report: (report: DiskPressureReport) => void;
  readonly onPressureChange: (level: "soft" | "hard" | null) => void;
  readonly onSuccessfulSample?: (level: PressureLevel, complete: boolean) => void;
  readonly log: (message: string) => void;
  readonly clock?: { monotonicNow(): number };
}): DiskPressureGuard {
  const clock = options.clock ?? { monotonicNow: () => performance.now() };
  const states = new Map<string, DiskPressureState>();
  let aggregate: PressureLevel = "healthy";
  let inFlight = false;
  let disposed = false;

  /** Reports one volume if it changed level or its heartbeat is due, and keeps what the next tick compares against. */
  const visit = (snapshot: VolumeReading, checkedAtMs: number): void => {
    const previous = states.get(snapshot.deviceId);
    const level = levelOfVolume(snapshot, previous?.level);
    const transitioned = level !== (previous?.level ?? "healthy");
    const heartbeatDue = level !== "healthy" && checkedAtMs - (previous?.lastReportedAtMs ?? Number.NEGATIVE_INFINITY) >= DISK_PRESSURE_HEARTBEAT_MS;
    const shouldReport = transitioned || heartbeatDue;
    states.set(snapshot.deviceId, { level, lastReportedAtMs: shouldReport ? checkedAtMs : (previous?.lastReportedAtMs ?? checkedAtMs) });
    if (!shouldReport) return;
    try {
      options.report({ ...snapshot, level, trigger: transitioned ? "transition" : "heartbeat", usedPercent: usedPercentOf(snapshot) });
    } catch (error) {
      // A report the host could not take is logged and the tick goes on: the next heartbeat will try again.
      options.log(`disk-pressure report delivery failed: ${String(error)}`);
    }
  };

  const check = async (): Promise<void> => {
    const checkedAtMs = clock.monotonicNow();
    let sample: VolumeSample;
    try {
      sample = await options.readVolumes();
    } catch (error) {
      options.log(`disk-pressure sample failed: ${String(error)}`);
      return;
    }
    const sampled = new Set<string>();
    for (const snapshot of sample.snapshots) {
      if (disposed) return;
      sampled.add(snapshot.deviceId);
      visit(snapshot, checkedAtMs);
    }
    if (sample.complete) {
      for (const deviceId of states.keys()) if (!sampled.has(deviceId)) states.delete(deviceId);
    }
    const next = worstLevel(states);
    if (sample.complete || sample.snapshots.length > 0) options.onSuccessfulSample?.(next, sample.complete);
    if (next === aggregate) return;
    aggregate = next;
    options.onPressureChange(next === "healthy" ? null : next);
  };

  return {
    onTick: () => {
      // One tick at a time: a reading that is still running is not started again.
      if (disposed || inFlight) return;
      inFlight = true;
      void check().finally(() => {
        inFlight = false;
      });
    },
    dispose: () => {
      disposed = true;
    },
  };
}
