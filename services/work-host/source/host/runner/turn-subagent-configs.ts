/** Decide which task delegates this run can offer. */

import { slateSubagentTypeName, type SlateSubagentType } from "../../packages/agent/subagent-type.ts"
import { createSlateBrowserUseSubagentConfig } from "./tools/slate-browser-use-subagent.ts"
import { createSlateComputerUseSubagentConfig } from "./tools/slate-computer-use-subagent.ts"
import { createSlateExecutorSubagentConfig } from "../slate-multitask.ts"
import { slateSubagentConfigFromInterop } from "../../adapters/interop/agent/subagent-type-adapter.ts"

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

  const hostConfigs = (host.getSubagentConfigs?.() ?? []).map(slateSubagentConfigFromInterop)
  const configs = [...hostConfigs]
  if (host.toolHost.remoteBoxHasDesktop && host.toolHost.getRemoteBoxAvailable()) {
    const browserUseOffered = host.isBrowserUseSubagentEnabled?.() === true
    configs.push(createSlateComputerUseSubagentConfig({ browserUseOffered }))
    if (browserUseOffered) configs.push(createSlateBrowserUseSubagentConfig())
  }

  if (host.isSystemPromptOverridden !== true && host.isMultitaskEnabled?.() === true) {
    const executor = createSlateExecutorSubagentConfig()
    const replacementIndex = configs.findIndex(config => isGeneralPurposeConfig(config, host.getSubagentTypeName?.(config)))
    if (replacementIndex === -1) return [...configs, executor]
    return configs.map((config, index) => index === replacementIndex ? executor : config)
  }

  return configs
}

function isGeneralPurposeConfig(config: unknown, hostName: string | undefined): boolean {
  if (hostName !== undefined) return hostName === "generalPurpose"
  if (typeof config !== "object" || config === null || !("subagentType" in config)) return false
  const type = (config as { readonly subagentType?: unknown }).subagentType
  if (typeof type !== "object" || type === null || !("kind" in type)) return false
  return slateSubagentTypeName(type as SlateSubagentType) === "generalPurpose"
}
