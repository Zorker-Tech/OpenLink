import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { durableRename, durableWriteFile } from './durable-fs.mjs'

function stateSchema(manifest) {
  const compatibility = manifest?.compatibility
  if (!compatibility || !Number.isSafeInteger(compatibility.stateSchema) || !Number.isSafeInteger(compatibility.minimumStateSchema) || !Number.isSafeInteger(compatibility.maximumStateSchema)) {
    throw new Error('Release state compatibility contract is missing or invalid')
  }
  if (compatibility.minimumStateSchema > compatibility.stateSchema || compatibility.maximumStateSchema < compatibility.stateSchema) throw new Error('Release state compatibility range is invalid')
  return compatibility
}

export function assertUpgradeCompatible(currentManifest, candidateManifest) {
  const current = stateSchema(currentManifest)
  const candidate = stateSchema(candidateManifest)
  if (!Number.isSafeInteger(currentManifest.releaseSequence) || !Number.isSafeInteger(candidateManifest.releaseSequence)
    || candidateManifest.releaseSequence <= currentManifest.releaseSequence) {
    throw new Error(`Candidate release sequence must increase from ${currentManifest.releaseSequence} to a newer value`)
  }
  if (current.stateSchema < candidate.minimumStateSchema || current.stateSchema > candidate.maximumStateSchema) throw new Error(`Candidate release cannot read state schema ${current.stateSchema}`)
  // Schema migrations require a separately declared reversible migration.
  // Until that contract exists, upgrades fail closed instead of mutating data.
  if (candidate.stateSchema !== current.stateSchema) throw new Error(`State schema migration ${current.stateSchema} -> ${candidate.stateSchema} is not declared reversible`)
  if (candidate.stateSchema < current.minimumStateSchema || candidate.stateSchema > current.maximumStateSchema) throw new Error('Current release cannot roll back the candidate state schema')
  return true
}

export function assertRollbackCompatible(currentManifest, targetManifest) {
  const current = stateSchema(currentManifest)
  const target = stateSchema(targetManifest)
  if (!Number.isSafeInteger(currentManifest.releaseSequence) || !Number.isSafeInteger(targetManifest.releaseSequence)
    || targetManifest.releaseSequence >= currentManifest.releaseSequence) {
    throw new Error(`Rollback target sequence must be older than ${currentManifest.releaseSequence}`)
  }
  if (current.stateSchema < target.minimumStateSchema || current.stateSchema > target.maximumStateSchema) {
    throw new Error(`Rollback target cannot read state schema ${current.stateSchema}`)
  }
  if (target.stateSchema !== current.stateSchema) {
    throw new Error(`State schema rollback ${current.stateSchema} -> ${target.stateSchema} is not declared reversible`)
  }
  return true
}

async function writeJournal(stateRoot, value) {
  const directory = join(resolve(stateRoot), 'deployment')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.transaction-${process.pid}-${Date.now()}.tmp`)
  await durableWriteFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await durableRename(temporary, join(directory, 'current.json'))
}

export async function executeUpgradeTransaction(options) {
  const transaction = {
    schemaVersion: 1,
    transactionId: options.transactionId,
    previousReleaseId: options.currentManifest.releaseId,
    candidateReleaseId: options.candidateManifest.releaseId,
    phase: 'planned',
    startedAt: new Date().toISOString(),
  }
  assertUpgradeCompatible(options.currentManifest, options.candidateManifest)
  const record = async (phase, extra = {}) => {
    Object.assign(transaction, extra, { phase, updatedAt: new Date().toISOString() })
    await writeJournal(options.stateRoot, transaction)
  }
  await record('stopping')
  await options.stopService()
  let activated = false
  try {
    await record('backing-up')
    const backup = await options.backup()
    await record('staging', { backup })
    await options.stage()
    await record('activating')
    await options.activate(options.candidateManifest.releaseId)
    activated = true
    await record('starting')
    await options.startService()
    await record('verifying')
    await options.healthCheck(options.candidateManifest.releaseId)
    await record('committed', { committedAt: new Date().toISOString() })
    return transaction
  } catch (error) {
    if (activated) {
      await record('rolling-back', { failure: error instanceof Error ? error.message : String(error) })
      await options.stopService().catch(() => undefined)
      await options.activate(options.currentManifest.releaseId)
      await options.startService()
      await options.healthCheck(options.currentManifest.releaseId)
      await record('rolled-back', { rolledBackAt: new Date().toISOString() })
    } else {
      await record('failed', { failure: error instanceof Error ? error.message : String(error) })
      await options.startService()
      await options.healthCheck(options.currentManifest.releaseId)
    }
    throw error
  }
}

export async function executeRollbackTransaction(options) {
  const transaction = {
    schemaVersion: 1,
    transactionId: options.transactionId,
    previousReleaseId: options.currentManifest.releaseId,
    candidateReleaseId: options.targetManifest.releaseId,
    operation: 'rollback',
    phase: 'planned',
    startedAt: new Date().toISOString(),
  }
  assertRollbackCompatible(options.currentManifest, options.targetManifest)
  const record = async (phase, extra = {}) => {
    Object.assign(transaction, extra, { phase, updatedAt: new Date().toISOString() })
    await writeJournal(options.stateRoot, transaction)
  }
  await record('stopping')
  await options.stopService()
  let activated = false
  try {
    await record('backing-up')
    const backup = await options.backup()
    await record('activating', { backup })
    await options.activate(options.targetManifest.releaseId)
    activated = true
    await record('starting')
    await options.startService()
    await record('verifying')
    await options.healthCheck(options.targetManifest.releaseId)
    await record('committed', { committedAt: new Date().toISOString() })
    return transaction
  } catch (error) {
    if (activated) {
      await record('restoring-current', { failure: error instanceof Error ? error.message : String(error) })
      await options.stopService().catch(() => undefined)
      await options.activate(options.currentManifest.releaseId)
      await options.startService()
      await options.healthCheck(options.currentManifest.releaseId)
      await record('rolled-back', { rolledBackAt: new Date().toISOString() })
    } else {
      await record('failed', { failure: error instanceof Error ? error.message : String(error) })
      await options.startService()
      await options.healthCheck(options.currentManifest.releaseId)
    }
    throw error
  }
}
