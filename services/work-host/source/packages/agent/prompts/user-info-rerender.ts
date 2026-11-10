/**
 * When the first user message has to be rebuilt.
 *
 * The first user message carries the context block — the environment, the rules, the skills, the tool
 * catalogue — and it is written once and then reused for every later turn, because rebuilding it would
 * change the prompt and invalidate everything cached behind it. That makes two things matter: whether
 * what it says still matches the tools this session has, and whether it says something the session no
 * longer wants. Both are answered here, from the message itself rather than from stored state, because
 * the message is what the model actually saw.
 *
 * The context also records how complete it was, and a turn that recovers context it did not have before
 * is worth rebuilding for — but only if it recovered something, never if it merely reordered what was
 * already there. The summarization epoch does the same job for a conversation that was summarized: a
 * higher epoch means the summary the block was written against is no longer the current one.
 */

import { jsx } from "../../prompt-jsx/index.ts"
import { renderContent } from "../../prompt-jsx/index.ts"
import { AvailableSubagentModelsSection, AvailableSubagentTypesSection } from "./user-info-sections.ts"
import { DYNAMIC_TOOLS_NAMESPACE } from "../../agent-exec/mcp-operations.ts"

const REQUEST_CONTEXT_COMPLETENESS_KEYS = [
  "rules",
  "env",
  "repositoryInfo",
  "customSubagents",
  "agentSkills",
  "gitRepos",
  "gitStatus",
  "mcp",
  "mcpFileSystem",
] as const

type RequestContextCompleteness = Record<(typeof REQUEST_CONTEXT_COMPLETENESS_KEYS)[number], boolean>

/** Which parts of the context were available; anything not explicitly incomplete counts as complete. */
export function getRequestContextCompleteness(requestContext: Record<string, unknown>): RequestContextCompleteness {
  return {
    rules: requestContext.rulesInfoComplete !== false,
    env: requestContext.envInfoComplete !== false,
    repositoryInfo: requestContext.repositoryInfoComplete !== false,
    customSubagents: requestContext.customSubagentsInfoComplete !== false,
    agentSkills: requestContext.agentSkillsInfoComplete !== false,
    gitRepos: requestContext.gitRepoInfoComplete !== false,
    gitStatus: requestContext.gitStatusInfoComplete !== false,
    mcp: requestContext.mcpInfoComplete !== false,
    mcpFileSystem: requestContext.mcpFileSystemInfoComplete !== false,
  }
}

function isRequestContextComplete(completeness: RequestContextCompleteness): boolean {
  return REQUEST_CONTEXT_COMPLETENESS_KEYS.every(key => completeness[key])
}

function requestContextCompletenessScore(completeness: RequestContextCompleteness): number {
  return REQUEST_CONTEXT_COMPLETENESS_KEYS.filter(key => completeness[key]).length
}

/** More complete means every part that was there still is, and at least one more arrived. */
function requestContextCompletenessIsStrictlyMoreComplete(
  previous: RequestContextCompleteness,
  current: RequestContextCompleteness,
): boolean {
  const neverRegressed = REQUEST_CONTEXT_COMPLETENESS_KEYS.every(key => previous[key] === false || current[key] === true)
  return neverRegressed && requestContextCompletenessScore(current) > requestContextCompletenessScore(previous)
}

export function parseRequestContextCompletenessMetadata(value: unknown): RequestContextCompleteness | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const parsed: Record<string, boolean> = {}
  for (const key of REQUEST_CONTEXT_COMPLETENESS_KEYS) {
    const item = record[key]
    if (typeof item !== "boolean") return undefined
    parsed[key] = item
  }
  return parsed as RequestContextCompleteness
}

export function shouldRerenderUserInfoForRequestContextRecovery(params: {
  readonly previousCompleteness?: RequestContextCompleteness | undefined
  readonly currentCompleteness: RequestContextCompleteness
}): boolean {
  if (params.previousCompleteness === undefined || isRequestContextComplete(params.previousCompleteness)) return false
  return requestContextCompletenessIsStrictlyMoreComplete(params.previousCompleteness, params.currentCompleteness)
}

export function parseUserInfoSummarizationEpochMetadata(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}

export function shouldRerenderUserInfoAfterSummarization(params: {
  readonly previousEpoch?: number | undefined
  readonly currentEpoch: number
}): boolean {
  return params.previousEpoch !== undefined && params.currentEpoch > params.previousEpoch
}

/** Whether the block already describes the subagent models this session has, absence included. */
export function userInfoMatchesAvailableSubagentModels(content: string, description: string | undefined): boolean {
  if (description === undefined) return !content.includes("<available_subagent_models>")
  return content.includes(renderContent(jsx(AvailableSubagentModelsSection as never, { description })))
}

export function userInfoMatchesAvailableSubagentTypes(content: string, description: string | undefined): boolean {
  if (description === undefined) return !content.includes("<available_subagent_types>")
  return content.includes(renderContent(jsx(AvailableSubagentTypesSection as never, { description })))
}

/** Whether the block describes the on-demand tools this session exposes, and the same namespace with them. */
export function userInfoMatchesDynamicToolSnapshot(
  content: string,
  mcpMetaToolOptions: {
    readonly enabled?: boolean | undefined
    readonly mcpDescriptors: readonly { readonly serverIdentifier: string }[]
    readonly snapshotToolNames?: { readonly useDynamicToolNamespaces: boolean } | undefined
  } | undefined,
): boolean {
  const usesDynamicToolNamespaces = mcpMetaToolOptions?.enabled === true &&
    mcpMetaToolOptions.snapshotToolNames?.useDynamicToolNamespaces === true
  const expectsDynamicToolNamespaces = usesDynamicToolNamespaces && (mcpMetaToolOptions?.mcpDescriptors.length ?? 0) > 0
  const hasDynamicToolNamespaces = content.includes("<dynamic_tool_namespaces>")
  if (expectsDynamicToolNamespaces !== hasDynamicToolNamespaces) return false
  if (!expectsDynamicToolNamespaces || mcpMetaToolOptions === undefined) return true
  const namespaceDescriptor = mcpMetaToolOptions.mcpDescriptors.find(
    descriptor => descriptor.serverIdentifier === DYNAMIC_TOOLS_NAMESPACE,
  )
  const priorHasNamespace = content.includes(`<namespace name="${DYNAMIC_TOOLS_NAMESPACE}"`)
  if (namespaceDescriptor === undefined) return !priorHasNamespace
  return priorHasNamespace
}
