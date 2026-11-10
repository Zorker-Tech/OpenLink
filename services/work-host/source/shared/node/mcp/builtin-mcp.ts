import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { composeBoxComputerEnvironment } from "./box-computer-environment.ts"
import type { BoxComputerRuntimePlan, BoxComputerServerDefinition } from "./box-computer-runtime-contracts.ts"
import {
  LOCAL_DOCKER_SENTINEL,
  SLATE_BOX_COMPUTER_SERVER,
  SLATE_BOX_CONTAINER_DEFAULT,
  SLATE_BUILTIN_MCP_SERVERS,
  selectBoxComputerRuntime,
} from "./box-computer-runtime-policy.ts"

export {
  LOCAL_DOCKER_SENTINEL,
  LOCAL_DOCKER_SENTINEL as LOCAL_DOCKER_HOST_SENTINEL,
  SLATE_BOX_COMPUTER_SERVER,
  SLATE_BOX_COMPUTER_SERVER as BOX_COMPUTER_SERVER_NAME,
  SLATE_BOX_CONTAINER_DEFAULT,
  SLATE_BOX_CONTAINER_DEFAULT as DEFAULT_BOX_CONTAINER_NAME,
  SLATE_BUILTIN_MCP_SERVERS,
  SLATE_BUILTIN_MCP_SERVERS as BUILTIN_MCP_SERVER_NAMES,
  selectBoxComputerRuntime,
} from "./box-computer-runtime-policy.ts"
export { composeBoxComputerEnvironment } from "./box-computer-environment.ts"
export type { BoxComputerRuntimePlan as BoxComputerRuntime, BoxComputerServerDefinition as BuiltinSlateMcpServerConfig } from "./box-computer-runtime-contracts.ts"

export function locateBoxComputerBundle(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl = import.meta.url,
): string {
  const configuredPath = env.SLATE_BOX_COMPUTER_ENTRY?.trim()
  if (configuredPath) return configuredPath
  return resolve(dirname(fileURLToPath(moduleUrl)), "../../../projects/box-computer/dist/mcp.js")
}

export function availableBuiltinMcpServers(
  runtime: BoxComputerRuntimePlan = selectBoxComputerRuntime(false),
  entry = locateBoxComputerBundle(),
  exists: (path: string) => boolean = existsSync,
): Record<string, BoxComputerServerDefinition> {
  if (!exists(entry)) return {}

  const environment = composeBoxComputerEnvironment(runtime) as Record<string, string>
  return {
    [SLATE_BOX_COMPUTER_SERVER]: {
      type: "stdio",
      command: process.execPath,
      args: [entry],
      env: environment,
    },
  }
}

export const resolveBoxComputerRuntime = (opts: { readonly boxMcpActive: boolean }, env: NodeJS.ProcessEnv = process.env) =>
  selectBoxComputerRuntime(opts.boxMcpActive, env)
export const resolveBoxComputerEntry = locateBoxComputerBundle
export const buildBoxComputerEnv = composeBoxComputerEnvironment
export const getBuiltinMcpServers = availableBuiltinMcpServers
