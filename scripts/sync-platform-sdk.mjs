import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../packages/platform-sdk/', import.meta.url))
const manifest = JSON.parse(readFileSync(root + 'manifest.json', 'utf8'))
if (manifest.schemaVersion !== 1 || manifest.name !== '@vtslx/platform-sdk' ||
  !/^platform-sdk-[a-z0-9.-]+\.tgz$/.test(manifest.file) || !/^[a-f0-9]{64}$/.test(manifest.sha256))
  throw new Error('Invalid platform SDK artifact manifest')
const target = root + 'tarballs/' + manifest.file
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const args = process.argv.slice(2)
if (!(args.length === 1 && args[0] === '--check') && !(args.length === 2 && args[0] === '--artifact'))
  throw new Error('Usage: node scripts/sync-platform-sdk.mjs --check | --artifact /path/to/reviewed.tgz')
if (args[0] === '--artifact') {
  const source = resolve(args[1])
  const stat = statSync(source)
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || hash(source) !== manifest.sha256)
    throw new Error('Platform SDK artifact integrity mismatch')
  const metadata = JSON.parse(execFileSync('tar', ['-xOf', source, 'package/package.json'], { encoding: 'utf8', maxBuffer: 65536 }))
  if (metadata.name !== manifest.name || metadata.version !== manifest.version ||
    !['./auth', './product', './workspace'].every(path => metadata.exports?.[path]))
    throw new Error('Unexpected platform SDK package contract')
  mkdirSync(root + 'tarballs', { recursive: true })
  if (!existsSync(target)) copyFileSync(source, target, constants.COPYFILE_EXCL)
}
if (!existsSync(target) || hash(target) !== manifest.sha256)
  throw new Error('Verified platform SDK artifact is missing; provision it during build/release, not runtime')
console.log(JSON.stringify({ name: manifest.name, version: manifest.version, sha256: manifest.sha256, verified: true }))
