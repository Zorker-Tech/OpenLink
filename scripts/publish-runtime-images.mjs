#!/usr/bin/env node
/**
 * Publish locally built OpenLink/ZOKERBASE images to GitLab Generic Package
 * Registry (preferred) or an OCI registry.
 *
 * Image archives are deliberately kept out of Git. This command loads the
 * local docker-save archives, tags them under the configured GitLab project
 * path, and pushes immutable version tags. It never pulls or rebuilds images.
 */
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { ensureDockerEngine } from './lib/docker-runtime.mjs'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const artifactRoot = resolve(root, '.openlink-runtime')
const registry = (process.env.OPENLINK_IMAGE_REGISTRY || 'git.haokir/hydite/openlink/openlink').replace(/\/$/, '')
const packageUrl = (process.env.OPENLINK_IMAGE_PACKAGE_URL || `https://${registry}/api/v4/projects/hydite%2Fopenlink%2Fopenlink/packages/generic/openlink-images/${process.env.OPENLINK_IMAGE_PACKAGE_VERSION || '2026.08.30'}`).replace(/\/$/, '')
const packageToken = process.env.OPENLINK_PACKAGE_TOKEN || process.env.GITLAB_TOKEN
const packageMode = Boolean(packageToken || process.env.OPENLINK_IMAGE_PACKAGE_URL)
const dryRun = process.argv.includes('--dry-run')
let docker

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

async function uploadPackage(file, relativePath) {
  if (!packageToken) throw new Error('Generic Package upload requires OPENLINK_PACKAGE_TOKEN or GITLAB_TOKEN')
  await run('curl', ['-k', '-sS', '--fail-with-body', '--retry', '2', '--retry-delay', '2', '--max-time', '3600', '--upload-file', file, '-H', `PRIVATE-TOKEN: ${packageToken}`, `${packageUrl}/${relativePath}`])
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
  if (packageMode) {
    await uploadPackage(entry.archive, `${entry.namespace}/${entry.archive.split('/').pop()}`)
    process.stdout.write(`${entry.namespace}: uploaded ${entry.archive}\n`)
    continue
  }
  const target = targetName(entry.source)
  docker ??= await ensureDockerEngine()
  await run(docker, ['load', '--input', entry.archive])
  await run(docker, ['tag', entry.source, target])
  await run(docker, ['push', target])
  process.stdout.write(`${entry.namespace}: published ${target}\n`)
}

if (packageMode) process.stdout.write(`Published ${seen.size} runtime images to ${packageUrl}\n`)
else process.stdout.write(`Published ${seen.size} runtime images to ${registry}\n`)
