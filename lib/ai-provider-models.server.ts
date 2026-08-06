import 'server-only'

import type { AiProviderModel } from '@/lib/ai-provider-types'
import { getAiProvider } from '@/lib/ai-providers'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export type { AiProviderModel } from '@/lib/ai-provider-types'

type PiModelRecord = AiProviderModel & { provider: string }

export async function getAiProviderModels(providerId: string): Promise<AiProviderModel[]> {
  if (!getAiProvider(providerId)) return []
  const path = resolve(process.cwd(), 'services/pi/packages/ai/src/providers/data', `${providerId}.json`)
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const parsed = JSON.parse(source) as Record<string, Record<string, PiModelRecord>>
  return Object.values(parsed)
    .flatMap((models) => Object.values(models))
    .map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api,
      baseUrl: model.baseUrl,
      reasoning: Boolean(model.reasoning),
      input: Array.isArray(model.input) ? model.input : ['text'],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: model.cost,
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}
