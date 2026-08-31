import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertWindowsRuntimeDirectoryHyperVAccess,
  hardenUserOnlySecret,
  prepareWindowsRuntimeDirectory,
  RUNTIME_DIRECTORY_ACL_SCRIPT,
  RUNTIME_DIRECTORY_HYPERV_ACCESS_CHECK_SCRIPT,
  USER_ONLY_ACL_SCRIPT,
} from '../lib/windows-security.mjs'

test('Windows secret ACLs are protected and bind only the current SID', async () => {
  const calls = []
  await hardenUserOnlySecret('C:\\runtime\\secret.key', {
    platform: 'win32',
    runner: async (command, args, options) => { calls.push({ command, args, options }) },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'powershell.exe')
  assert.match(calls[0].args.join(' '), /-NonInteractive/)
  assert.match(calls[0].options.env.OPENLINK_ACL_TARGET, /secret\.key$/)
  assert.match(USER_ONLY_ACL_SCRIPT, /SetAccessRuleProtection\(\$true, \$false\)/)
  assert.match(USER_ONLY_ACL_SCRIPT, /WindowsIdentity.*GetCurrent/)
  assert.doesNotMatch(USER_ONLY_ACL_SCRIPT, /Everyone|Authenticated Users/)
})

test('Windows VM builds fail before Hyper-V initialization without the virtual-machine storage ACL', async () => {
  const calls = []
  await assertWindowsRuntimeDirectoryHyperVAccess('C:\\workspace\\.openlink-runtime', {
    platform: 'win32',
    runner: async (command, args, options) => { calls.push({ command, args, options }) },
  })
  assert.equal(calls.length, 1)
  assert.match(RUNTIME_DIRECTORY_HYPERV_ACCESS_CHECK_SCRIPT, /S-1-5-83-0/)
  assert.match(RUNTIME_DIRECTORY_HYPERV_ACCESS_CHECK_SCRIPT, /FullControl/)
  await assert.rejects(() => assertWindowsRuntimeDirectoryHyperVAccess('C:\\workspace\\.openlink-runtime', {
    platform: 'win32', runner: async () => { throw new Error('access denied') },
  }), /Hyper-V VM virtual-account/)
})

test('non-Windows hosts retain their native POSIX mode enforcement', async () => {
  let called = false
  await hardenUserOnlySecret('/runtime/secret.key', { platform: 'darwin', runner: async () => { called = true } })
  assert.equal(called, false)
})

test('elevated Windows preparation makes the runtime user-owned while retaining native Hyper-V service access', async () => {
  const calls = []
  await prepareWindowsRuntimeDirectory('C:\\workspace\\.openlink-runtime', {
    platform: 'win32',
    runner: async (command, args, options) => { calls.push({ command, args, options }) },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'powershell.exe')
  assert.match(calls[0].options.env.OPENLINK_ACL_TARGET, /\.openlink-runtime$/)
  assert.match(RUNTIME_DIRECTORY_ACL_SCRIPT, /SetOwner\(\$userSid\)/)
  assert.match(RUNTIME_DIRECTORY_ACL_SCRIPT, /S-1-5-18/)
  assert.match(RUNTIME_DIRECTORY_ACL_SCRIPT, /S-1-5-32-544/)
  assert.match(RUNTIME_DIRECTORY_ACL_SCRIPT, /S-1-5-83-0/)
  assert.match(RUNTIME_DIRECTORY_ACL_SCRIPT, /virtualMachinesSid/)
  assert.match(RUNTIME_DIRECTORY_ACL_SCRIPT, /ContainerInherit/)
  assert.match(RUNTIME_DIRECTORY_ACL_SCRIPT, /ObjectInherit/)
})
