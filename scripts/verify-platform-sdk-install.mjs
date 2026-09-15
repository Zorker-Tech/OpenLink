import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const sdkRoot = resolve(root, 'node_modules/@vtslx/platform-sdk')
const packagePath = resolve(sdkRoot, 'package.json')
const requiredExports = [
  './auth', './product', './project', './workspace', './gateway', './browser',
  './computer', './media', './search', './relay', './pulse', './insight',
  './state', './flow', './vector', './e3', './zero', './kv', './ai-gateway',
  './code-plan', './directory', './terminal', './permissions', './access-policy',
  './access-commands', './access-batch', './access-preview', './admin-access-client',
]

if (!existsSync(packagePath)) throw new Error('Platform SDK is not installed; run pnpm install through the internal npm consumer registry.')
const metadata = JSON.parse(readFileSync(packagePath, 'utf8'))
if (metadata.name !== '@vtslx/platform-sdk' || metadata.version !== '0.2.0' || metadata.engines?.node !== '>=22')
  throw new Error('Unexpected installed Platform SDK identity or Node engine.')

for (const exportName of requiredExports) {
  const descriptor = metadata.exports?.[exportName]
  const importPath = typeof descriptor === 'string' ? descriptor : descriptor?.import
  if (typeof importPath !== 'string' || !existsSync(resolve(sdkRoot, importPath)))
    throw new Error('Installed Platform SDK is missing export ' + exportName + '.')
}

console.log(JSON.stringify({
  name: metadata.name,
  version: metadata.version,
  requiredExports,
  source: 'internal-npm-registry',
  verified: true,
}))
