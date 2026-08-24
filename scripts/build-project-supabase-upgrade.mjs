import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleFileEntries, releaseKeyId, signBundleManifest, validateBundleManifest, verifyBundleFiles, verifyBundleManifestSignature } from './lib/project-supabase-bundle.mjs'
import { readImageArtifactManifest, targetArchitecture } from './lib/project-supabase-images.mjs'
import { readProjectSupabaseLock } from './lib/project-supabase-lock.mjs'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const architecture = targetArchitecture(process.argv.find((value) => value.startsWith('--architecture='))?.split('=')[1])
const lockPath = resolve(root, 'services/project-supabase/runtime.lock.json')
const lock = await readProjectSupabaseLock(lockPath)
const runtimeRoot = resolve(root, '.openlink-runtime/project-supabase')
const imageRoot = resolve(runtimeRoot, 'images', architecture)
const imageManifestPath = resolve(imageRoot, 'manifest.json')
const outputArgument = process.argv.find((value) => value.startsWith('--output='))?.slice('--output='.length)
const output = resolve(outputArgument || resolve(root, '.openlink-releases/project-supabase', `v${lock.release.version}`, architecture))
const privateKeyPath = process.env.OPENLINK_PROJECT_SUPABASE_SIGNING_KEY_FILE
const publicKeyPath = process.env.OPENLINK_PROJECT_SUPABASE_SIGNING_PUBLIC_KEY_FILE
  || resolve(root, '.openlink-runtime/project-supabase/release-signing/public.pem')
if (!privateKeyPath || !resolve(privateKeyPath).startsWith('/')) throw new Error('OPENLINK_PROJECT_SUPABASE_SIGNING_KEY_FILE must be an absolute release-operator key path')

const imageManifest = await readImageArtifactManifest(imageManifestPath, lock)
const privateKey = await readFile(resolve(privateKeyPath), 'utf8')
const publicKey = await readFile(resolve(publicKeyPath), 'utf8')
const keyId = releaseKeyId(publicKey)
await mkdir(resolve(output, '..'), { recursive: true, mode: 0o700 })
const temporary = await mkdtemp(`${output}.${process.pid}.tmp-`)
try {
  await cp(lockPath, resolve(temporary, 'runtime.lock.json'))
  await cp(resolve(runtimeRoot, 'runtime.spec.json'), resolve(temporary, 'runtime.spec.json'))
  await cp(resolve(runtimeRoot, 'configuration'), resolve(temporary, 'configuration'), { recursive: true, preserveTimestamps: true })
  await cp(imageManifestPath, resolve(temporary, 'image-manifest.json'))
  await mkdir(resolve(temporary, 'images'), { recursive: true, mode: 0o700 })
  for (const image of imageManifest.images) await cp(resolve(imageRoot, image.archive), resolve(temporary, 'images', basename(image.archive)))

  const files = await bundleFileEntries(temporary)
  const digestFor = (path) => files.find((file) => file.path === path)?.sha256
  const manifest = validateBundleManifest({
    schemaVersion: 1,
    product: 'openlink-project-supabase',
    release: { tag: lock.release.tag, commit: lock.release.commit },
    architecture,
    keyId,
    lockSha256: digestFor('runtime.lock.json'),
    runtimeSpecSha256: digestFor('runtime.spec.json'),
    configurationTreeSha256: lock.configuration.treeSha256,
    upgradesSha256: digestFor('configuration/upgrades.json'),
    imageManifestSha256: digestFor('image-manifest.json'),
    files,
  }, lock, architecture)
  const signature = signBundleManifest(manifest, privateKey)
  verifyBundleManifestSignature(manifest, signature, publicKey)
  await writeFile(resolve(temporary, 'bundle.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
  await writeFile(resolve(temporary, 'bundle.signature'), `${signature}\n`, { mode: 0o644 })
  await verifyBundleFiles(temporary, manifest)
  await rm(output, { recursive: true, force: true })
  await mkdir(resolve(output, '..'), { recursive: true, mode: 0o700 })
  await rename(temporary, output)
  process.stdout.write(`${JSON.stringify({ output, release: lock.release.tag, architecture, keyId, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) })}\n`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
