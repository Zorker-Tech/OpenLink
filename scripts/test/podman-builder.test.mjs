import assert from 'node:assert/strict'
import test from 'node:test'
import { isCompletedMachineRemovalError, isSafeIncompleteWindowsBuilder, WINDOWS_ORPHAN_BUILDER_REMOVE_SCRIPT } from '../lib/podman-builder.mjs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const builder = 'openlink-image-builder'
const residue = {
  Name: builder,
  Id: 'ae9097cd-ad12-4faf-822b-e9057f9a63ae',
  State: 'Off',
  DrivePaths: [''],
  NetworkAdapterCount: 0,
}

test('only recognizes an unconfigured, powered-off Hyper-V builder residue as safe to remove', () => {
  assert.equal(isSafeIncompleteWindowsBuilder(residue, builder), true)
  assert.equal(isSafeIncompleteWindowsBuilder({ ...residue, State: 'Running' }, builder), false)
  assert.equal(isSafeIncompleteWindowsBuilder({ ...residue, DrivePaths: ['C:\\disk.vhdx'] }, builder), false)
  assert.equal(isSafeIncompleteWindowsBuilder({ ...residue, NetworkAdapterCount: 1 }, builder), false)
  assert.equal(isSafeIncompleteWindowsBuilder({ ...residue, Name: 'other-vm' }, builder), false)
  assert.match(WINDOWS_ORPHAN_BUILDER_REMOVE_SCRIPT, /Get-VM -Id/)
  assert.match(WINDOWS_ORPHAN_BUILDER_REMOVE_SCRIPT, /Remove-VM -VM \$vm/)
})

test('the default builder reservation remains configurable and Windows-safe', async () => {
  const source = await readFile(fileURLToPath(new URL('../lib/podman-builder.mjs', import.meta.url)), 'utf8')
  assert.match(source, /OPENLINK_BUILD_MEMORY_MB \|\| '6144'/)
  assert.match(source, /OPENLINK_BUILD_MACHINE_INIT_TIMEOUT_MS \|\| 30 \* 60_000/)
})

test('recognizes only the completed gvproxy cleanup race', () => {
  assert.equal(isCompletedMachineRemovalError(new Error('unable to clean up gvproxy: os: process already finished')), true)
  assert.equal(isCompletedMachineRemovalError(new Error('machine is still running')), false)
})
