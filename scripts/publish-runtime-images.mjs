#!/usr/bin/env node
/**
 * Publish locally built OpenLink/ZOKERBASE images to an OCI registry.
 *
 * Image archives are deliberately kept out of Git. This command loads the
 * local docker-save archives, tags them under the configured GitLab project
 * path, and pushes immutable version tags. It never pulls or rebuilds images.
 */
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const root = resolve(new URL('..', import.meta.url).pathname)
const artifactRoot = resolve(root, '.openlink-runtime')
const registry = (process.env.OPENLINK_IMAGE_REGISTRY || 'git.haokir/hydite/openlink/openlink').replace(/\/$/, '')
const dryRun = process.argv.includes('--dry-run')

function run(command, args) {
  if (dryRun) {
    process.stdout.write(`[dry-run] ${command} ${args.join(' ')}\n`)
    return Promise.resolve('')
  }
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code) => code === 0
      ? resolveRun(stdout.trim())
      : reject(new Error(`${command} ${args.join(' ')} failed (${code ?? 'signal'}): ${stderr.trim().slice(-3000)}`)))
  })
}

async function readManifest(path) {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'))
}

async function readable(path) {
  try { await access(path, constants.R_OK); return true } catch { return false }
}

function targetName(source) {
  const slash = source.indexOf('/')
  const name = slash === -1 ? source : source.slice(slash + 1)
  return `${registry}/${name}`
}

const entries = []
for (const manifest of [
  ['.openlink-runtime/images/manifest.json', 'openlink'],
  ['.openlink-runtime/zokerbase/images/manifest.json', 'zokerbase'],
  ['.openlink-runtime/knowledge/images/manifest.json', 'zero'],
]) {
  if (!await readable(resolve(root, manifest[0]))) continue
  const data = await readManifest(manifest[0])
  if (data.images && !Array.isArray(data.images)) {
    for (const [source, item] of Object.entries(data.images)) {
      entries.push({ source, archive: resolve(root, item.archive), namespace: manifest[1] })
    }
  } else if (Array.isArray(data.images)) {
    for (const item of data.images) {
      if (typeof item?.image === 'string' && typeof item?.archive === 'string') {
        entries.push({ source: item.image, archive: resolve(root, `.openlink-runtime/${manifest[1] === 'zero' ? 'knowledge/images' : `${manifest[1]}/images`}`, item.archive), namespace: manifest[1] })
      }
    }
  }
}

if (!entries.length) throw new Error('No local image manifests found. Build runtime images before publishing.')

const seen = new Set()
for (const entry of entries) {
  if (seen.has(entry.source)) continue
  seen.add(entry.source)
  if (!await readable(entry.archive)) throw new Error(`Image archive is missing: ${entry.archive}`)
  const target = targetName(entry.source)
  await run('docker', ['load', '--input', entry.archive])
  await run('docker', ['tag', entry.source, target])
  await run('docker', ['push', target])
  process.stdout.write(`${entry.namespace}: published ${target}\n`)
}

process.stdout.write(`Published ${seen.size} runtime images to ${registry}\n`)
