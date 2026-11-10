import type { BoxComputerRuntimePlan } from "./box-computer-runtime-contracts.ts"

export const SLATE_BOX_COMPUTER_SERVER = "slate-box-computer"
export const SLATE_BUILTIN_MCP_SERVERS = new Set([SLATE_BOX_COMPUTER_SERVER])
export const SLATE_BOX_CONTAINER_DEFAULT = "slate-box-shared"
export const LOCAL_DOCKER_SENTINEL = "local"

function flagIsOn(value: string | undefined): boolean {
  return ["1", "true"].includes(value?.trim().toLowerCase() ?? "")
}

export function selectBoxComputerRuntime(
  boxMcpActive: boolean,
  env: NodeJS.ProcessEnv = process.env,
): BoxComputerRuntimePlan {
  const remoteHost = env.SLATE_BOX_COMPUTER_DOCKER_HOST?.trim()
  const requestedContainer = env.SLATE_BOX_COMPUTER_SHARED_CONTAINER?.trim()

  return {
    shared: flagIsOn(env.SLATE_BOX_COMPUTER_SHARED_DOCKER) || boxMcpActive,
    containerName: requestedContainer || SLATE_BOX_CONTAINER_DEFAULT,
    dockerHost: remoteHost && remoteHost.toLowerCase() !== LOCAL_DOCKER_SENTINEL ? remoteHost : undefined,
    dockerPath: "docker",
  }
}
