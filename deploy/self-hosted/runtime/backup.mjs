import { spawn } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { acquireRuntimeLock, runtimeLockStatus } from './lifecycle-lock.mjs'
import { extractVerifiedTarGzip } from './safe-archive.mjs'
import { durableWriteFile, syncDirectory, syncFile, syncTree } from './durable-fs.mjs'

async function protectedKey(path) {
  const stats = await lstat(path)
  if (!stats.isFile() || (stats.mode & 0o077) !== 0) throw new Error(`Backup key must be a protected 0600 regular file: ${path}`)
  const decoded = Buffer.from((await readFile(path, 'utf8')).trim(), 'base64url')
  if (decoded.length !== 32) throw new Error('Backup key must contain exactly 32 bytes encoded as base64url')
  return decoded
}

async function digestFile(path) {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) { hash.update(chunk); size += chunk.length }
  return { sha256: hash.digest('hex'), size }
}

function tarStream(stateRoot, staging) {
  const portability = process.platform === 'darwin' ? ['--no-xattrs', '--no-mac-metadata', '--no-read-sparse'] : []
  const transform = process.platform === 'darwin'
    ? ['-s', ',^\\.$,state,', '-s', ',^\\./,state/,']
    : ['--transform=s,^\\.$,state,', '--transform=s,^\\./,state/,']
  const child = spawn('tar', [...portability, '-czf', '-', '--exclude=./run', ...transform, '-C', stateRoot, '.', '-C', staging, 'configuration'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, COPYFILE_DISABLE: '1' } })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const completion = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (code) => code === 0 ? resolveExit() : rejectExit(new Error(`Backup tar failed (${code ?? 'signal'}): ${stderr.slice(-4000)}`)))
  })
  return { child, completion }
}

async function validateBackupTree(root) {
  const absoluteRoot = resolve(root)
  async function visit(path) {
    const stats = await lstat(path)
    if (stats.isDirectory()) {
      for (const name of await readdir(path)) await visit(join(path, name))
      return
    }
    if (stats.isFile()) return
    if (stats.isSymbolicLink()) {
      const target = await readlink(path)
      const resolvedTarget = resolve(dirname(path), target)
      if (target.startsWith('/') || resolvedTarget !== absoluteRoot && !resolvedTarget.startsWith(`${absoluteRoot}/`)) {
        throw new Error(`Backup state contains a symbolic link outside the state root: ${path}`)
      }
      return
    }
    throw new Error(`Backup state contains an unsupported filesystem object: ${path}`)
  }
  await visit(absoluteRoot)
}

async function copyProtectedInput(source, destination, secret) {
  const stats = await lstat(source)
  if (!stats.isFile() || (stats.mode & (secret ? 0o027 : 0o022)) !== 0) throw new Error(`Backup input must be a protected regular file: ${source}`)
  await cp(source, destination, { force: false, errorOnExist: true, preserveTimestamps: false })
  await chmod(destination, secret ? 0o600 : 0o640)
}

async function assertStopped(stateRoot) {
  const status = await runtimeLockStatus(stateRoot)
  if (status.running) throw new Error(`A complete backup requires the OpenLink service to be stopped (PID ${status.owner.pid})`)
}

