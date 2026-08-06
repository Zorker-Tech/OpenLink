import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { AgentHostError } from './errors.js'

const execFile = promisify(execFileCallback)

const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface ProjectVmMachineSpec {
  cpus: number
  memoryMb: number
  diskGb: number
}

export interface ProjectVmDescriptor {
  projectId: string
  machineName: string
  workspacePath: string
  backend: 'podman-machine'
  status: 'ready'
}

export interface ProjectVmCommandResult {
  stdout: string
  stderr: string
}

export type ProjectVmCommandRunner = (command: string, args: string[]) => Promise<ProjectVmCommandResult>

export interface ProjectVmMachineDriver {
  ensureMachine(name: string, spec: ProjectVmMachineSpec): Promise<void>
  bootstrapToolchain(name: string): Promise<void>
  stopMachine(name: string): Promise<void>
  removeMachine(name: string): Promise<void>
}

export interface PodmanMachineDriverOptions {
  command?: string
  run?: ProjectVmCommandRunner
  bootstrap?: boolean
}

interface CommandError extends Error {
  code?: string | number
  stderr?: string
}

async function runCommand(command: string, args: string[]): Promise<ProjectVmCommandResult> {
  try {
    const result = await execFile(command, args, {
      shell: false,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as CommandError
    const detail = failure.stderr?.trim() || failure.message
    throw new AgentHostError(
      failure.code === 'ENOENT' ? 'BACKEND_NOT_CONFIGURED' : 'PROVISIONING_FAILED',
      `${command} ${args.join(' ')} failed: ${detail}`,
      { retryable: true },
    )
  }
}

function machineState(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown
    const record = Array.isArray(parsed) ? parsed[0] : parsed
    if (!record || typeof record !== 'object') return undefined
    const value = (record as Record<string, unknown>).State
      ?? (record as Record<string, unknown>).state
    return typeof value === 'string' ? value.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

/**
 * Real Podman machine lifecycle. The command runner is injectable only for
 * deterministic unit tests; production always uses execFile with shell=false.
 */
export class PodmanMachineDriver implements ProjectVmMachineDriver {
  private readonly command: string
  private readonly run: ProjectVmCommandRunner
  private readonly bootstrapEnabled: boolean

  constructor(options: PodmanMachineDriverOptions = {}) {
    this.command = options.command ?? 'podman'
    this.run = options.run ?? runCommand
    this.bootstrapEnabled = options.bootstrap ?? true
  }

  async ensureMachine(name: string, spec: ProjectVmMachineSpec): Promise<void> {
    let inspection: ProjectVmCommandResult | undefined
    try {
      inspection = await this.run(this.command, ['machine', 'inspect', name, '--format', 'json'])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/not found|no such machine|does not exist|machine .* not found/i.test(message)) throw error
    }

    if (!inspection) {
      await this.run(this.command, [
        'machine', 'init',
        '--cpus', String(spec.cpus),
        '--memory', String(spec.memoryMb),
        '--disk-size', String(spec.diskGb),
        '--now',
        name,
      ])
    } else if (machineState(inspection.stdout) !== 'running') {
      await this.run(this.command, ['machine', 'start', name])
    }

    if (this.bootstrapEnabled) await this.bootstrapToolchain(name)
  }

  async bootstrapToolchain(name: string): Promise<void> {
    const script = [
      'set -eu',
      'marker="$HOME/.openlink-toolchain-v1"',
      'if [ -f "$marker" ]; then exit 0; fi',
      'if command -v apt-get >/dev/null 2>&1; then',
      '  sudo DEBIAN_FRONTEND=noninteractive apt-get update',
      '  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y git nodejs npm python3 python3-pip build-essential',
      'elif command -v dnf >/dev/null 2>&1; then',
      '  sudo dnf install -y git nodejs npm python3 python3-pip gcc-c++ make',
      'elif command -v apk >/dev/null 2>&1; then',
      '  sudo apk add --no-cache git nodejs npm python3 py3-pip build-base',
      'else',
      '  echo "OpenLink VM has no supported package manager" >&2',
      '  exit 64',
      'fi',
      'if command -v corepack >/dev/null 2>&1; then corepack enable && corepack prepare pnpm@10.12.4 --activate; else sudo npm install --global pnpm@10.12.4; fi',
      'command -v git >/dev/null',
      'command -v node >/dev/null',
      'command -v npm >/dev/null',
      'command -v pnpm >/dev/null',
      'command -v python3 >/dev/null',
      'touch "$marker"',
    ].join('\n')
    await this.run(this.command, ['machine', 'ssh', name, '--', 'bash', '-lc', script])
  }

  async stopMachine(name: string): Promise<void> {
    await this.run(this.command, ['machine', 'stop', name])
  }

  async removeMachine(name: string): Promise<void> {
    await this.run(this.command, ['machine', 'rm', '--force', name])
  }
}

export interface ProjectVmManagerOptions {
  stateRoot: string
  machineDriver: ProjectVmMachineDriver
  machinePrefix?: string
  machineSpec?: ProjectVmMachineSpec
}

export class ProjectVmManager {
  private readonly stateRoot: string
  private readonly machineDriver: ProjectVmMachineDriver
  private readonly machinePrefix: string
  private readonly machineSpec: ProjectVmMachineSpec

  constructor(options: ProjectVmManagerOptions) {
    this.stateRoot = resolve(options.stateRoot)
    this.machineDriver = options.machineDriver
    this.machinePrefix = options.machinePrefix ?? 'openlink-project'
    this.machineSpec = options.machineSpec ?? { cpus: 4, memoryMb: 8_192, diskGb: 64 }
  }

  machineName(projectId: string): string {
    this.assertProjectId(projectId)
    return `${this.machinePrefix}-${projectId.replaceAll('-', '').slice(0, 24)}`
  }

  workspacePath(projectId: string): string {
    this.assertProjectId(projectId)
    return resolve(this.stateRoot, 'projects', projectId, 'workspace')
  }

  async ensure(projectId: string): Promise<ProjectVmDescriptor> {
    this.assertProjectId(projectId)
    const machineName = this.machineName(projectId)
    const workspacePath = this.workspacePath(projectId)
    await mkdir(workspacePath, { recursive: true, mode: 0o700 })
    await this.machineDriver.ensureMachine(machineName, this.machineSpec)
    const descriptor: ProjectVmDescriptor = {
      projectId,
      machineName,
      workspacePath,
      backend: 'podman-machine',
      status: 'ready',
    }
    await writeFile(resolve(this.stateRoot, 'projects', projectId, 'runtime.json'), `${JSON.stringify(descriptor)}\n`, { mode: 0o600 })
    return descriptor
  }

  async stop(projectId: string): Promise<void> {
    await this.machineDriver.stopMachine(this.machineName(projectId))
  }

  async remove(projectId: string): Promise<void> {
    await this.machineDriver.removeMachine(this.machineName(projectId))
  }

  private assertProjectId(projectId: string): void {
    if (!PROJECT_ID_PATTERN.test(projectId)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
  }
}

export function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID_PATTERN.test(value)
}
