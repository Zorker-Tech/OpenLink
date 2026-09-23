import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * i18n coverage report.
 *
 * Counts user-visible Chinese literals per file and how many of them already
 * route through `t(...)`. Run `node scripts/i18n-report.mjs` after a migration
 * pass to see what is left, and `--json` for machine-readable output.
 */
const root = fileURLToPath(new URL('..', import.meta.url))
const SCAN_DIRECTORIES = ['app', 'components', 'lib']
const EXTENSIONS = ['.ts', '.tsx']
const HAN = /[\u4e00-\u9fff]/
const CHINESE_LITERAL = /(['"`])((?:\\.|(?!\1).)*[\u4e00-\u9fff](?:\\.|(?!\1).)*)\1/g
const JSX_TEXT = />([^<>{}]*[\u4e00-\u9fff][^<>{}]*)</g

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (EXTENSIONS.some((extension) => entry.name.endsWith(extension))) yield path
  }
}

function isTranslated(source, index) {
  const prefix = source.slice(Math.max(0, index - 24), index)
  return /(?:^|[^\w$])(?:t|translate)\(\s*$/.test(prefix)
}

async function main() {
  const json = process.argv.includes('--json')
  const rows = []
  let total = 0
  let translated = 0

  for (const directory of SCAN_DIRECTORIES) {
    for await (const file of walk(join(root, directory))) {
      const content = await readFile(file, 'utf8')
      if (!HAN.test(content)) continue
      let fileTotal = 0
      let fileTranslated = 0
      for (const match of content.matchAll(CHINESE_LITERAL)) {
        fileTotal += 1
        if (isTranslated(content, match.index ?? 0)) fileTranslated += 1
      }
      for (const match of content.matchAll(JSX_TEXT)) {
        fileTotal += 1
        if (isTranslated(content, match.index ?? 0)) fileTranslated += 1
      }
      if (!fileTotal) continue
      total += fileTotal
      translated += fileTranslated
      rows.push({ file: relative(root, file), total: fileTotal, translated: fileTranslated, remaining: fileTotal - fileTranslated })
    }
  }

  rows.sort((left, right) => right.remaining - left.remaining)
  if (json) {
    console.log(JSON.stringify({ total, translated, remaining: total - translated, files: rows }, null, 2))
    return
  }
  for (const row of rows.filter((row) => row.remaining > 0)) {
    console.log(`${String(row.remaining).padStart(4)} left  ${String(row.translated).padStart(4)} done  ${row.file}`)
  }
  const percentage = total ? Math.round((translated / total) * 100) : 100
  console.log(`\n${translated}/${total} localized (${percentage}%), ${total - translated} remaining across ${rows.length} files`)
}

await main()
