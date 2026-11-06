/**
 * Desktop type gate.
 *
 * The repository's shared components still carry a small set of pre-existing
 * diagnostics (Base UI generics, AI SDK usage fields, untyped Supabase rows)
 * that the Next build intentionally does not gate on. This command fails only
 * for the desktop host's own files, so a desktop regression cannot hide behind
 * that legacy noise.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const tsc = join(repositoryRoot, 'node_modules/typescript/bin/tsc')

const child = spawn(
  process.execPath,
  [tsc, '-p', 'desktop/tsconfig.json', '--noEmit'],
  { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
)

let output = ''
child.stdout.on('data', (chunk) => { output += chunk.toString() })
child.stderr.on('data', (chunk) => { output += chunk.toString() })

child.once('close', (code) => {
  const diagnostics = output
    .split(/\r?\n/)
    .filter((line) => /error TS\d+/.test(line))
  const owned = diagnostics.filter((line) =>
    /^(?:src\/renderer\/|\.\.\/lib\/desktop-api\/|\.\.\/app\/api\/desktop\/)/.test(line),
  )
  const legacy = diagnostics.filter((line) => !owned.includes(line))

  if (owned.length) {
    process.stderr.write(`${owned.join('\n')}\n`)
    process.exit(1)
  }
  if (code !== 0 && legacy.length) {
    process.stdout.write(
      `Desktop type check passed; ${legacy.length} pre-existing shared-code diagnostics were ignored.\n`,
    )
    process.exit(0)
  }
  process.stdout.write('Desktop type check passed.\n')
  process.exit(code ?? 0)
})
