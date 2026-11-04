/** Decide which task delegates this run can offer. */

import {
  slateSubagentTypeName,
  type SlateSubagentTypeLike,
} from "../../packages/agent/subagent-type.ts"
import { createSlateBrowserUseSubagentConfig } from "./tools/slate-browser-use-subagent.ts"
import { createSlateComputerUseSubagentConfig } from "./tools/slate-computer-use-subagent.ts"
import { createSlateExecutorSubagentDefinition } from "../slate-multitask.ts"
import { encodeSlateExecutorSubagentConfig } from "../../adapters/interop/agent/multitask-subagent-config-adapter.ts"

export interface TurnSubagentConfigHost {
  readonly isSubagentRunner: boolean
  readonly isSystemPromptOverridden?: boolean
  readonly toolHost: {
    readonly remoteBoxHasDesktop: boolean
    getRemoteBoxAvailable(): boolean
  }
  getSubagentConfigs?(): readonly unknown[]
  isBrowserUseSubagentEnabled?(): boolean
  isMultitaskEnabled?(): boolean
  getSubagentTypeName?(config: unknown): string | undefined
}

export function buildSlateSubagentConfigsForRun(host: TurnSubagentConfigHost): readonly unknown[] | undefined {
  if (host.isSubagentRunner) return undefined

  const hostConfigs = host.getSubagentConfigs?.() ?? []
  const configs = [...hostConfigs]
  if (host.toolHost.remoteBoxHasDesktop && host.toolHost.getRemoteBoxAvailable()) {
    const browserUseOffered = host.isBrowserUseSubagentEnabled?.() === true
    configs.push(createSlateComputerUseSubagentConfig({ browserUseOffered }))
    if (browserUseOffered) configs.push(createSlateBrowserUseSubagentConfig())
  }

  if (host.isSystemPromptOverridden !== true && host.isMultitaskEnabled?.() === true) {
    const executor = encodeSlateExecutorSubagentConfig(createSlateExecutorSubagentDefinition())
    const replacementIndex = configs.findIndex(config => isGeneralPurposeConfig(config, host.getSubagentTypeName?.(config)))
    if (replacementIndex === -1) return [...configs, executor]
    return configs.map((config, index) => index === replacementIndex ? executor : config)
  }

  return configs
}

function isGeneralPurposeConfig(config: unknown, hostName: string | undefined): boolean {
  if (hostName !== undefined) return hostName === "generalPurpose"
  if (typeof config !== "object" || config === null || !("subagent_type" in config)) return false
  const type = (config as { readonly subagent_type?: unknown }).subagent_type
  if (typeof type !== "object" || type === null || !("type" in type)) return false
  return slateSubagentTypeName(type as SlateSubagentTypeLike) === "generalPurpose"
}
