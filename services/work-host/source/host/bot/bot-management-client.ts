import { createHash } from 'node:crypto'
import type { BotRuntimeBinding } from './bot-runtime-store.ts'

export function createBotManagementClient(readBinding: () => BotRuntimeBinding | null) {
  const origin = process.env.OPENLINK_WORK_HOST_APP_ORIGIN
  const token = process.env.SLATE_GATEWAY_TOKEN
  if (!origin || !token) return null
  const endpoint = new URL('/api/bots/internal/manage', origin)
  return async (callId: string, parameters: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const binding = readBinding()
    if (!binding) return { error: 'BOT_RUNTIME_NOT_READY' }
    const bytes = createHash('sha256').update(binding.botId).update('\0').update(callId).digest()
    bytes[6] = (bytes[6]! & 0x0f) | 0x40
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    const hex = bytes.subarray(0, 16).toString('hex')
    const operationId = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...parameters, operationId,
        botId: binding.botId, agentId: binding.agentId, userId: binding.userId, workspaceId: binding.workspaceId,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(90_000),
    })
    const value: unknown = await response.json().catch(() => null)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : { error: 'BOT_MANAGEMENT_UNAVAILABLE' }
  }
}
