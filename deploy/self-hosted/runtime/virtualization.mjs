import { constants } from 'node:fs'
import { execFile as execFileCallback } from 'node:child_process'
import { access as fsAccess, readFile as fsReadFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

async function run(command, args, options = {}) {
  const runner = options.execFile ?? execFile
  const result = await runner(command, args, { encoding: 'utf8', timeout: options.timeout ?? 30_000, maxBuffer: 1024 * 1024 })
  return typeof result === 'string' ? result : result?.stdout ?? ''
}

async function readable(path, options, mode = constants.F_OK) {
  try {
    await (options.access ?? fsAccess)(path, mode)
    return true
  } catch {
    return false
  }
}

function linuxQemuBinary(architecture) {
  return architecture === 'arm64' ? 'qemu-system-aarch64' : 'qemu-system-x86_64'
}

async function findExecutable(name, options) {
  const candidates = options.executableCandidates?.[name]
    ?? [`/usr/bin/${name}`, `/usr/local/bin/${name}`, `/bin/${name}`]
  for (const candidate of candidates) {
    if (await readable(candidate, options, constants.X_OK)) return candidate
  }
  return undefined
}

function cpuCapabilities(cpuinfo) {
  const vmx = /(?:^|\s)vmx(?:\s|$)/m.test(cpuinfo)
  const svm = /(?:^|\s)svm(?:\s|$)/m.test(cpuinfo)
  const hypervisor = /(?:^|\s)hypervisor(?:\s|$)/m.test(cpuinfo)
  return { vmx, svm, hypervisor, hardwareVirtualization: vmx || svm }
}

export async function detectVirtualization(options = {}) {
  const platform = options.platform ?? process.platform
  const architecture = options.architecture ?? process.arch
  const runtime = options.projectRuntime ?? 'vm'
  if (runtime === 'container') {
    return { required: false, status: 'not-required', code: 'CONTAINER_RUNTIME_SELECTED', provider: 'docker', repairable: false }
  }
  if (runtime !== 'vm') throw new Error('Virtualization detection requires a concrete container or vm runtime')

  if (platform === 'darwin') {
    let output = ''
    try { output = (await run('/usr/sbin/sysctl', ['-n', 'kern.hv_support'], options)).trim() } catch {}
    if (output === '1') return { required: true, status: 'ready', code: 'APPLEHV_READY', provider: 'applehv', repairable: false }
    return {
      required: true,
      status: 'unsupported',
      code: 'APPLEHV_UNAVAILABLE',
      provider: 'applehv',
      repairable: false,
      message: 'Apple Hypervisor is unavailable; use the Container backend or move to a supported physical Mac',
    }
  }

  if (platform !== 'linux') {
    return { required: true, status: 'unsupported', code: 'HOST_PLATFORM_UNSUPPORTED', provider: 'unknown', repairable: false }
  }

  const readFile = options.readFile ?? fsReadFile
  const cpuinfo = await readFile('/proc/cpuinfo', 'utf8').catch(() => '')
  const cpu = cpuCapabilities(cpuinfo)
  const qemuName = linuxQemuBinary(architecture)
  const qemuPath = await findExecutable(qemuName, options)
  const kvmExists = await readable('/dev/kvm', options)
  const kvmAccessible = kvmExists && await readable('/dev/kvm', options, constants.R_OK | constants.W_OK)

  if (kvmAccessible && qemuPath) {
    return { required: true, status: 'ready', code: 'KVM_READY', provider: 'qemu-kvm', repairable: false, qemuPath, cpu }
  }
  // Do not offer package installation when the underlying host can never
  // expose KVM. Otherwise a nested/cloud host with no QEMU binary looks
  // repairable until after an unnecessary package installation.
  if (!kvmExists && !cpu.hardwareVirtualization && cpu.hypervisor) {
    return {
      required: true,
      status: 'nested-unavailable',
      code: 'NESTED_VIRTUALIZATION_UNAVAILABLE',
      provider: 'qemu-kvm',
      repairable: false,
      qemuPath,
      cpu,
      message: 'The host is virtualized but nested virtualization is not exposed; enable it in the provider or select Container',
    }
  }
  if (!kvmExists && !cpu.hardwareVirtualization) {
    return {
      required: true,
      status: architecture === 'x64' ? 'firmware-disabled' : 'unsupported',
      code: architecture === 'x64' ? 'CPU_VIRTUALIZATION_UNAVAILABLE' : 'KVM_UNAVAILABLE',
      provider: 'qemu-kvm',
      repairable: false,
      qemuPath,
      cpu,
      message: architecture === 'x64'
        ? 'VT-x/AMD-V is unavailable or disabled in firmware; enable it in BIOS/UEFI or select Container'
        : 'KVM is unavailable on this Linux host; select Container or use a KVM-capable host',
    }
  }
  if (!qemuPath) {
    return {
      required: true,
      status: 'repairable',
      code: 'QEMU_MISSING',
      provider: 'qemu-kvm',
      repairable: true,
      cpu,
      kvmExists,
      message: `${qemuName} is not installed; install the supported QEMU host package or select Container`,
    }
  }
  if (kvmExists) {
    return {
      required: true,
      status: 'permission-denied',
      code: 'KVM_PERMISSION_DENIED',
      provider: 'qemu-kvm',
      repairable: true,
      qemuPath,
      cpu,
      message: '/dev/kvm exists but the OpenLink runtime cannot read and write it',
    }
  }
  if (cpu.hardwareVirtualization) {
    return {
      required: true,
      status: 'repairable',
      code: 'KVM_MODULES_INACTIVE',
      provider: 'qemu-kvm',
      repairable: true,
      qemuPath,
      cpu,
      message: 'The CPU exposes hardware virtualization but Linux KVM modules are not active',
    }
  }
  throw new Error('KVM detection reached an inconsistent state')
}

function privileged(command, args, options) {
  if (options.root === true || (options.root === undefined && typeof process.getuid === 'function' && process.getuid() === 0)) return [command, args]
  return [options.sudoCommand ?? '/usr/bin/sudo', ['-n', command, ...args]]
}

async function invokePrivileged(command, args, options) {
  const [executable, finalArgs] = privileged(command, args, options)
  return run(executable, finalArgs, options)
}

async function installQemu(options) {
  if (await readable('/usr/bin/apt-get', options, constants.X_OK)) {
    await invokePrivileged('/usr/bin/apt-get', ['update'], { ...options, timeout: 10 * 60_000 })
    const packageName = (options.architecture ?? process.arch) === 'arm64' ? 'qemu-system-arm' : 'qemu-system-x86'
    await invokePrivileged('/usr/bin/apt-get', ['install', '-y', '--no-install-recommends', packageName, 'qemu-utils'], { ...options, timeout: 15 * 60_000 })
    return
  }
  if (await readable('/usr/bin/dnf', options, constants.X_OK)) {
    const packageName = (options.architecture ?? process.arch) === 'arm64' ? 'qemu-system-aarch64-core' : 'qemu-system-x86-core'
    await invokePrivileged('/usr/bin/dnf', ['install', '-y', packageName, 'qemu-img'], { ...options, timeout: 15 * 60_000 })
    return
  }
  throw new Error('Automatic QEMU installation supports apt or dnf hosts; install QEMU manually or select Container')
}

export async function enableLinuxVirtualization(options = {}) {
  if ((options.platform ?? process.platform) !== 'linux') throw new Error('KVM activation is available only on Linux')
  let detected = await detectVirtualization({ ...options, projectRuntime: 'vm' })
  if (detected.status === 'ready') return detected
  if (!detected.repairable) throw new Error(detected.message ?? `KVM cannot be enabled (${detected.code})`)
  if (detected.code === 'QEMU_MISSING') await (options.installQemu ?? installQemu)(options)

  const readFile = options.readFile ?? fsReadFile
  const cpuinfo = await readFile('/proc/cpuinfo', 'utf8').catch(() => '')
  const cpu = cpuCapabilities(cpuinfo)
  if (!await readable('/usr/sbin/modprobe', options, constants.X_OK) && !await readable('/sbin/modprobe', options, constants.X_OK)) {
    throw new Error('modprobe is unavailable; install the Linux kernel module tools or select Container')
  }
  const modprobe = await readable('/usr/sbin/modprobe', options, constants.X_OK) ? '/usr/sbin/modprobe' : '/sbin/modprobe'
  await invokePrivileged(modprobe, ['kvm'], options)
  if (cpu.vmx) await invokePrivileged(modprobe, ['kvm_intel'], options)
  if (cpu.svm) await invokePrivileged(modprobe, ['kvm_amd'], options)
  if (typeof options.repairPermissions === 'function') await options.repairPermissions()

  detected = await detectVirtualization({ ...options, projectRuntime: 'vm' })
  if (detected.status !== 'ready') throw new Error(detected.message ?? `KVM activation did not succeed (${detected.code})`)
  return detected
}

export function virtualizationHelp(result) {
  const code = result?.code ?? 'VIRTUALIZATION_UNKNOWN'
  return {
    code,
    guide: result?.provider === 'applehv' ? 'docs/macos-apple-hypervisor.md' : 'docs/linux-kvm.md',
    message: result?.message ?? (result?.status === 'ready' ? 'Hardware virtualization is ready' : 'Hardware virtualization is unavailable'),
  }
}
