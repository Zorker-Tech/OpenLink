import { generateKeyPairSync } from 'node:crypto'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseKeyId } from './lib/project-supabase-bundle.mjs'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const outputRoot = resolve(root, '.openlink-runtime/project-supabase/release-signing')
const privatePath = resolve(outputRoot, 'private.pem')
const publicPath = resolve(outputRoot, 'public.pem')

await mkdir(outputRoot, { recursive: true, mode: 0o700 })
const guard = await open(privatePath, 'wx', 0o600).catch((error) => {
  if (error?.code === 'EEXIST') throw new Error(`Release signing key already exists at ${privatePath}; refusing to rotate implicitly`)
  throw error
})
try {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' })
  await guard.writeFile(privatePem)
  await writeFile(publicPath, publicPem, { mode: 0o644, flag: 'wx' })
  process.stdout.write(`${JSON.stringify({ privateKey: privatePath, publicKey: publicPath, keyId: releaseKeyId(publicPem) })}\n`)
} finally {
  await guard.close()
}
