#!/usr/bin/env node
import { access, mkdir, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { ensureDockerEngine, resolveDockerCommand } from './lib/docker-runtime.mjs'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const runtimeRoot = resolve(root, '.openlink-runtime/knowledge/zero')
const composeFile = resolve(root, 'services/zero/openlink/docker-compose.standalone.yml')
const artifactRoot = resolve(root, '.openlink-runtime/knowledge/images')
const artifactManifest = resolve(artifactRoot, 'manifest.json')
const project = process.env.OPENLINK_ZERO_COMPOSE_PROJECT || 'openlink-zero'
const imageVersion = process.env.OPENLINK_ZERO_IMAGE_VERSION || '3.0.0'
const zeroPort = Number(process.env.OPENLINK_ZERO_PORT || 19530)
const healthPort = Number(process.env.OPENLINK_ZERO_HEALTH_PORT || 9091)
let dockerCommand
async function docker() { dockerCommand ||= await resolveDockerCommand(); return dockerCommand }

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: options.cwd || root, env: { ...process.env, ...options.env }, stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    if (!options.inherit) { child.stdout.on('data', (chunk) => { stdout += String(chunk) }); child.stderr.on('data', (chunk) => { stderr += String(chunk) }) }
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolveRun(stdout.trim()) : reject(new Error(`${command} ${args.join(' ')} failed (${code ?? 'signal'}): ${stderr.slice(-4_000)}`)))
  })
}
async function exists(path) { try { await stat(path); return true } catch { return false } }
async function imageExists(reference) { try { await run(await docker(), ['image', 'inspect', reference]); return true } catch { return false } }
async function restoreArtifacts() {
  if (!await exists(artifactManifest)) return
  const manifest = JSON.parse(await readFile(artifactManifest, 'utf8'))
  if (manifest?.product !== 'ZOKERBASE' || manifest?.component !== 'zero' || !Array.isArray(manifest.images)) return
  for (const item of manifest.images) {
    if (typeof item?.image !== 'string' || typeof item?.archive !== 'string' || await imageExists(item.image)) continue
    const archive = resolve(artifactRoot, item.archive)
    try { await access(archive, constants.R_OK); await run(await docker(), ['load', '--input', archive], { inherit: true }) } catch {}
  }
}
async function ensureImages() {
  await restoreArtifacts()
  const missing = []
  for (const image of [`zokerbase/zero:${imageVersion}`, 'zokerbase/zero-etcd:v3.5.25', 'zokerbase/zero-minio:RELEASE.2024-05-28T17-19-04Z']) if (!await imageExists(image)) missing.push(image)
  if (missing.length) throw new Error(`Local ZOKERBASE Zero images are missing: ${missing.join(', ')}. Build once with OPENLINK_ZERO_ALLOW_UPSTREAM_ACQUISITION=1 node scripts/build-zero-images.mjs, then runtime will use only local images.`)
}
async function compose(args, options = {}) {
  const dataRoot = process.env.OPENLINK_ZERO_GUEST_DATA_ROOT || runtimeRoot
  return run(await docker(), ['compose', '--project-name', project, '--file', composeFile, ...args], { cwd: runtimeRoot, env: {
    OPENLINK_ZERO_PORT: String(zeroPort),
    OPENLINK_ZERO_HEALTH_PORT: String(healthPort),
    OPENLINK_ZERO_DATA_ROOT: dataRoot,
    OPENLINK_ZERO_ETCD_SOURCE: process.env.OPENLINK_ZERO_ETCD_SOURCE || `${dataRoot}/etcd`,
    OPENLINK_ZERO_MINIO_SOURCE: process.env.OPENLINK_ZERO_MINIO_SOURCE || `${dataRoot}/minio`,
    OPENLINK_ZERO_ENGINE_SOURCE: process.env.OPENLINK_ZERO_ENGINE_SOURCE || `${dataRoot}/zero`,
    OPENLINK_ZERO_IMAGE_VERSION: imageVersion,
  }, ...options })
}
async function waitHealthy(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { const response = await fetch(`http://127.0.0.1:${healthPort}/healthz`, { signal: AbortSignal.timeout(2_000) }); if (response.ok) return } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
  }
  throw new Error(`Zero did not become healthy within ${timeoutMs / 1_000} seconds`)
}
export async function ensureZero() {
  dockerCommand = await ensureDockerEngine()
  await mkdir(resolve(runtimeRoot, 'etcd'), { recursive: true, mode: 0o700 })
  await mkdir(resolve(runtimeRoot, 'minio'), { recursive: true, mode: 0o700 })
  await mkdir(resolve(runtimeRoot, 'zero'), { recursive: true, mode: 0o700 })
  await ensureImages()
  await compose(['up', '--detach', '--pull', 'never'], { inherit: true })
  await waitHealthy()
  // Health URLs are passed to services as a base origin. Knowledge Service
  // appends the canonical `/healthz` path itself; returning that path here
  // would make the probe request `/healthz/healthz` and fail with 404.
  return { url: `http://127.0.0.1:${zeroPort}`, healthUrl: `http://127.0.0.1:${healthPort}`, project }
}
export async function stopZero() { if (await exists(runtimeRoot)) await compose(['down'], { inherit: true }).catch(() => undefined) }
export async function zeroStatus() { return compose(['ps'], { inherit: true }) }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || 'start'
  if (command === 'start') process.stdout.write(`${JSON.stringify(await ensureZero())}\n`)
  else if (command === 'stop') await stopZero()
  else if (command === 'status') await zeroStatus()
  else throw new Error('Usage: node scripts/zero.mjs [start|stop|status]')
}
