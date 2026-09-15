import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import test from 'node:test'

import { detectVirtualization, enableLinuxVirtualization, virtualizationHelp } from '../../deploy/self-hosted/runtime/virtualization.mjs'

function linuxFixture(options = {}) {
  let kvm = options.kvm ?? 'missing'
  let qemu = options.qemu ?? true
  const commands = []
  const access = async (path, mode = constants.F_OK) => {
    if (path.endsWith('qemu-system-x86_64')) {
      if (qemu) return
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    }
    if (path === '/dev/kvm') {
      if (kvm === 'missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      if (mode !== constants.F_OK && kvm !== 'ready') throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return
    }
    if (path.endsWith('modprobe')) return
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  }
  const execFile = async (command, args) => {
    commands.push([command, ...args])
    if (args.includes('kvm')) kvm = 'ready'
    return { stdout: '' }
  }
  return {
    platform: 'linux', architecture: 'x64', root: true, access, execFile,
    readFile: async () => options.cpuinfo ?? 'flags : fpu vmx hypervisor\n',
    installQemu: async () => { commands.push(['install-qemu']); qemu = true },
    commands,
  }
}

test('Container never requires KVM or Apple Hypervisor', async () => {
  assert.deepEqual(await detectVirtualization({ projectRuntime: 'container' }), {
    required: false, status: 'not-required', code: 'CONTAINER_RUNTIME_SELECTED', provider: 'docker', repairable: false,
  })
})

test('Linux reports ready only when QEMU and usable KVM are both present', async () => {
  const fixture = linuxFixture({ kvm: 'ready', qemu: true })
  const result = await detectVirtualization({ ...fixture, projectRuntime: 'vm' })
  assert.equal(result.status, 'ready')
  assert.equal(result.code, 'KVM_READY')
  assert.match(result.qemuPath, /qemu-system-x86_64$/)
})

test('Linux distinguishes inactive modules, permissions, nested virtualization and firmware', async () => {
  assert.equal((await detectVirtualization({ ...linuxFixture({ kvm: 'missing', cpuinfo: 'flags : vmx\n' }), projectRuntime: 'vm' })).code, 'KVM_MODULES_INACTIVE')
  assert.equal((await detectVirtualization({ ...linuxFixture({ kvm: 'denied' }), projectRuntime: 'vm' })).code, 'KVM_PERMISSION_DENIED')
  assert.equal((await detectVirtualization({ ...linuxFixture({ kvm: 'missing', cpuinfo: 'flags : hypervisor\n' }), projectRuntime: 'vm' })).code, 'NESTED_VIRTUALIZATION_UNAVAILABLE')
  assert.equal((await detectVirtualization({ ...linuxFixture({ kvm: 'missing', cpuinfo: 'flags : fpu\n' }), projectRuntime: 'vm' })).code, 'CPU_VIRTUALIZATION_UNAVAILABLE')
  assert.equal((await detectVirtualization({ ...linuxFixture({ kvm: 'missing', qemu: false, cpuinfo: 'flags : hypervisor\n' }), projectRuntime: 'vm' })).code, 'NESTED_VIRTUALIZATION_UNAVAILABLE')
})

test('Linux activation installs QEMU when requested, loads vendor modules and rechecks', async () => {
  const fixture = linuxFixture({ kvm: 'missing', qemu: false, cpuinfo: 'flags : svm\n' })
  const result = await enableLinuxVirtualization(fixture)
  assert.equal(result.status, 'ready')
  assert.deepEqual(fixture.commands[0], ['install-qemu'])
  assert.ok(fixture.commands.some((command) => command.includes('kvm')))
  assert.ok(fixture.commands.some((command) => command.includes('kvm_amd')))
})

test('Apple Hypervisor is built in and cannot be repaired by installation', async () => {
  const ready = await detectVirtualization({ platform: 'darwin', architecture: 'arm64', projectRuntime: 'vm', execFile: async () => ({ stdout: '1\n' }) })
  assert.equal(ready.code, 'APPLEHV_READY')
  const unavailable = await detectVirtualization({ platform: 'darwin', architecture: 'arm64', projectRuntime: 'vm', execFile: async () => ({ stdout: '0\n' }) })
  assert.equal(unavailable.status, 'unsupported')
  assert.equal(unavailable.repairable, false)
  assert.equal(virtualizationHelp(unavailable).guide, 'docs/macos-apple-hypervisor.md')
})
