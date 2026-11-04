import type { SandboxPolicy } from "./shell-core-contracts.ts";

interface SharedStorePath {
  readonly path: string;
  readonly readOnly: boolean;
}

function requestEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name] ?? process.env[name];
}

function uniquePathList(current: string[] | undefined, candidate: string): string[] {
  const paths = current === undefined ? [] : [...current];
  if (!paths.includes(candidate)) paths.push(candidate);
  return paths;
}

function sharedStorePaths(rawValue: string | undefined): SharedStorePath[] {
  if (rawValue === undefined) return [];

  try {
    const decoded: unknown = JSON.parse(rawValue);
    if (typeof decoded !== "object" || decoded === null) return [];

    const paths: SharedStorePath[] = [];
    for (const candidate of Object.values(decoded)) {
      if (typeof candidate !== "object" || candidate === null) continue;
      if (!("path" in candidate) || !("readOnly" in candidate)) continue;
      if (typeof candidate.path !== "string" || typeof candidate.readOnly !== "boolean") continue;
      paths.push({ path: candidate.path, readOnly: candidate.readOnly });
    }
    return paths;
  } catch {
    return [];
  }
}

/** Add the agent store's paths to a per-user workspace rule without mutating the caller's policy. */
export function addAgentStorePathsToPolicy(policy: SandboxPolicy | undefined, env: NodeJS.ProcessEnv): SandboxPolicy | undefined {
  const filesDirectory = requestEnvironmentValue(env, "SLATE_AGENT_STORE_FILES_DIR");
  const sharedPaths = sharedStorePaths(requestEnvironmentValue(env, "SLATE_AGENT_STORE_SHARED_PATHS"));
  if (filesDirectory === undefined && sharedPaths.length === 0) return policy;

  const governingRule = policy?.perRepo ?? policy?.perUser ?? policy?.teamAdmin;
  if (governingRule?.type !== "workspace_readwrite" && governingRule?.type !== "workspace_readonly") return policy;

  const widenedRule = {
    type: governingRule.type,
    ...(policy?.perUser?.additionalReadwritePaths === undefined
      ? {}
      : { additionalReadwritePaths: [...policy.perUser.additionalReadwritePaths] }),
    ...(policy?.perUser?.additionalReadonlyPaths === undefined
      ? {}
      : { additionalReadonlyPaths: [...policy.perUser.additionalReadonlyPaths] }),
  };
  const addPath = (path: string, readOnly: boolean): void => {
    if (!readOnly && widenedRule.type === "workspace_readwrite") {
      widenedRule.additionalReadwritePaths = uniquePathList(widenedRule.additionalReadwritePaths, path);
    } else {
      widenedRule.additionalReadonlyPaths = uniquePathList(widenedRule.additionalReadonlyPaths, path);
    }
  };

  if (filesDirectory !== undefined) addPath(filesDirectory, false);
  for (const sharedPath of sharedPaths) addPath(sharedPath.path, sharedPath.readOnly);
  return { ...policy, perUser: widenedRule };
}
