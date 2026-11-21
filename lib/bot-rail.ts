export type BotRailAvatar = { id: string; shape: string; color: string }

export type BotRailActivity = {
  sessionId: string
  avatar: BotRailAvatar
  state: string
}

export type BotRailEvent =
  | { type: 'snapshot'; idle: BotRailAvatar[]; active: BotRailActivity[] }
  | { type: 'activity'; sessionId: string; active: BotRailActivity | null }
