/** Deterministic pack retention, retirement and rebuilding from current manifests. */
import type { PackEntry, PackIndex } from "./box-store-pack-index.ts";

interface PackCandidate {
  sha: string;
  size: number;
  copiedFromRetired: boolean;
}

export interface PackMaintenancePlan {
  keptPacks: PackEntry[];
  retiredPackIds: string[];
  newPacks: Array<Array<{ sha: string; size: number; vmtime: number }>>;
  deferredMembers: number;
  newMaxVmtime: number;
}

function orderByDigest<T extends { sha: string }>(items: T[]): T[] {
  return items.sort((left, right) => left.sha < right.sha ? -1 : left.sha > right.sha ? 1 : 0);
}

function retainWholePacks(args: {
  packs: readonly PackEntry[];
  live: ReadonlyMap<string, number>;
}): { kept: PackEntry[]; retired: string[]; carryForward: PackCandidate[]; retainedDigests: Set<string>; maxVmtime: number } {
  const kept: PackEntry[] = [];
  const retired: string[] = [];
  const carryForward: PackCandidate[] = [];
  const retainedDigests = new Set<string>();
  let maxVmtime = 0;

  for (const candidate of args.packs) {
    const packIsWhole = candidate.members.length > 0
      && candidate.members.every(member => args.live.get(member.sha) === member.size);
    if (packIsWhole) {
      kept.push(candidate);
      for (const item of candidate.members) {
        retainedDigests.add(item.sha);
        maxVmtime = Math.max(maxVmtime, item.vmtime);
      }
      continue;
    }

    retired.push(candidate.id);
    for (const item of candidate.members) {
      if (args.live.get(item.sha) === item.size) carryForward.push({ sha: item.sha, size: item.size, copiedFromRetired: true });
    }
  }
  return { kept, retired, carryForward, retainedDigests, maxVmtime };
}

function candidatesForPlan(args: {
  livePack: ReturnType<typeof retainWholePacks>;
  eligible: ReadonlyMap<string, number>;
}): PackCandidate[] {
  const carriedDigests = new Set(args.livePack.carryForward.map(item => item.sha));
  const newlyEligible: PackCandidate[] = [];
  for (const [sha, size] of args.eligible) {
    if (args.livePack.retainedDigests.has(sha) || carriedDigests.has(sha)) continue;
    newlyEligible.push({ sha, size, copiedFromRetired: false });
  }
  return [...orderByDigest(args.livePack.carryForward), ...orderByDigest(newlyEligible)];
}

function packWithinSizeLimit(candidates: readonly PackCandidate[], maxBytes: number): PackCandidate[][] {
  const result: PackCandidate[][] = [];
  let current: PackCandidate[] = [];
  let bytesUsed = 0;
  for (const candidate of candidates) {
    if (current.length > 0 && bytesUsed + candidate.size > maxBytes) {
      result.push(current);
      current = [];
      bytesUsed = 0;
    }
    current.push(candidate);
    bytesUsed += candidate.size;
  }
  if (current.length > 0) result.push(current);
  return result;
}

export function planPackMaintenance(input: {
  index: PackIndex | null;
  live: ReadonlyMap<string, number>;
  eligible: ReadonlyMap<string, number>;
  maxPackMemberSizeSum: number;
  minPackMembers: number;
  minPackBytes: number;
}): PackMaintenancePlan {
  const livePack = retainWholePacks({ packs: input.index?.packs ?? [], live: input.live });
  const batches = packWithinSizeLimit(candidatesForPlan({ livePack, eligible: input.eligible }), input.maxPackMemberSizeSum);
  let deferredMembers = 0;
  const finalBatch = batches.at(-1);
  const finalBatchBytes = finalBatch?.reduce((sum, item) => sum + item.size, 0) ?? 0;
  if (finalBatch !== undefined && finalBatch.length < input.minPackMembers && finalBatchBytes < input.minPackBytes) {
    deferredMembers = finalBatch.length;
    batches.pop();
  }

  let nextVmtime = Math.max(input.index?.maxVmtime ?? 0, livePack.maxVmtime);
  const newPacks = batches.map(batch => batch.map(item => ({
    sha: item.sha,
    size: item.size,
    vmtime: item.copiedFromRetired ? livePack.maxVmtime : ++nextVmtime,
  })));
  return {
    keptPacks: livePack.kept,
    retiredPackIds: livePack.retired,
    newPacks,
    deferredMembers,
    newMaxVmtime: Math.max(nextVmtime, livePack.maxVmtime, input.index?.maxVmtime ?? 0),
  };
}

export function isBoxStorePackBuildEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const setting = env.SLATE_BOX_STORE_PACKS?.trim().toLowerCase();
  return setting !== "0" && setting !== "false" && setting !== "no";
}
