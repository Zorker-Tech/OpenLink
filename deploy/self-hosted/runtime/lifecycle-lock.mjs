import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

async function readOwner(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

export async function acquireRuntimeLock(stateRoot, options = {}) {
  const runRoot = join(resolve(stateRoot), 'run')
  const lockRoot = join(runRoot, 'runtime.lock')
  await mkdir(runRoot, { recursive: true, mode: 0o700 })
  const owner = { schemaVersion: 1, pid: options.pid ?? process.pid, nonce: randomUUID(), startedAt: new Date().toISOString(), releaseId: options.releaseId }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockRoot, { mode: 0o700 })
      await writeFile(join(lockRoot, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      return {
        owner,
        async release() {
          const current = await readOwner(join(lockRoot, 'owner.json'))
          if (current?.nonce === owner.nonce) await rm(lockRoot, { recursive: true, force: true })
        },
      }
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt > 0) throw error
      const existing = await readOwner(join(lockRoot, 'owner.json'))
      const alive = (options.isPidAlive ?? pidAlive)(existing?.pid)
      if (alive) throw new Error(`OpenLink production runtime is already active with PID ${existing.pid}`)
      const stale = join(runRoot, `.runtime.lock.stale-${randomUUID()}`)
      await rename(lockRoot, stale).catch((renameError) => {
        if (renameError?.code !== 'ENOENT') throw renameError
      })
      await rm(stale, { recursive: true, force: true })
    }
  }
  throw new Error('Unable to acquire OpenLink runtime lock')
}

export async function runtimeLockStatus(stateRoot, options = {}) {
  const owner = await readOwner(join(resolve(stateRoot), 'run/runtime.lock/owner.json'))
  if (!owner) return { running: false }
  return { running: (options.isPidAlive ?? pidAlive)(owner.pid), owner }
}
