/** Provider-specific credentials, request formats and transports used behind Slate's prompt-session port. */

import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { jsonSchema, streamText, tool, type CoreMessage, type LanguageModelV1, type ToolSet } from "ai"
import type { SlateInferenceProvider } from "../../../shared/inference-router.ts"
import { getSlateRootDir } from "../../../host/host-paths.ts"
import { getBoxSecretsStorePath } from "../../../host/extensions/secrets/secrets-service.ts"
import { createOpenRouterChatModel, runClaudeCodeCli } from "../../../host/extensions/inference/local-providers.ts"
import { resolveClaudeCodeCliPath } from "../../../shared/node/inference-router-local.ts"
import { streamCodexDirectResponses, type CodexDirectTool } from "../../../host/extensions/inference/codex-direct-responses.ts"
import type { LabelMessage } from "../../../host/extensions/inference/slate-labeling.ts"

export type RoutedProvider = Exclude<SlateInferenceProvider, "slate">
export interface ProviderMessage extends LabelMessage { role: string; content: string | readonly unknown[] }
export type UsageRecord = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
export type RoutedToolExecutor = (tool: Record<string, any>, args: unknown, toolCallId: string) => Promise<unknown>

type Loose = Record<string, any>

const SLATE_ROUTED_PROVIDER_PROMPT = [
  "You are Slate, helping the user from their desktop workspace.",
  "Use the connected tools supplied with this request when they are relevant.",
  "Do not request credentials for integrations that are already connected.",
  "After the requested work is done, answer the user directly and accurately.",
].join("\n")

function deferred<T>() { return Promise.withResolvers<T>() }

function response(text: string, id: string, modelId: string) {
  return { id, modelId, timestamp: new Date(), headers: {}, messages: [{ role: "assistant", content: [{ type: "text", text }] }] }
}

function persistedSecrets(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(getBoxSecretsStorePath(), "utf8")) as unknown
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return {}
    const secrets = (parsed as { secrets?: unknown }).secrets
    if (typeof secrets !== "object" || secrets == null || Array.isArray(secrets)) return {}
    return Object.fromEntries(Object.entries(secrets).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  } catch { return {} }
}

function openRouterCredential(): string {
  const value = process.env.OPENROUTER_API_KEY?.trim() || persistedSecrets().OPENROUTER_API_KEY?.trim()
  if (value == null || value.length === 0) throw new Error("OpenRouter needs OPENROUTER_API_KEY. Add it in Settings → Router.")
  return value
}

function routedPrompt(messages: readonly ProviderMessage[]): string {
  const rendered = messages.map(message => {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    return `${message.role.toUpperCase()}: ${content}`
  }).join("\n\n")
  return `${SLATE_ROUTED_PROVIDER_PROMPT}\n\nContinue this conversation.\n\n${rendered}`
}

type CodexCredentials = { accessToken: string; refreshToken: string; idToken: string; accountId: string; path: string; document: Loose }

function codexCredentials(): CodexCredentials {
  const authPath = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json")
  const info = lstatSync(authPath)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("The local provider login file must be a private, regular file.")
  const parsed = JSON.parse(readFileSync(authPath, "utf8")) as Loose
  const accessToken = parsed?.tokens?.access_token
  const refreshToken = parsed?.tokens?.refresh_token
  const idToken = parsed?.tokens?.id_token
  const accountId = parsed?.tokens?.account_id
  if (parsed?.auth_mode !== "chatgpt" || typeof accessToken !== "string" || accessToken.length === 0 || typeof refreshToken !== "string" || refreshToken.length === 0 || typeof idToken !== "string" || idToken.length === 0 || typeof accountId !== "string" || accountId.length === 0) {
    throw new Error("The local provider is not signed in. Sign in from its CLI, then reopen Slate.")
  }
  return { accessToken, refreshToken, idToken, accountId, path: authPath, document: parsed }
}

function jwtAudience(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Loose
    const audience = payload.aud
    return typeof audience === "string" ? audience : Array.isArray(audience) ? audience.find((value): value is string => typeof value === "string") ?? null : null
  } catch { return null }
}

