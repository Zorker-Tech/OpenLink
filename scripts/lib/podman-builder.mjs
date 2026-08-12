import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const { input, ...spawnOptions } = options
    const child = spawn(command, args, { stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'], shell: false, ...spawnOptions })
    if (input !== undefined) child.stdin.end(input)
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`${command} ${args.join(' ')} exited with ${code ?? signal ?? 'unknown'}`))
    })
  })
}

export function runCapture(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, ...options })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun({ stdout, stderr })
      else rejectRun(new Error(`${command} ${args.join(' ')} exited with ${code ?? signal ?? 'unknown'}: ${stderr.trim()}`))
    })
  })
}

async function cachedMachineImage() {
  const roots = [
    join(process.env.HOME || '', '.local/share/containers/podman/machine/applehv/cache'),
    join(process.env.HOME || '', '.local/share/containers/podman/machine/libkrun/cache'),
  ]
  const candidates = []
  for (const root of roots) {
    try {
      for (const entry of await readdir(root)) {
        if (!entry.endsWith('.raw.zst')) continue
        const path = join(root, entry)
        const metadata = await stat(path)
        if (metadata.isFile() && metadata.size > 0) candidates.push({ path, mtime: metadata.mtimeMs })
      }
    } catch {}
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0]?.path
}

export async function ensurePodmanBuilder(podman, options = {}) {
  if (process.platform === 'linux') {
    await runCapture(podman, ['info'], options)
    return { connectionArgs: [], machineName: null }
  }
  if (process.platform !== 'darwin') {
    throw new Error(`OpenLink's bundled image builder is not implemented for ${process.platform}`)
  }

  const machineName = process.env.OPENLINK_BUILD_MACHINE || 'openlink-image-builder'
  let machineWasRunning = false
  try {
    const machines = JSON.parse((await runCapture(podman, ['machine', 'list', '--format', 'json'], options)).stdout)
    const active = Array.isArray(machines) ? machines.filter((machine) => machine?.Name !== machineName && (machine?.Running || machine?.Starting)) : []
    if (active.length) {
      if (process.env.OPENLINK_STOP_ACTIVE_MACHINES !== '1') {
        throw new Error(`Cannot start dedicated image builder while Project VM(s) are active: ${active.map((machine) => machine.Name).join(', ')}`)
      }
      for (const machine of active) await run(podman, ['machine', 'stop', machine.Name], options)
    }
    const own = Array.isArray(machines) ? machines.find((machine) => machine?.Name === machineName) : undefined
    machineWasRunning = Boolean(own?.Running || own?.Starting)
  } catch (error) {
    if (error instanceof Error && /Cannot start dedicated image builder/.test(error.message)) throw error
  }
  const inspect = async () => runCapture(podman, ['machine', 'inspect', machineName], options)
  await inspect().catch(async () => {
    const image = await cachedMachineImage()
    const imageArgs = image ? ['--image', image] : []
    await run(podman, [
      'machine', 'init', ...imageArgs,
      '--cpus', process.env.OPENLINK_BUILD_CPUS || '4',
      '--memory', process.env.OPENLINK_BUILD_MEMORY_MB || '12288',
      '--disk-size', process.env.OPENLINK_BUILD_DISK_GB || '96',
      machineName,
    ], { ...options, input: options.input ?? 'n\n' })
  })
  const inspection = await inspect()
  if (!/"(?:State|state)"\s*:\s*"running"/i.test(inspection.stdout)) {
    await run(podman, ['machine', 'start', machineName], { ...options, input: options.input ?? 'n\n' })
  }
  await configureBuilderProxy(podman, machineName, options)
  await runCapture(podman, ['--connection', machineName, 'info'], options)
  return { connectionArgs: ['--connection', machineName], machineName, machineWasRunning }
}

function guestProxy(value) {
  if (!value) return undefined
  return value
    .replaceAll('://127.0.0.1:', '://host.containers.internal:')
    .replaceAll('://localhost:', '://host.containers.internal:')
}

async function configureBuilderProxy(podman, machineName, options) {
  const values = [
    ['HTTP_PROXY', guestProxy(process.env.HTTP_PROXY || process.env.http_proxy)],
    ['HTTPS_PROXY', guestProxy(process.env.HTTPS_PROXY || process.env.https_proxy)],
    ['NO_PROXY', process.env.NO_PROXY || process.env.no_proxy],
  ].filter(([, value]) => value)
  if (!values.length) return
  const command = ['systemctl', '--user', 'set-environment', ...values.map(([key, value]) => `${key}=${value}`)]
  await run(podman, ['machine', 'ssh', machineName, command.map((value) => `'${value.replaceAll("'", "'\"'\"'")}'`).join(' ')], options)
  // Some HTTP proxies accept a single large transfer but become unstable when
  // containers/image fans out several OCI layer downloads.  This is a
  // Builder-VM-only setting: the project runtime is unaffected, while image
  // acquisition becomes deterministic through one proxy connection at a time.
  await run(podman, [
    'machine',
    'ssh',
    machineName,
    "mkdir -p ~/.config/containers/containers.conf.d && printf '[engine]\\nimage_parallel_copies = 1\\n' > ~/.config/containers/containers.conf.d/99-openlink-builder.conf",
  ], options)
  await run(podman, ['machine', 'ssh', machineName, "systemctl --user restart podman.service"], options).catch(() => undefined)
}

export async function stopPodmanBuilder(podman, machineName, options = {}) {
  if (!machineName || process.platform === 'linux') return
  await run(podman, ['machine', 'stop', machineName], options).catch(async (error) => {
    // Podman macOS may tear down gvproxy before the machine-stop command
    // receives its final acknowledgement. The machine is already stopped in
    // that state; cleanup must remain idempotent so a completed image build
    // can hand control back to the service supervisor.
    if (/not running|does not exist|not found|process already finished|unable to clean up gvproxy/i.test(error instanceof Error ? error.message : String(error))) return
    try {
      const inspection = await runCapture(podman, ['machine', 'inspect', machineName], options)
      if (!/"(?:State|state)"\s*:\s*"running"/i.test(inspection.stdout)) return
    } catch {
      // A machine that disappears during stop is already safe to clean up.
      return
    }
    throw error
  })
}
