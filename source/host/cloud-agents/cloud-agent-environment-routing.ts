import { SlateCloudAgentLaunchError } from "./cloud-agent-launch-error.ts";
import type { CloudAgentEnvironment } from "./cloud-agent-request-contracts.ts";
import { sanitizeRemoteUrl } from "./cloud-agent-repository.ts";

export const PRIVATE_WORKER_SHARED_ASSIGNMENT_ALLOWED_LABEL_KEY = "slate.private_worker.shared_assignment_allowed";

function repositoryRoutingLabel(repositoryUrl: string): string {
  const value = sanitizeRemoteUrl(repositoryUrl);
  if (value.length === 0) throw new SlateCloudAgentLaunchError(`Slate could not derive private-worker routing labels from '${repositoryUrl}'.`);
  return value;
}

export function resolveCloudAgentEnvironmentFields(repoUrl: string, environment?: CloudAgentEnvironment) {
  if (environment == null || environment.type === "cloud" || environment.type === "environment") return {};
  if (environment.type === "pool") {
    const labels: Array<{ key: string; value: string }> = [{ key: "repo", value: repositoryRoutingLabel(repoUrl) }];
    const poolName = environment.name?.trim();
    if (poolName) labels.push({ key: "pool", value: poolName });
    return { usePrivateWorker: true, labels };
  }

  const machineName = environment.name.trim();
  if (machineName.length === 0) throw new SlateCloudAgentLaunchError("A private-worker machine environment requires a registered name.");
  return {
    usePrivateWorker: true,
    labels: [
      { key: "name", value: machineName },
      { key: PRIVATE_WORKER_SHARED_ASSIGNMENT_ALLOWED_LABEL_KEY, value: "true" },
    ],
  };
}