async function refreshCodexCredentials(current: CodexCredentials): Promise<CodexCredentials> {
  const clientId = jwtAudience(current.idToken)
  if (clientId == null) throw new Error("The local provider login expired and cannot be refreshed. Sign in again.")
  const refresh = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: clientId }),
  })
  if (!refresh.ok) throw new Error("The local provider login expired and could not be refreshed. Sign in again.")
  const payload = await refresh.json() as Loose
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) throw new Error("The local provider returned an unusable refreshed login.")
  const document = {
    ...current.document,
    tokens: {
      ...current.document.tokens,
      access_token: payload.access_token,
      refresh_token: typeof payload.refresh_token === "string" && payload.refresh_token.length > 0 ? payload.refresh_token : current.refreshToken,
      id_token: typeof payload.id_token === "string" && payload.id_token.length > 0 ? payload.id_token : current.idToken,
    },
    last_refresh: new Date().toISOString(),
  }
  const temporary = `${current.path}.${process.pid}.${crypto.randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
  renameSync(temporary, current.path)
  return codexCredentials()
}

function codexAuthenticatedFetch(initial: CodexCredentials): typeof fetch {
  let credentials = initial
  return async (input, init) => {
    const perform = () => {
      const headers = new Headers(init?.headers)
      headers.set("authorization", `Bearer ${credentials.accessToken}`)
      headers.set("ChatGPT-Account-Id", credentials.accountId)
      return fetch(input, { ...init, headers })
    }
    let result = await perform()
    if (result.status !== 401) return result
    credentials = await refreshCodexCredentials(credentials)
    result = await perform()
    return result
  }
}

function configuredCodexModel(): string {
  const selected = process.env.SLATE_CODEX_MODEL?.trim()
  if (selected) return selected
  try {
    const config = readFileSync(join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml"), "utf8")
    return /^\s*model\s*=\s*["']([^"']+)["']/m.exec(config)?.[1]?.trim() || "gpt-5.4"
  } catch { return "gpt-5.4" }
}

function configuredCodexReasoningEffort(): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  const selected = process.env.SLATE_CODEX_REASONING_EFFORT?.trim()
  if (selected === "minimal" || selected === "low" || selected === "medium" || selected === "high" || selected === "xhigh") return selected
  try {
    const config = readFileSync(join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml"), "utf8")
    const value = /^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m.exec(config)?.[1]?.trim()
    return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : undefined
  } catch { return undefined }
}

function codexTools(definitions: readonly Loose[] | undefined): CodexDirectTool[] | undefined {
  if (definitions == null) return undefined
  const tools = definitions.flatMap((source): CodexDirectTool[] => {
    const parameters = source.inputSchema ?? source.parameters
    return typeof source.name === "string" && source.name.length > 0 && parameters != null ? [{
      name: source.name,
      ...(typeof source.description === "string" ? { description: source.description } : {}),
      parameters,
      source,
    }] : []
  })
  return tools.length === 0 ? undefined : tools
}

function codexExecutor(messages: readonly ProviderMessage[], invocationId: string, definitions?: readonly Loose[], executeTool?: RoutedToolExecutor, onUsage?: (usage: UsageRecord) => void) {
  const credentials = codexCredentials()
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>()
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>()
  const resultResponse = deferred<ReturnType<typeof response>>()
  const metadata = deferred<Record<string, unknown>>()
  const model = configuredCodexModel()
  const tools = codexTools(definitions)
  const fullStream = (async function* () {
    let text = ""
    try {
      for await (const event of streamCodexDirectResponses({
        fetch: codexAuthenticatedFetch(credentials),
        endpoint: "https://chatgpt.com/backend-api/codex/responses",
        model,
        ...(configuredCodexReasoningEffort() == null ? {} : { reasoningEffort: configuredCodexReasoningEffort()! }),
        instructions: SLATE_ROUTED_PROVIDER_PROMPT,
        input: messages.map(message => ({ role: message.role === "assistant" ? "assistant" : "user", content: typeof message.content === "string" ? message.content : JSON.stringify(message.content) })),
        ...(tools == null ? {} : { tools }),
        ...(executeTool == null ? {} : { executeTool: async (selected, args, toolCallId) => await executeTool(selected.source, args, toolCallId) }),
        maxSteps: tools == null ? 1 : 8,
      })) {
        if (event.type === "text-delta") { text += event.delta; yield { type: "text-delta" as const, textDelta: event.delta }; continue }
        const basic = { promptTokens: event.usage.inputTokens, completionTokens: event.usage.outputTokens, totalTokens: event.usage.inputTokens + event.usage.outputTokens }
        const extended = { ...event.usage, maxTokens: 0 }
        onUsage?.(event.usage)
        usage.resolve(basic)
        extendedUsage.resolve(extended)
        metadata.resolve({ openai: { responseId: event.responseId, direct: true } })
        resultResponse.resolve(response(text, invocationId, model))
      }
    } catch (error) { usage.reject(error); extendedUsage.reject(error); metadata.reject(error); resultResponse.reject(error); throw error }
  })()
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) }
}

function claudeExecutor(messages: readonly ProviderMessage[], invocationId: string, onUsage?: (usage: UsageRecord) => void, mcpServerUrl?: string) {
  const executable = resolveClaudeCodeCliPath()
  if (executable == null) throw new Error("The configured local inference tool is not installed. Install and sign in to it, then reopen Slate.")
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>()
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>()
  const resultResponse = deferred<ReturnType<typeof response>>()
  const metadata = deferred<Record<string, unknown>>()
  const fullStream = (async function* () {
    try {
      const selectedModel = process.env.SLATE_CLAUDE_MODEL?.trim()
      const final = await runClaudeCodeCli({
        executable,
        prompt: routedPrompt(messages),
        cwd: getSlateRootDir(),
        ...(mcpServerUrl == null ? {} : { mcpServerName: "slate_plugins", mcpServerUrl, maxTurns: 8 }),
        ...(selectedModel == null || selectedModel.length === 0 ? {} : { model: selectedModel }),
      })
      const text = final.result
      if (text.length > 0) yield { type: "text-delta" as const, textDelta: text }
      const input = final.usage.input_tokens, output = final.usage.output_tokens, cacheRead = final.usage.cache_read_input_tokens ?? 0, cacheWrite = final.usage.cache_creation_input_tokens ?? 0
      onUsage?.({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite })
      usage.resolve({ promptTokens: input, completionTokens: output, totalTokens: input + output })
      extendedUsage.resolve({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, maxTokens: 0 })
      metadata.resolve({ anthropic: { sessionId: final.session_id, totalCostUsd: final.total_cost_usd } })
      resultResponse.resolve(response(text, invocationId, "claude-code"))
    } catch (error) { usage.reject(error); extendedUsage.reject(error); metadata.reject(error); resultResponse.reject(error); throw error }
  })()
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) }
}

function toToolSet(definitions: readonly Loose[] | undefined, executeTool?: RoutedToolExecutor): ToolSet | undefined {
  if (definitions == null || definitions.length === 0) return undefined
  const tools: ToolSet = {}
  for (const definition of definitions) {
    if (typeof definition.name !== "string" || definition.name.length === 0) continue
    const parameters = definition.inputSchema ?? definition.parameters
    if (parameters == null) continue
    const routedTool: any = {
      ...(typeof definition.description === "string" ? { description: definition.description } : {}),
      parameters: jsonSchema(parameters),
    }
    if (executeTool != null) routedTool.execute = async (args: unknown, options: { toolCallId: string }) => await executeTool(definition, args, options.toolCallId)
    tools[definition.name] = tool(routedTool)
  }
  return Object.keys(tools).length === 0 ? undefined : tools
}

function openRouterExecutor(messages: readonly ProviderMessage[], invocationId: string, definitions?: readonly Loose[], executeTool?: RoutedToolExecutor, onUsage?: (usage: UsageRecord) => void) {
  const modelId = process.env.SLATE_OPENROUTER_MODEL?.trim() || "openai/gpt-5.2"
  const model: LanguageModelV1 = createOpenRouterChatModel({ apiKey: openRouterCredential(), modelId, baseURL: "https://openrouter.ai/api/v1" })
  const tools = toToolSet(definitions, executeTool)
  const result = streamText({ model, system: SLATE_ROUTED_PROVIDER_PROMPT, messages: messages as CoreMessage[], ...(tools === undefined ? {} : { tools }), toolCallStreaming: true, maxSteps: tools === undefined ? 1 : 8 })
  const extendedUsage = result.usage.then(value => ({ inputTokens: value.promptTokens, outputTokens: value.completionTokens, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 0 }))
  if (onUsage != null) void extendedUsage.then(onUsage)
  return { fullStream: result.fullStream, response: result.response, usage: result.usage, extendedUsage, providerMetadata: result.providerMetadata, invocationId: Promise.resolve(invocationId) }
}

export function routedProviderModelId(provider: RoutedProvider): string {
  if (provider === "codex") return configuredCodexModel()
  if (provider === "claude-code") return "claude-code"
  return process.env.SLATE_OPENROUTER_MODEL?.trim() || "openai/gpt-5.2"
}

export function streamWithRoutedProvider(input: {
  readonly provider: RoutedProvider
  readonly messages: readonly ProviderMessage[]
  readonly invocationId: string
  readonly tools?: readonly Loose[]
  readonly executeTool?: RoutedToolExecutor
  readonly onUsage?: (usage: UsageRecord) => void
  readonly mcpServerUrl?: string
}) {
  if (input.provider === "codex") return codexExecutor(input.messages, input.invocationId, input.tools, input.executeTool, input.onUsage)
  if (input.provider === "claude-code") return claudeExecutor(input.messages, input.invocationId, input.onUsage, input.mcpServerUrl)
  return openRouterExecutor(input.messages, input.invocationId, input.tools, input.executeTool, input.onUsage)
}
