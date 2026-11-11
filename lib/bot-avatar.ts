/**
 * Server-safe avatar vocabulary.
 *
 * The renderer lives in the client-side `@zorker/avatar` package, but the Bot
 * service must validate durable shape/color values without importing a client
 * component graph. Keep this allowlist dependency-free and verify it against
 * the renderer vocabulary in `scripts/test/bot-avatar.test.mjs`.
 */

export const BOT_AVATAR_SHAPES = [
  'blob',
  'pebble',
  'bean',
  'egg',
  'squircle',
  'tablet',
  'capsule',
  'cylinder',
  'hex',
  'gem',
  'crystal',
  'wedge',
  'shield',
  'dome',
  'arch',
  'cloud',
  'teardrop',
  'leaf',
  'square',
  'sparkle',
  'clover',
  'flower',
  'heart',
  'house',
  'star',
  'pumpkin',
] as const

export const BOT_AVATAR_COLORS = [
  'black',
  'brown',
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'violet',
  'magenta',
  'gray',
] as const

const SHAPE_IDS = new Set<string>(BOT_AVATAR_SHAPES)
const COLOR_IDS = new Set<string>(BOT_AVATAR_COLORS)

export function isBotAvatarShape(value: string): boolean {
  return SHAPE_IDS.has(value)
}

export function isBotAvatarColor(value: string): boolean {
  return COLOR_IDS.has(value)
}
