import { SlateCloudAgentLaunchError } from "./cloud-agent-launch-error.ts";
import type { SavedEnvironment } from "./cloud-agent-request-contracts.ts";
import { normalizeRepoReference, sanitizeRemoteUrl } from "./cloud-agent-repository.ts";

function environmentLabel(environment: SavedEnvironment): string {
  return environment.name.trim() || environment.publicId;
}

function canonicalRepoKey(value: string): string {
  return sanitizeRemoteUrl(normalizeRepoReference(value));
}

export function resolveLaunchRepoReference(repoUrl: string | undefined, savedEnvironment?: SavedEnvironment): string {
  const requested = repoUrl?.trim() ?? "";
  if (savedEnvironment == null) {
    if (requested.length === 0) throw new SlateCloudAgentLaunchError("'repo_url' is required to launch a cloud agent.");
    return requested;
  }

  const label = environmentLabel(savedEnvironment);
  const repositories = savedEnvironment.repoConfig?.repos ?? [];
  const primaryRepo = repositories[0]?.repoUrl.trim() ?? "";
  if (primaryRepo.length === 0) {
    if (requested.length === 0) {
      throw new SlateCloudAgentLaunchError(`The '${label}' environment has no repositories configured, so pass repo_url to pick the repo to launch on.`);
    }
    return requested;
  }

  if (requested.length === 0 || canonicalRepoKey(requested) === canonicalRepoKey(primaryRepo)) return primaryRepo;
  const isSecondary = repositories.slice(1).some((repository) => canonicalRepoKey(repository.repoUrl) === canonicalRepoKey(requested));
  if (isSecondary) {
    throw new SlateCloudAgentLaunchError(`'${requested}' is a secondary repo of the '${label}' environment; the launch's branch/PR lands on its primary repo '${primaryRepo}'. Omit repo_url to use it.`);
  }
  const available = repositories.map((repository) => repository.repoUrl).join(", ");
  throw new SlateCloudAgentLaunchError(`'${requested}' is not part of the '${label}' environment (repos: ${available}). Omit repo_url to use its primary repo, or pick a different environment.`);
}

export function toStartRepoConfig(config?: SavedEnvironment["repoConfig"]) {
  if (config == null || config.repos.length === 0) return undefined;
  return {
    repos: config.repos.map(({ repoUrl, scmRepoNodeId, gitEnterpriseUuid }) => ({
      repoUrl,
      ...(scmRepoNodeId === undefined ? {} : { scmRepoNodeId }),
      ...(gitEnterpriseUuid === undefined ? {} : { gitEnterpriseUuid }),
    })),
  };
}
