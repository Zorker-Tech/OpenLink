/**
 * One policy from several, which is what makes a sandbox configurable at three levels at once.
 *
 * A command runs under a policy that a person, a repository and an organization each had a say in, and the three do not
 * override each other — they are merged, and the merge is deliberately conservative wherever the difference matters.
 * The policy type has to agree: three sources that disagree about whether the workspace may be written are not a policy
 * at all, and the conflict is reported rather than resolved by picking one. What may be written is the union of what
 * each source allowed, since a source that names a path is asking for it. What may be read outside the workspace is the
 * intersection, since a source that leaves a path out is confining the command. A boundary is the strictest one named,
 * and a boolean that tightens the sandbox is true if any source said so.
 *
 * A network policy is merged the same way: deny if anyone denied, and the union of the two lists, with the
 * organization's allowlist replacing whatever the others allowed, since it is the one that speaks for the whole
 * organization. Nothing named at all means no network policy, which is not the same as an empty one.
 *
 * Two things are not merged at all but taken from the highest-priority source that set them, because they are a choice
 * rather than a restriction: where the sandbox writes its debug output, and whether the shared build cache is used.
 *
 * A workspace that is a git worktree is the one case where the repository's own policy is extended: the common git
 * directory is added to what may be written, and the worktree's own protections are added to what may not, because a
 * worktree's git directory is not the repository's and a command that could rewrite the pointer between them would be
 * changing which working tree the repository is.
 */
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { spawnPromise } from "../../utils/process-spawn.ts";
import {
  getGitWriteProtectionMapping,
  getHardcodedSandboxPolicy,
  getWorktreeWriteProtectionMapping,
} from "./hardcoded-policy.ts";
import { getEffectiveNetworkPolicy } from "./network-policy-utils.ts";

type PolicyType = "workspace_readwrite" | "workspace_readonly" | "insecure_none";
type ReadBoundary = "workspace" | "system";
type IgnoreMapping = Record<string, readonly string[]>;
type NetworkPolicy = {
  version: 1;
  default?: "allow" | "deny" | undefined;
  allow?: readonly string[] | undefined;
  deny?: readonly string[] | undefined;
  logging?: unknown;
};
type PolicyRule = {
  type: PolicyType;
  disableTmpWrite?: boolean | undefined;
  networkPolicyStrict?: boolean | undefined;
  readBoundary?: ReadBoundary | undefined;
  additionalReadPaths?: readonly string[] | undefined;
  additionalReadwritePaths?: readonly string[] | undefined;
  additionalReadonlyPaths?: readonly string[] | undefined;
  networkPolicy?: NetworkPolicy | undefined;
  debugOutputDir?: string | undefined;
  captureDenies?: boolean | undefined;
  enableSharedBuildCache?: boolean | undefined;
  ignoreMapping?: IgnoreMapping | undefined;
  writeProtectionMapping?: IgnoreMapping | undefined;
  allowlistEscalated?: boolean | undefined;
};
type PolicySources = {
  perUser?: PolicyRule | undefined;
  perRepo?: PolicyRule | undefined;
  teamAdmin?: PolicyRule | undefined;
};
type MergeOptions = {
  workspaceDir?: string | undefined;
  gitDirParent?: string | undefined;
  debug?: boolean | undefined;
};
type ResolvedPolicy = { type: PolicyType; [key: string]: unknown };
type ResolveResult = {
  policy: ResolvedPolicy;
  debug?: { fieldSources: Record<string, string> } | undefined;
};

/** The sources of a policy, most specific first: the user's, the repository's, and the organization's. */
const SOURCE_NAMES = ["perUser", "perRepo", "teamAdmin", "hardcoded"] as const;

/** Each policy rule of a source set, in the order their priorities run. */
const rulesOf = (sources: PolicySources): Array<PolicyRule | undefined> => [sources.perUser, sources.perRepo, sources.teamAdmin];

/** A field picked from each policy rule, in the sources' priority order. */
const perSource = <T>(sources: PolicySources, pick: (rule: PolicyRule | undefined) => T): T[] => rulesOf(sources).map(pick);

export function getSandboxPolicyType(policy: PolicySources): PolicyType {
  return policy.teamAdmin?.type ?? policy.perRepo?.type ?? policy.perUser?.type ?? "insecure_none";
}

function mergeRestrictiveBoolean(...values: Array<boolean | undefined>): boolean {
  return values.some((value) => value === true);
}

/** Every path as the comparison writes it: a windows separator is a slash, and a root keeps its trailing one. */
function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized === "") return "/";
  return /^[a-zA-Z]:$/.test(normalized) ? `${normalized}/` : normalized;
}

