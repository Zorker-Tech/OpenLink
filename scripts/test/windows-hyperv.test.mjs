import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertWindowsHyperVHostReady,
  ENSURE_HYPERV_GROUP_SCRIPT,
  ensureWindowsHyperVGroupMembership,
  inspectWindowsHyperVHost,
  parseHyperVPrepStatus,
} from '../lib/windows-hyperv.mjs'

test('parses Podman Hyper-V preparation without treating a negative membership line as positive', () => {
  assert.deepEqual(parseHyperVPrepStatus('No vsock registry entries found.\nCurrent user is NOT a member'), { groupMember: false, vsockReady: false })
  assert.deepEqual(parseHyperVPrepStatus('Network VSock\nCurrent user is a member'), { groupMember: true, vsockReady: true })
})

test('Hyper-V group preparation resolves the localized built-in group by SID', async () => {
  const calls = []
  await ensureWindowsHyperVGroupMembership({
    platform: 'win32',
    runner: async (...args) => { calls.push(args); return { stdout: '', stderr: '' } },
  })
  assert.equal(calls[0][0], 'powershell.exe')
  assert.match(ENSURE_HYPERV_GROUP_SCRIPT, /S-1-5-32-578/)
  assert.match(ENSURE_HYPERV_GROUP_SCRIPT, /Add-LocalGroupMember/)
  assert.doesNotMatch(ENSURE_HYPERV_GROUP_SCRIPT, /-Group\s+["']Hyper-V Administrators/)
})

test('native Hyper-V readiness requires service, hypervisor, group and persistent VSock setup', async () => {
  const runner = async (command) => command === 'powershell.exe'
    ? { stdout: JSON.stringify({ Elevated: false, HypervisorPresent: true, VmmsStatus: 'Running', Edition: 'Windows 11 Pro' }), stderr: '' }
    : { stdout: 'Network VSock\nCurrent user is a member', stderr: '' }
  const status = await inspectWindowsHyperVHost('podman.exe', { platform: 'win32', runner })
  assert.equal(status.ready, true)
  assert.equal((await assertWindowsHyperVHostReady('podman.exe', { platform: 'win32', runner })).ready, true)
})

test('an elevated process may perform first-use registry setup while unsupported states fail closed', async () => {
  const elevated = async (command) => command === 'powershell.exe'
    ? { stdout: JSON.stringify({ Elevated: true, HypervisorPresent: true, VmmsStatus: 'Running', Edition: 'Windows 11 Pro' }), stderr: '' }
    : { stdout: 'No vsock registry entries found.\nCurrent user is NOT a member', stderr: '' }
  assert.equal((await assertWindowsHyperVHostReady('podman.exe', { platform: 'win32', runner: elevated })).ready, true)

  const unavailable = async (command) => command === 'powershell.exe'
    ? { stdout: JSON.stringify({ Elevated: false, HypervisorPresent: false, VmmsStatus: 'Stopped', Edition: 'Windows Home' }), stderr: '' }
    : { stdout: 'No vsock registry entries found.\nCurrent user is NOT a member', stderr: '' }
  await assert.rejects(() => assertWindowsHyperVHostReady('podman.exe', { platform: 'win32', runner: unavailable }), /active native Hyper-V host/)
})
