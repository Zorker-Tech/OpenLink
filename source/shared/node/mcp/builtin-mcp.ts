/**
 * The MCP servers the platform ships.
 *
 * They live beside the host bundle, and one that is not there is simply not offered — a build without it is a build
 * without that server rather than a broken listing.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { McpServerConfig } from "./mcp-display-runtime.ts";

export const BOX_COMPUTER_SERVER_NAME = "slate-box-computer";
export const BUILTIN_MCP_SERVER_NAMES = new Set([BOX_COMPUTER_SERVER_NAME]);
export const DEFAULT_BOX_CONTAINER_NAME = "slate-box-shared";
export const LOCAL_DOCKER_HOST_SENTINEL = "local";

export interface BoxComputerRuntime {
  readonly shared: boolean;
  readonly containerName: string;
  readonly dockerHost: string | undefined;
  readonly dockerPath: "docker";
}

export type BuiltinMcpServerConfig = Extract<McpServerConfig, { command: string }> & { readonly type: "stdio" };

function isTruthyFlag(value: string | undefined): boolean {
  const flag = value?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}

export function resolveBoxComputerRuntime(
  opts: { readonly boxMcpActive: boolean },
  env: NodeJS.ProcessEnv = process.env,
): BoxComputerRuntime {
  const explicitShared = isTruthyFlag(env.SLATE_BOX_COMPUTER_SHARED_DOCKER);
  const hostOverrideRaw = env.SLATE_BOX_COMPUTER_DOCKER_HOST?.trim();
  const dockerHost = hostOverrideRaw != null
    && hostOverrideRaw.length > 0
    && hostOverrideRaw.toLowerCase() !== LOCAL_DOCKER_HOST_SENTINEL
    ? hostOverrideRaw
    : undefined;
  const containerNameOverride = env.SLATE_BOX_COMPUTER_SHARED_CONTAINER?.trim();
  const containerName = containerNameOverride != null && containerNameOverride.length > 0
    ? containerNameOverride
    : DEFAULT_BOX_CONTAINER_NAME;
  return {
    shared: explicitShared || opts.boxMcpActive,
    containerName,
    dockerHost,
    dockerPath: "docker",
  };
}

export function resolveBoxComputerEntry(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl = import.meta.url,
): string {
  const override = env.SLATE_BOX_COMPUTER_ENTRY?.trim();
  if (override != null && override.length > 0) return override;
  return resolve(dirname(fileURLToPath(moduleUrl)), "../../../projects/box-computer/dist/mcp.js");
}

export function buildBoxComputerEnv(
  runtime: BoxComputerRuntime,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string") env[key] = value;
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  env.SLATE_BOX_COMPUTER = "1";
  if (runtime.shared) {
    env.BOX_COMPUTER_BACKEND = "shared-docker";
    env.BOX_COMPUTER_SHARED_CONTAINER_NAME = runtime.containerName;
    if (runtime.dockerHost != null) env.DOCKER_HOST = runtime.dockerHost;
    else delete env.DOCKER_HOST;
  }
  return env;
}

export function getBuiltinMcpServers(
  runtime = resolveBoxComputerRuntime({ boxMcpActive: false }),
  entry = resolveBoxComputerEntry(),
  exists: (path: string) => boolean = existsSync,
): Record<string, BuiltinMcpServerConfig> {
  if (!exists(entry)) return {};
  return {
    [BOX_COMPUTER_SERVER_NAME]: {
      type: "stdio",
      command: process.execPath,
      args: [entry],
      env: buildBoxComputerEnv(runtime) as Record<string, string>,
    },
  };
}
