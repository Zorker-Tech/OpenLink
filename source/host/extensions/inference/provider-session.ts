/** Slate's prompt-session shell for routed inference integrations. */

import { randomUUID } from "node:crypto"
import { join } from "node:path"

import { BasePromptBuilder, BasePromptExecutor } from "../../../packages/chat-inference/base.ts"
import { getSlateRootDir } from "../../host-paths.ts"
import { SlateSettingsStore } from "../../../shared/node/settings/slate-settings-store.ts"
import { streamWithRoutedProvider, routedProviderModelId } from "../../../adapters/interop/inference/routed-provider-session-adapter.ts"
import type { ProviderMessage, RoutedProvider, RoutedToolExecutor, UsageRecord } from "../../../adapters/interop/inference/routed-provider-session-adapter.ts"
import type { PromptExecutor } from "./slate-labeling.ts"

function recordRoutedUsage(provider: RoutedProvider, usage: UsageRecord): void {
  new SlateSettingsStore(join(getSlateRootDir(), "settings.json")).recordInferenceUsage(provider, usage)
}

class ProviderPromptExecutor extends BasePromptExecutor<ProviderMessage> {
  constructor(readonly provider: RoutedProvider, initialMessages?: readonly ProviderMessage[], readonly onUsage?: (usage: UsageRecord) => void) {
    super(new BasePromptBuilder(initialMessages))
  }

  stream(_context: unknown, invocationId = randomUUID(), definitions?: readonly Record<string, unknown>[]) {
    return streamWithRoutedProvider({
      provider: this.provider,
      messages: this.getMessages(),
      invocationId,
      ...(definitions === undefined ? {} : { tools: definitions }),
      ...(this.onUsage === undefined ? {} : { onUsage: this.onUsage }),
    })
  }
}

/** One host session, backed by the routed integration selected in settings. */
export function createProviderPromptSession(provider: RoutedProvider): { getModelId(): string; getExecutor(state?: unknown): PromptExecutor } {
  const modelId = routedProviderModelId(provider)
  return {
    getModelId: () => modelId,
    getExecutor: state => new ProviderPromptExecutor(
      provider,
      Array.isArray(state) ? state as ProviderMessage[] : undefined,
      usage => recordRoutedUsage(provider, usage),
    ),
  }
}

/** Runs one routed text request and forwards each emitted text fragment to the caller. */
export async function runRoutedProviderText(
  provider: RoutedProvider,
  messages: readonly ProviderMessage[],
  options?: {
    readonly mcpServerUrl?: string
    readonly tools?: readonly Record<string, unknown>[]
    readonly executeTool?: RoutedToolExecutor
    readonly onTextDelta?: (delta: string, accumulated: string) => void
  },
): Promise<string> {
  const invocationId = randomUUID()
  const onUsage = (usage: UsageRecord) => recordRoutedUsage(provider, usage)
  const stream = streamWithRoutedProvider({
    provider,
    messages,
    invocationId,
    ...(options?.mcpServerUrl === undefined ? {} : { mcpServerUrl: options.mcpServerUrl }),
    ...(options?.tools === undefined ? {} : { tools: options.tools }),
    ...(options?.executeTool === undefined ? {} : { executeTool: options.executeTool }),
    onUsage,
  })
  let text = ""
  for await (const event of stream.fullStream) {
    if (event.type !== "text-delta" || typeof event.textDelta !== "string") continue
    text += event.textDelta
    options?.onTextDelta?.(event.textDelta, text)
  }
  await stream.response
  return text
}
