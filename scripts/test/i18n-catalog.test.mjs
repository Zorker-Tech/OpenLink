import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const locales = ['zh-CN', 'zh-TW', 'en-US', 'en-SG', 'de-DE', 'fr-FR', 'ja-JP', 'ko-KR', 'ru-RU']
const scanDirectories = ['app', 'components', 'lib']
const extensions = ['.ts', '.tsx']
const han = /[\u4e00-\u9fff]/
const call = /(?<![\w$.])(?:t|translate)\(\s*(['"`])((?:\\.|(?!\1).)*?)\1\s*(?:,|\))/gs

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (extensions.some((extension) => entry.name.endsWith(extension))) yield path
  }
}

function decode(source, quote) {
  if (quote === '"') return JSON.parse(`"${source.replaceAll('"', '\\"').replaceAll('\\\\"', '\\"')}"`)
  return source.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|n|r|t|b|f|v|0|'|"|`|\\|\/)/g, (match, escape) => {
    if (escape.startsWith('u{')) return String.fromCodePoint(Number.parseInt(escape.slice(2, -1), 16))
    if (escape.startsWith('u')) return String.fromCharCode(Number.parseInt(escape.slice(1), 16))
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0', "'": "'", '"': '"', '`': '`', '\\': '\\', '/': '/' })[escape] ?? match
  })
}

test('every static translation key exists in every target locale', async () => {
  const catalogs = Object.fromEntries(await Promise.all(locales.map(async (locale) => [
    locale,
    JSON.parse(await readFile(join(root, 'lib/i18n/messages', `${locale}.json`), 'utf8')),
  ])))

  const used = new Map()
  for (const directory of scanDirectories) {
    for await (const file of walk(join(root, directory))) {
      const content = await readFile(file, 'utf8')
      for (const match of content.matchAll(call)) {
        if (match[2].includes('${')) continue
        const key = decode(match[2], match[1])
        if (!key.trim()) continue
        if (!used.has(key)) used.set(key, relative(root, file))
      }
    }
  }

  assert.ok(used.size > 1000, `expected a substantial translation surface, found ${used.size}`)
  for (const [key, file] of used) {
    for (const locale of locales) {
      // zh-CN is the source language for Chinese copy. English-authored
      // sources still need an explicit zh-CN entry because they are not
      // readable Chinese.
      if (locale === 'zh-CN' && han.test(key)) continue
      assert.ok(
        Object.hasOwn(catalogs[locale], key),
        `${locale} is missing ${JSON.stringify(key)} used by ${file}`,
      )
    }
  }
})

test('catalog entries are non-empty strings and every locale is present', async () => {
  for (const locale of locales) {
    const catalog = JSON.parse(await readFile(join(root, 'lib/i18n/messages', `${locale}.json`), 'utf8'))
    for (const [source, translation] of Object.entries(catalog)) {
      assert.equal(typeof translation, 'string', `${locale}: ${source} is not a string`)
      assert.ok(translation.trim(), `${locale}: ${source} is empty`)
    }
  }
})
