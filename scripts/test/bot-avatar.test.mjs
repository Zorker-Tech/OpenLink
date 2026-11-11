import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COLORS,
  SHAPES,
  hashColor,
  hashShape,
} from '../../packages/avatar/src/lib/avatar-engine.js'
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
  isBotAvatarColor,
  isBotAvatarShape,
} from '../../lib/bot-avatar.ts'
import { fallbackBotAvatarSvg } from '../../lib/bot-avatar-fallback.ts'

test('the server avatar vocabulary matches the renderer vocabulary', () => {
  assert.deepEqual([...BOT_AVATAR_SHAPES], SHAPES.map((shape) => shape.id))
  assert.deepEqual([...BOT_AVATAR_COLORS], COLORS.map((color) => color.id))
})

test('shape and color validation reject unknown identities', () => {
  assert.equal(isBotAvatarShape('blob'), true)
  assert.equal(isBotAvatarColor('orange'), true)
  assert.equal(isBotAvatarShape('../../escape'), false)
  assert.equal(isBotAvatarColor('transparent'), false)
})

test('avatar defaults are deterministic', () => {
  assert.equal(hashShape('OpenLink Bot'), hashShape('OpenLink Bot'))
  assert.equal(hashColor('OpenLink Bot'), hashColor('OpenLink Bot'))
  assert.equal(BOT_AVATAR_SHAPES.includes(hashShape('OpenLink Bot')), true)
  assert.equal(BOT_AVATAR_COLORS.includes(hashColor('OpenLink Bot')), true)
})

test('the fallback avatar is deterministic, escaped and uses the selected palette', () => {
  const svg = fallbackBotAvatarSvg('<Ops & "Co">', 'orange')
  assert.match(svg, /aria-label="&lt;Ops &amp; &quot;Co&quot;&gt;"/)
  assert.match(svg, /fill="#FF781C"/)
  assert.match(svg, />O<\/text>/)
  assert.equal(svg, fallbackBotAvatarSvg('<Ops & "Co">', 'orange'))
  assert.match(fallbackBotAvatarSvg('Bot', 'not-a-color'), /fill="#FF781C"/)
})
