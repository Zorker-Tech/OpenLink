#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const execFile = promisify(execFileCallback)
const sourceRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))

export async function buildSelfHostedInstaller(options = {}) {
  const nodeExecutable = resolve(options.nodeExecutable ?? process.execPath)
  const output = resolve(options.output)
  const trustFile = resolve(options.trustFile)
  const nodeStats = await lstat(nodeExecutable)
  const trustStats = await lstat(trustFile)
  if (!nodeStats.isFile() || (nodeStats.mode & 0o111) === 0) throw new Error('SEA build requires an executable native Node binary')
  if (!trustStats.isFile() || (trustStats.mode & 0o022) !== 0) throw new Error('SEA build trust root must be a protected regular file')
  const trust = JSON.parse(await readFile(trustFile, 'utf8'))
  if (!trust?.keys || Object.keys(trust.keys).length === 0) throw new Error('SEA build trust root contains no keys')
  await mkdir(dirname(output), { recursive: true, mode: 0o755 })
  const work = await mkdtemp(resolve(dirname(output), `.installer-build-${process.pid}-`))
  try {
    const bundled = resolve(work, 'installer.bundle.mjs')
    await build({
      entryPoints: [resolve(sourceRoot, 'deploy/self-hosted/bootstrap-installer.mjs')],
      outfile: bundled,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node26',
      minify: false,
      sourcemap: false,
      legalComments: 'none',
    })
    const config = resolve(work, 'sea-config.json')
    await writeFile(config, `${JSON.stringify({
      main: bundled,
      mainFormat: 'module',
      executable: nodeExecutable,
      output,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      execArgvExtension: 'none',
      assets: { 'release-keys.json': trustFile },
    }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await execFile(nodeExecutable, ['--build-sea', config], { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 })
    await chmod(output, 0o755)
    if (process.platform === 'darwin' && options.codeSign !== false) {
      await execFile('/usr/bin/codesign', ['--force', '--sign', options.signingIdentity || '-', output], { timeout: 120_000 })
      await execFile('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', output], { timeout: 120_000 })
    }
    return { output, bytes: (await lstat(output)).size, trustedKeyIds: Object.keys(trust.keys).sort() }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

function argumentsMap(argv) {
  const result = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) throw new Error(`Invalid argument near ${argv[index] ?? '<end>'}`)
    result.set(argv[index].slice(2), argv[index + 1])
  }
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = argumentsMap(process.argv.slice(2))
  buildSelfHostedInstaller({ output: args.get('output'), trustFile: args.get('trust'), nodeExecutable: args.get('node') }).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  }).catch((error) => {
    process.stderr.write(`self-hosted installer build failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
