import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sourceManifestPath = join(import.meta.dirname, '../../services/source-revisions.json')

function sourceManifest() {
  const manifest = JSON.parse(readFileSync(sourceManifestPath, 'utf8'))
  if (manifest?.schemaVersion !== 1 || !manifest.services || typeof manifest.services !== 'object') {
    throw new Error('services/source-revisions.json is invalid')
  }
  return manifest.services
}

export function sourceRevision(service) {
  const entry = sourceManifest()[service]
  if (!entry || !/^[a-f0-9]{40}$/.test(entry.sourceCommit)) {
    throw new Error(`Missing source revision for vendored service: ${service}`)
  }
  return entry.sourceCommit
}
