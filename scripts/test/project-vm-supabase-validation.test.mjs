import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')

test('VM validation proves persistence across a same-disk VM power cycle rather than a new Golden Disk clone', async () => {
  const validation = await readFile(resolve(root, 'scripts/validate-project-vm-supabase.mjs'), 'utf8')
  const e2e = await readFile(resolve(root, 'scripts/e2e-project-supabase.mjs'), 'utf8')
  const verifier = await readFile(resolve(root, 'scripts/verify-project-supabase-persistence.mjs'), 'utf8')
  const persistenceStart = validation.indexOf('e2e smoke passed')
  const persistenceEnd = validation.indexOf('} catch (error)')
  assert.ok(persistenceStart >= 0 && persistenceEnd > persistenceStart)
  const persistence = validation.slice(persistenceStart, persistenceEnd)

  assert.match(validation, /runE2eInVm\(\{ keepFixtures: true \}\)/)
  assert.match(validation, /new PodmanMachineDriver\(/)
  assert.match(validation, /directAppleHv: true/)
  assert.match(validation, /machineDriver\.ensureMachine\(machine,/)
  assert.match(validation, /machineDriver\.runInMachine\(machine, command, args\)/)
  assert.match(validation, /machineDriver\.copyToMachine\(machine,/)
  assert.match(validation, /diskMode: 'thin'/)
  assert.match(validation, /Project VM clone must remain thin/)
  assert.doesNotMatch(validation, /run\(podman, \['machine', 'init', '--image', disk/)
  assert.match(e2e, /OPENLINK_PROJECT_SUPABASE_KEEP_FIXTURES/)
  assert.match(e2e, /!keepFixtures/)
  assert.match(persistence, /machineDriver\.stopMachine\(machine\)/)
  assert.match(persistence, /machineDriver\.ensureMachine\(machine, machineSpec\)/)
  assert.match(persistence, /waitForGuestBootChange\(bootIdBefore\)/)
  assert.match(persistence, /diskAfterPowerCycle\.ino/)
  assert.match(persistence, /guestBootIdChanged: true/)
  assert.match(persistence, /verifyPersistenceInVm\(smoke\.marker\)/)
  assert.doesNotMatch(persistence, /'machine', 'rm'/)
  assert.doesNotMatch(persistence, /'machine', 'init'/)
  assert.match(verifier, /select marker from public\.openlink_e2e_items/)
  assert.match(verifier, /storage\/v1\/object\/authenticated/)
})