/** The paths in the order they were first named, with the comparisons taken on their normalized form. */
function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    const normalized = normalizePath(path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(path);
  }
  return unique;
}

/** The paths every source named, normalized: a source that leaves one out is confining the command to what is left. */
function mergePathsIntersection(...sources: Array<readonly string[] | undefined>): string[] {
  const definedSources = sources.filter((source): source is readonly string[] => source !== undefined);
  if (definedSources.length === 0) return [];
  if (definedSources.some((source) => source.length === 0)) return [];
  const [first, ...rest] = definedSources.map((source) => new Set(uniquePaths(source).map(normalizePath)));
  const restSets = rest as Array<Set<string>>;
  return [...first!].filter((path) => restSets.every((sourceSet) => sourceSet.has(path)));
}

/** The paths any source named, normalized: a source that names one is asking for it. */
function mergePathsUnion(...sources: Array<readonly string[] | undefined>): string[] {
  const allPaths = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const path of source) allPaths.add(normalizePath(path));
  }
  return [...allPaths];
}

function rankedPolicyField<Value extends string>({ defaultValue, rank }: { defaultValue: Value; rank: Record<Value, number> }) {
  return {
    defaultValue,
    merge: (...sources: Array<Value | undefined>): Value => {
      const definedSources = sources.filter((source): source is Value => source !== undefined);
      if (definedSources.length === 0) return defaultValue;
      return definedSources.reduce((strictest, source) => rank[source] < rank[strictest] ? source : strictest);
    },
  };
}

function intersectingPathPolicyField() {
  return {
    defaultValue: [] as string[],
    merge: (...sources: Array<readonly string[] | undefined>): string[] => mergePathsIntersection(...sources),
  };
}

const readBoundaryPolicyField = rankedPolicyField<ReadBoundary>({
  defaultValue: "system",
  rank: {
    workspace: 0,
    system: 1,
  },
});

const additionalReadPathsPolicyField = intersectingPathPolicyField();

function mergeReadBoundary(...sources: Array<ReadBoundary | undefined>): ReadBoundary {
  return readBoundaryPolicyField.merge(...sources);
}

function mergeAdditionalReadPaths(...sources: Array<readonly string[] | undefined>): string[] {
  return additionalReadPathsPolicyField.merge(...sources);
}

function workspaceReadPathsSource(readBoundary: ReadBoundary | undefined, additionalReadPaths: readonly string[] | undefined): readonly string[] | undefined {
  return readBoundary === "workspace" ? additionalReadPaths : undefined;
}

/** The default of a network policy's type field, when no source said anything at all. */
const mergedNetworkDefault = (sources: readonly NetworkPolicy[]): "allow" | "deny" | undefined => {
  if (sources.some((source) => source.default === "deny")) return "deny";
  return sources.some((source) => source.default === "allow") ? "allow" : undefined;
};

/** Every pattern of one list across the sources, once. */
function mergedNetworkList(
  sources: readonly NetworkPolicy[],
  pick: (source: NetworkPolicy) => readonly string[] | undefined,
): string[] | undefined {
  const patterns = new Set<string>();
  for (const source of sources) {
    for (const pattern of pick(source) ?? []) patterns.add(pattern);
  }
  return patterns.size > 0 ? [...patterns] : undefined;
}

function mergeNetworkPolicies(...sources: Array<NetworkPolicy | undefined>): NetworkPolicy | undefined {
  const definedSources = sources.filter((source): source is NetworkPolicy => source !== undefined);
  if (definedSources.length === 0) return undefined;
  const merged: NetworkPolicy = { version: 1 };
  const mergedDefault = mergedNetworkDefault(definedSources);
  const mergedAllow = mergedNetworkList(definedSources, (source) => source.allow);
  const mergedDeny = mergedNetworkList(definedSources, (source) => source.deny);
  const mergedLogging = takeHighestPriorityDefined(...definedSources.map((source) => source.logging));
  if (mergedDefault !== undefined) merged.default = mergedDefault;
  if (mergedAllow !== undefined) merged.allow = mergedAllow;
  if (mergedDeny !== undefined) merged.deny = mergedDeny;
  if (mergedLogging !== undefined) merged.logging = mergedLogging;
  const named = merged.default !== undefined || merged.allow !== undefined || merged.deny !== undefined || merged.logging !== undefined;
  return named ? merged : undefined;
}

