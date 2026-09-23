import { readdir, readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Merges per-namespace translation parts into the runtime catalogs.
 *
 * Parts live in `lib/i18n/parts/<part>.<locale>.json` and each hold a flat
 * `{ "source string": "translation" }` map. They are merged (and sorted) into
 * `lib/i18n/messages/<locale>.json`, which is what the app loads.
 */
const root = fileURLToPath(new URL('..', import.meta.url))
const partsDirectory = join(root, 'lib/i18n/parts')
const messagesDirectory = join(root, 'lib/i18n/messages')

const LOCALES = ['zh-CN', 'zh-TW', 'en-US', 'en-SG', 'de-DE', 'fr-FR', 'ja-JP', 'ko-KR', 'ru-RU']

async function main() {
  if (!existsSync(partsDirectory)) {
    console.log('No translation parts found; nothing to merge.')
    return
  }
  const entries = await readdir(partsDirectory)
  const merged = new Map(LOCALES.map((locale) => [locale, {}]))
  const owners = new Map()

  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue
    const match = /^(?<part>.+)\.(?<locale>[a-z]{2}-[A-Z]{2})\.json$/.exec(entry)
    if (!match?.groups) throw new Error(`Translation part name must be <part>.<locale>.json: ${entry}`)
    const { part, locale } = match.groups
    if (!merged.has(locale)) throw new Error(`Unsupported locale in part file: ${entry}`)
    const messages = JSON.parse(await readFile(join(partsDirectory, entry), 'utf8'))
    for (const [source, translation] of Object.entries(messages)) {
      if (typeof translation !== 'string' || !translation.trim()) continue
      const key = `${locale}\u0000${source}`
      const previous = owners.get(key)
      if (previous && merged.get(locale)[source] !== translation) {
        // Shared strings such as 取消 legitimately appear in several parts.
        // Keep the first translation but surface the disagreement.
        console.warn(`i18n: "${source}" (${locale}) differs between ${previous} and ${part}; keeping ${previous}`)
        continue
      }
      owners.set(key, previous ?? part)
      merged.get(locale)[source] = translation
    }
  }

  await rm(messagesDirectory, { recursive: true, force: true })
  await mkdir(messagesDirectory, { recursive: true })
  for (const locale of LOCALES) {
    const messages = merged.get(locale)
    const sorted = Object.fromEntries(Object.entries(messages).sort(([left], [right]) => left.localeCompare(right, 'zh-CN')))
    await writeFile(join(messagesDirectory, `${locale}.json`), `${JSON.stringify(sorted, null, 2)}\n`)
    console.log(`${locale}: ${Object.keys(sorted).length} strings`)
  }
}

await main()
