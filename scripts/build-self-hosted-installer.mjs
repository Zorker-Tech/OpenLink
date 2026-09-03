#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import { parseReleaseTrustRoot } from '../deploy/self-hosted/runtime/release-contract.mjs'

const execFile = promisify(execFileCallback)
const sourceRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))

export async function buildSelfHostedInstaller(options = {}) {
  const nodeExecutable = resolve(options.nodeExecutable ?? process.execPath)
  const output = resolve(options.output)
  const trustFile = resolve(options.trustFile)
  if (!options.signingKey || !options.keyId) throw new Error('SEA installer build requires an offline signing key and key id')
  const nodeStats = await lstat(nodeExecutable)
  const trustStats = await lstat(trustFile)
  if (!nodeStats.isFile() || (nodeStats.mode & 0o111) === 0) throw new Error('SEA build requires an executable native Node binary')
  if (!trustStats.isFile() || (trustStats.mode & 0o022) !== 0) throw new Error('SEA build trust root must be a protected regular file')
  const trust = JSON.parse(await readFile(trustFile, 'utf8'))
  const trustedKeys = parseReleaseTrustRoot(trust)
  if (!trustedKeys[options.keyId]) throw new Error(`SEA installer signing key is not active in the trust root: ${options.keyId}`)
  const privateKey = options.signingKey?.type === 'private' ? options.signingKey : createPrivateKey(options.signingKey)
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('SEA installer signing key must be Ed25519')
  const publicKey = createPublicKey(trustedKeys[options.keyId])
  const proof = Buffer.from('OpenLink installer signing key proof')
  if (!verify(null, proof, publicKey, sign(null, proof, privateKey))) throw new Error('SEA installer signing key does not match the active trust root')
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
    const bytes = (await lstat(output)).size
    const digest = createHash('sha256').update(await readFile(output)).digest('hex')
    const checksumPath = `${output}.sha256`
    const signaturePath = `${checksumPath}.sig`
    const checksum = Buffer.from(`${digest}  ${output.split('/').at(-1)}\n`)
    await writeFile(checksumPath, checksum, { mode: 0o644, flag: 'wx' })
    await writeFile(signaturePath, sign(null, checksum, privateKey), { mode: 0o644, flag: 'wx' })
    return { output, bytes, sha256: digest, checksumPath, signaturePath, signatureKeyId: options.keyId, trustedKeyIds: Object.keys(trustedKeys).sort() }
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
  const signingKeyPath = resolve(args.get('signing-key'))
  const signingKeyStats = await lstat(signingKeyPath)
  if (!signingKeyStats.isFile() || (signingKeyStats.mode & 0o077) !== 0) throw new Error('SEA installer signing key must be a protected regular file with mode 0600')
  buildSelfHostedInstaller({ output: args.get('output'), trustFile: args.get('trust'), nodeExecutable: args.get('node'), signingKey: await readFile(signingKeyPath), keyId: args.get('key-id') }).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  }).catch((error) => {
    process.stderr.write(`self-hosted installer build failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
