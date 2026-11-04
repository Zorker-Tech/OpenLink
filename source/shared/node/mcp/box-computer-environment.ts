import type { BoxComputerRuntimePlan } from "./box-computer-runtime-contracts.ts"

export function composeBoxComputerEnvironment(
  runtime: BoxComputerRuntimePlan,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result = Object.fromEntries(
    Object.entries(inherited).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  ) as NodeJS.ProcessEnv

  result.ELECTRON_RUN_AS_NODE = "1"
  result.SLATE_BOX_COMPUTER = "1"

  if (runtime.shared) {
    result.BOX_COMPUTER_BACKEND = "shared-docker"
    result.BOX_COMPUTER_SHARED_CONTAINER_NAME = runtime.containerName
    if (runtime.dockerHost === undefined) delete result.DOCKER_HOST
    else result.DOCKER_HOST = runtime.dockerHost
  }

  return result
}