/** One path's patterns with a later source's added, the ones already there moved to the end rather than repeated. */
function mergePatternLists(existing: readonly string[], patterns: readonly string[]): string[] {
  const patternSet = new Set(existing);
  for (const pattern of patterns) {
    patternSet.delete(pattern);
    patternSet.add(pattern);
  }
  return [...patternSet];
}

function mergeIgnoreMappings(...sources: Array<IgnoreMapping | undefined>): Record<string, string[]> | undefined {
  const definedSources = sources.filter((source): source is IgnoreMapping => source !== undefined);
  if (definedSources.length === 0) return undefined;
  const merged: Record<string, string[]> = {};
  for (const source of definedSources) {
    for (const [path, patterns] of Object.entries(source)) {
      const existing = merged[path];
      merged[path] = existing ? mergePatternLists(existing, patterns) : [...patterns];
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** The value of the highest-priority source that set one, whether or not it is truthy. */
function takeHighestPriorityDefined<Value>(...sources: Array<Value | undefined>): Value | undefined {
  for (let index = sources.length - 1; index >= 0; index -= 1) {
    if (sources[index] !== undefined) return sources[index];
  }
  return undefined;
}

/** The index of the highest-priority source a predicate is true of, or undefined when it is true of none. */
function highestPriorityIndex(count: number, isSet: (index: number) => boolean): number | undefined {
  for (let index = count - 1; index >= 0; index -= 1) {
    if (isSet(index)) return index;
  }
  return undefined;
}

/** Whether the workspace is a git checkout, and whether it is a worktree whose git directory lives elsewhere. */
async function inspectWorkspaceGit(workspaceDir: string): Promise<{ isGitRepo: boolean; isWorktree: boolean }> {
  const dotGitStat = await stat(join(workspaceDir, ".git")).then((value) => value, () => null);
  return { isGitRepo: dotGitStat !== null, isWorktree: dotGitStat?.isFile() ?? false };
}

/** The repository's real git directory, for a worktree whose own one points at it. */
async function commonGitDirForWorktree(workspaceDir: string): Promise<string | undefined> {
  const commonDir = await spawnPromise("git", ["rev-parse", "--git-common-dir"], { cwd: workspaceDir }).then(
    (value) => resolve(workspaceDir, value.trim()),
    () => null,
  );
  return commonDir ?? undefined;
}

/** The repository's policy with a worktree's own git directory added to what may be written and protected. */
function extendPolicyForWorktree(sources: PolicySources, workspaceDir: string, commonDir: string): PolicySources {
  const perRepo = sources.perRepo;
  return {
    ...sources,
    perRepo: {
      ...perRepo,
      type: "workspace_readwrite",
      additionalReadwritePaths: [
        ...(perRepo?.additionalReadwritePaths ?? []),
        commonDir,
      ],
      ignoreMapping: perRepo?.ignoreMapping,
      writeProtectionMapping: mergeIgnoreMappings(
        perRepo?.writeProtectionMapping,
        getWorktreeWriteProtectionMapping(workspaceDir),
      ),
    },
  };
}

/** The policy a workspace's command runs under: its sources merged, with a worktree's git directory added when it has one. */
export async function resolveSandboxPolicyForWorkspace(workspaceDir: string, sources: PolicySources | undefined): Promise<ResolveResult> {
  if (!sources) return { policy: { type: "insecure_none" } };
  const { isGitRepo, isWorktree } = await inspectWorkspaceGit(workspaceDir);
  if (getSandboxPolicyType(sources) !== "workspace_readwrite") {
    return mergeSandboxPolicies(sources, { workspaceDir });
  }
  if (!isGitRepo) return mergeSandboxPolicies(sources, { workspaceDir });
  if (!isWorktree) return mergeSandboxPolicies(sources, { workspaceDir, gitDirParent: workspaceDir });
  const commonDir = await commonGitDirForWorktree(workspaceDir);
  if (commonDir === undefined) return mergeSandboxPolicies(sources, { workspaceDir });
  return mergeSandboxPolicies(extendPolicyForWorktree(sources, workspaceDir, commonDir), {
    workspaceDir,
    gitDirParent: dirname(commonDir),
  });
}

function validateAndGetPolicyType(sources: PolicySources): PolicyType | undefined {
  const definedPolicies = rulesOf(sources).filter((policy): policy is PolicyRule => policy !== undefined);
  if (definedPolicies.length === 0) return undefined;
  const firstType = definedPolicies[0]!.type;
  for (const policy of definedPolicies) {
    if (policy.type === firstType) continue;
    throw new Error(`Cannot merge policies of different types: found "${firstType}" and "${policy.type}". All policies must be of the same type (all workspace_readwrite, all workspace_readonly, or all insecure_none).`);
  }
  return firstType;
}

function mergeSandboxPolicies(sources: PolicySources, options: MergeOptions): ResolveResult {
  const policyType = validateAndGetPolicyType(sources);
  if (policyType === undefined) return mergeWorkspaceReadWritePolicies(sources, options);
  if (policyType === "workspace_readwrite") return mergeWorkspaceReadWritePolicies(sources, options);
  if (policyType === "workspace_readonly") return mergeWorkspaceReadOnlyPolicies(sources, options);
  if (policyType === "insecure_none") return mergeInsecureNonePolicies(sources, options);
  const exhaustive: never = policyType;
  throw new Error(`Unknown policy type: ${exhaustive}`);
}

/** One field's merged value for a policy that lives with the workspace. */
interface WorkspaceFieldValues {
  disableTmpWrite: boolean;
  networkPolicyStrict: boolean;
  readBoundary: ReadBoundary;
  additionalReadPaths: readonly string[] | undefined;
  additionalReadonlyPaths: readonly string[] | undefined;
  networkPolicy: ReturnType<typeof getEffectiveNetworkPolicy> | undefined;
  debugOutputDir: string | undefined;
  captureDenies: boolean;
  enableSharedBuildCache: boolean | undefined;
  ignoreMapping: Record<string, string[]> | undefined;
  writeProtectionMapping: Record<string, string[]> | undefined;
  fieldSources: Record<string, string>;
}

function mergeCommonWorkspaceFields(sources: PolicySources, options?: MergeOptions): WorkspaceFieldValues {
  const debug = options?.debug;
  const workspaceDir = options?.workspaceDir ?? process.cwd();
  const hardcoded = getHardcodedSandboxPolicy(workspaceDir) as ReturnType<typeof getHardcodedSandboxPolicy> & {
    networkPolicy?: NetworkPolicy | undefined;
    ignoreMapping?: IgnoreMapping | undefined;
  };
  const fieldSources: Record<string, string> = {};
  const sourcesByPriority = rulesOf(sources);
  const recordSource = (field: string, sourceIndex: number): void => {
    if (!debug) return;
    fieldSources[field] = SOURCE_NAMES[sourceIndex] ?? "unknown";
  };
  const disableTmpWrite = mergeRestrictiveBoolean(...perSource(sources, (rule) => rule?.disableTmpWrite));
  const tmpWriteSource = highestPriorityIndex(sourcesByPriority.length, (index) => sourcesByPriority[index]?.disableTmpWrite === true);
  if (tmpWriteSource !== undefined) recordSource("disableTmpWrite", tmpWriteSource);
  const networkPolicyStrict = mergeRestrictiveBoolean(
    ...perSource(sources, (rule) => rule?.networkPolicyStrict),
    hardcoded.networkPolicyStrict,
  );
  if (hardcoded.networkPolicyStrict) recordSource("networkPolicyStrict", 3);
  const readBoundary = mergeReadBoundary(...perSource(sources, (rule) => rule?.readBoundary));
  const additionalReadPaths = mergeAdditionalReadPaths(
    ...perSource(sources, (rule) => workspaceReadPathsSource(rule?.readBoundary, rule?.additionalReadPaths)),
  );
  const mergedReadPaths = readBoundary === "workspace" ? additionalReadPaths : undefined;
  const additionalReadonlyPaths = mergePathsUnion(
    ...perSource(sources, (rule) => rule?.additionalReadonlyPaths),
    hardcoded.additionalReadonlyPaths,
  );
  let mergedNetworkPolicy = mergeNetworkPolicies(
    ...perSource(sources, (rule) => rule?.networkPolicy),
    hardcoded.networkPolicy,
  );
  const teamAdminAllow = sources.teamAdmin?.networkPolicy?.allow;
  if (teamAdminAllow !== undefined && teamAdminAllow.length > 0 && mergedNetworkPolicy !== undefined) {
    mergedNetworkPolicy = { ...mergedNetworkPolicy, allow: [...teamAdminAllow] };
    recordSource("networkPolicy.allow", 2);
    if (debug) fieldSources["networkPolicy.allow"] = "teamAdmin (replace)";
  }
  const gitDirParent = options?.gitDirParent ?? workspaceDir;
  return {
    disableTmpWrite,
    networkPolicyStrict,
    readBoundary,
    additionalReadPaths: mergedReadPaths,
    additionalReadonlyPaths: additionalReadonlyPaths.length > 0 ? additionalReadonlyPaths : undefined,
    networkPolicy: getEffectiveNetworkPolicy(mergedNetworkPolicy as Parameters<typeof getEffectiveNetworkPolicy>[0]),
    debugOutputDir: takeHighestPriorityDefined(...perSource(sources, (rule) => rule?.debugOutputDir)),
    captureDenies: mergeRestrictiveBoolean(...perSource(sources, (rule) => rule?.captureDenies)),
    enableSharedBuildCache: takeHighestPriorityDefined(...perSource(sources, (rule) => rule?.enableSharedBuildCache)),
    ignoreMapping: mergeIgnoreMappings(...perSource(sources, (rule) => rule?.ignoreMapping), hardcoded.ignoreMapping),
    writeProtectionMapping: mergeIgnoreMappings(
      ...perSource(sources, (rule) => rule?.writeProtectionMapping),
      hardcoded.writeProtectionMapping,
      getGitWriteProtectionMapping(gitDirParent),
    ),
    fieldSources,
  };
}

function cleanPolicy(policy: Record<string, unknown>, type: PolicyType): ResolvedPolicy {
  const clean = Object.fromEntries(Object.entries(policy).filter(([, value]) => value !== undefined));
  clean.type = type;
  return clean as ResolvedPolicy;
}

/** A clean policy of this type, with its field sources when the caller asked to see them. */
function resolvedPolicyOf(policy: Record<string, unknown>, type: PolicyType, debug: boolean | undefined, fieldSources: Record<string, string>): ResolveResult {
  const result: ResolveResult = { policy: cleanPolicy(policy, type) };
  if (debug) result.debug = { fieldSources };
  return result;
}

function mergeWorkspaceReadWritePolicies(sources: PolicySources, options?: MergeOptions): ResolveResult {
  const debug = options?.debug;
  const common = mergeCommonWorkspaceFields(sources, options);
  const additionalReadwritePaths = mergePathsUnion(...perSource(sources, (rule) => rule?.additionalReadwritePaths));
  const policy = {
    type: "workspace_readwrite",
    disableTmpWrite: common.disableTmpWrite || undefined,
    networkPolicyStrict: common.networkPolicyStrict,
    readBoundary: common.readBoundary,
    additionalReadPaths: common.additionalReadPaths,
    additionalReadwritePaths: additionalReadwritePaths.length > 0 ? additionalReadwritePaths : undefined,
    additionalReadonlyPaths: common.additionalReadonlyPaths,
    networkPolicy: common.networkPolicy,
    debugOutputDir: common.debugOutputDir,
    captureDenies: common.captureDenies || undefined,
    enableSharedBuildCache: common.enableSharedBuildCache,
    ignoreMapping: common.ignoreMapping,
    writeProtectionMapping: common.writeProtectionMapping,
  };
  return resolvedPolicyOf(policy, "workspace_readwrite", debug, common.fieldSources);
}

function mergeWorkspaceReadOnlyPolicies(sources: PolicySources, options?: MergeOptions): ResolveResult {
  const debug = options?.debug;
  const common = mergeCommonWorkspaceFields(sources, options);
  const policy = {
    type: "workspace_readonly",
    disableTmpWrite: common.disableTmpWrite || undefined,
    networkPolicyStrict: common.networkPolicyStrict,
    readBoundary: common.readBoundary,
    additionalReadPaths: common.additionalReadPaths,
    additionalReadonlyPaths: common.additionalReadonlyPaths,
    networkPolicy: common.networkPolicy,
    debugOutputDir: common.debugOutputDir,
    captureDenies: common.captureDenies || undefined,
    enableSharedBuildCache: common.enableSharedBuildCache,
    ignoreMapping: common.ignoreMapping,
    writeProtectionMapping: common.writeProtectionMapping,
  };
  return resolvedPolicyOf(policy, "workspace_readonly", debug, common.fieldSources);
}

function mergeInsecureNonePolicies(sources: PolicySources, options?: MergeOptions): ResolveResult {
  const debug = options?.debug;
  const policy = {
    type: "insecure_none",
    allowlistEscalated: mergeRestrictiveBoolean(...perSource(sources, (rule) => rule?.allowlistEscalated)) || undefined,
    debugOutputDir: takeHighestPriorityDefined(...perSource(sources, (rule) => rule?.debugOutputDir)),
    captureDenies: mergeRestrictiveBoolean(...perSource(sources, (rule) => rule?.captureDenies)) || undefined,
    enableSharedBuildCache: takeHighestPriorityDefined(...perSource(sources, (rule) => rule?.enableSharedBuildCache)),
  };
  return resolvedPolicyOf(policy, "insecure_none", debug, {});
}
