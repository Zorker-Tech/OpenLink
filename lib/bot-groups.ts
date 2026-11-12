import type { BotGroupMemberSummary, BotSummary } from '@/lib/bot-types'

export const BOT_GROUP_MAX_MEMBERS = 6
export const BOT_GROUP_HISTORY_LIMIT = 24

export interface BotGroupMention {
  id: string
  name: string
  mentioned: boolean
}

const MENTION_STOP_WORDS = new Set(['everyone', 'all', 'team', 'crew'])

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizedMention(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Deduplicate group members while preserving the order chosen by the user. */
export function normalizeGroupMemberIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push(id)
    if (result.length >= BOT_GROUP_MAX_MEMBERS) break
  }
  return result
}

export function isValidGroupMemberSet(value: unknown): boolean {
  const ids = normalizeGroupMemberIds(value)
  return ids.length >= 1 && ids.length <= BOT_GROUP_MAX_MEMBERS
}

/**
 * Resolve the first responders for a group turn. `@everyone` addresses every
 * member; otherwise only the named members respond. With no mention, the full
 * member list participates in the normal round-robin.
 */
export function resolveGroupResponders(
  members: readonly Pick<BotGroupMemberSummary, 'id' | 'name'>[],
  message: string,
): BotGroupMention[] {
  const normalized = message.toLowerCase()
  const mentioned: BotGroupMention[] = []
  let everyone = false
  for (const member of members) {
    const name = normalizedMention(member.name)
    if (!name) continue
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}_])`, 'iu')
    if (pattern.test(message)) {
      mentioned.push({ id: member.id, name: member.name, mentioned: true })
    }
  }
  for (const word of MENTION_STOP_WORDS) {
    if (new RegExp(`(^|[^\\p{L}\\p{N}_])@${word}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(normalized)) {
      everyone = true
      break
    }
  }
  if (everyone) {
    return members.map((member) => ({ id: member.id, name: member.name, mentioned: true }))
  }
  if (mentioned.length) return mentioned
  return members.map((member) => ({ id: member.id, name: member.name, mentioned: false }))
}

/** A member reply is a pass when it is empty or only the conventional marker. */
export function isGroupPassReply(value: string): boolean {
  const text = value.trim().toLowerCase()
  return !text || /^\(?pass\)?[.!]?$/.test(text)
}

export function boundedGroupReply(value: string): string {
  return value.trim().slice(0, 100_000)
}

export function isGroupBot(bot: Pick<BotSummary, 'kind'>): boolean {
  return bot.kind === 'group'
}

/** Only a Bot row that is not itself a group may be a group member. */
export function assertGroupMemberCandidate(
  candidate: Pick<BotSummary, 'id' | 'workspaceId' | 'kind'>,
  workspaceId: string,
): void {
  if (candidate.kind !== 'bot' || candidate.workspaceId !== workspaceId) {
    throw new Error('BOT_GROUP_MEMBER_INVALID')
  }
}