export async function createEncryptedBackup(options = {}) {
  const stateRoot = resolve(options.stateRoot)
  const configPath = resolve(options.configPath)
  const secretsPath = resolve(options.secretsPath)
  const output = resolve(options.output)
  const lifecycle = await acquireRuntimeLock(stateRoot, { releaseId: 'backup' }).catch((error) => {
    throw new Error(`A complete backup requires the OpenLink service to be stopped: ${error.message}`)
  })
  try {
    if (await lstat(output).then(() => true).catch((error) => error?.code === 'ENOENT' ? false : Promise.reject(error))) throw new Error(`Backup output already exists: ${output}`)
    const key = await protectedKey(resolve(options.keyFile))
    const staging = await mkdtemp(join(tmpdir(), 'openlink-backup-stage-'))
    const temporary = `${output}.${process.pid}.tmp`
    try {
      await mkdir(join(staging, 'configuration'), { recursive: true, mode: 0o700 })
      await validateBackupTree(stateRoot)
      await copyProtectedInput(configPath, join(staging, 'configuration/openlink.env'), false)
      await copyProtectedInput(secretsPath, join(staging, 'configuration/secrets.env'), true)
      await mkdir(dirname(output), { recursive: true, mode: 0o700 })
      const salt = randomBytes(16)
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', scryptSync(key, salt, 32), iv)
      const tar = tarStream(stateRoot, staging)
      await Promise.all([
        pipeline(tar.child.stdout, cipher, createWriteStream(temporary, { mode: 0o600, flags: 'wx' })),
        tar.completion,
      ])
      await syncFile(temporary)
      const integrity = await digestFile(temporary)
      const manifest = {
        schemaVersion: 1,
        product: 'OpenLink',
        createdAt: new Date().toISOString(),
        encryption: { algorithm: 'aes-256-gcm', kdf: 'scrypt', salt: salt.toString('base64url'), iv: iv.toString('base64url'), authTag: cipher.getAuthTag().toString('base64url') },
        payload: { file: basename(output), ...integrity },
      }
      await link(temporary, output)
      await syncDirectory(dirname(output))
      await rm(temporary, { force: true })
      await syncDirectory(dirname(output))
      try {
        await durableWriteFile(`${output}.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      } catch (error) {
        await rm(output, { force: true })
        throw error
      }
      return { output, manifestPath: `${output}.json`, manifest }
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  } finally {
    await lifecycle.release()
  }
}

async function assertFresh(path) {
  try {
    const stats = await lstat(path)
    if (!stats.isDirectory() || (await readdir(path)).length) throw new Error(`Restore destination must be a fresh empty directory: ${path}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export async function restoreEncryptedBackup(options = {}) {
  const archive = resolve(options.archive)
  const manifest = JSON.parse(await readFile(resolve(options.manifest ?? `${archive}.json`), 'utf8'))
  if (manifest?.schemaVersion !== 1 || manifest?.product !== 'OpenLink' || manifest?.encryption?.algorithm !== 'aes-256-gcm' || manifest?.encryption?.kdf !== 'scrypt') throw new Error('Backup manifest is invalid or unsupported')
  const integrity = await digestFile(archive)
  if (integrity.sha256 !== manifest.payload?.sha256 || integrity.size !== manifest.payload?.size) throw new Error('Backup payload integrity verification failed')
  const stateRoot = resolve(options.stateRoot)
  const configPath = resolve(options.configPath)
  const secretsPath = resolve(options.secretsPath)
  await assertFresh(stateRoot)
  const lifecycle = await acquireRuntimeLock(stateRoot, { releaseId: 'restore' }).catch((error) => {
    throw new Error(`Restore requires the OpenLink service to be stopped: ${error.message}`)
  })
  try {
  for (const path of [configPath, secretsPath]) {
    if (await lstat(path).then(() => true).catch((error) => error?.code === 'ENOENT' ? false : Promise.reject(error))) throw new Error(`Restore destination already exists: ${path}`)
  }
  const key = await protectedKey(resolve(options.keyFile))
  const work = await mkdtemp(join(tmpdir(), 'openlink-restore-'))
  const plaintext = join(work, 'payload.tar.gz')
  const extracted = join(work, 'extracted')
  try {
    const decipher = createDecipheriv('aes-256-gcm', scryptSync(key, Buffer.from(manifest.encryption.salt, 'base64url'), 32), Buffer.from(manifest.encryption.iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(manifest.encryption.authTag, 'base64url'))
    await pipeline(createReadStream(archive), decipher, createWriteStream(plaintext, { mode: 0o600, flags: 'wx' })).catch((error) => { throw new Error(`Backup authentication failed: ${error.message}`) })
    await extractVerifiedTarGzip(plaintext, extracted, { maximumFiles: options.maximumFiles ?? 500_000, maximumEntries: options.maximumEntries ?? 500_000, allowSafeLinks: true })
    for (const relative of ['state', 'configuration/openlink.env', 'configuration/secrets.env']) {
      if (!await lstat(join(extracted, relative)).then(() => true).catch(() => false)) throw new Error(`Backup is incomplete: ${relative} is missing`)
    }
    for (const name of await readdir(join(extracted, 'state'))) {
      if (name === 'run') continue
      await cp(join(extracted, 'state', name), join(stateRoot, name), { recursive: true, force: false, errorOnExist: true, preserveTimestamps: false, verbatimSymlinks: true })
    }
    await chmod(stateRoot, 0o700)
    await mkdir(dirname(configPath), { recursive: true, mode: 0o750 })
    await cp(join(extracted, 'configuration/openlink.env'), configPath, { force: false, errorOnExist: true })
    await cp(join(extracted, 'configuration/secrets.env'), secretsPath, { force: false, errorOnExist: true })
    await chmod(configPath, 0o640)
    await chmod(secretsPath, 0o600)
    await syncTree(stateRoot)
    await syncFile(configPath)
    await syncFile(secretsPath)
    await syncDirectory(dirname(configPath))
    return { restored: true, stateRoot, configPath, secretsPath }
  } catch (error) {
    await rm(stateRoot, { recursive: true, force: true })
    await rm(configPath, { force: true })
    await rm(secretsPath, { force: true })
    throw error
  } finally {
    await rm(work, { recursive: true, force: true })
  }
  } finally {
    await lifecycle.release()
  }
}
