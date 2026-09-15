import { execFile as execFileCallback } from 'node:child_process'
import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AgentHostError } from './errors.js'
import type { ProjectVmCommandResult, ProjectVmMachineDriver, ProjectVmMachineSpec } from './project-vm.js'

const execFile = promisify(execFileCallback)

export interface HostDockerProjectDriverOptions {
  command?: string
  execFile?: (command: string, args: string[], options: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>
  stateRoot: string
  immutableSupabaseRoot: string
  supabaseStateRoot?: string
  supabaseReleaseTrust: string
}

/**
 * Host adapter used only by the privileged Project Container broker. It
 * deliberately implements the existing machine boundary so the Project
 * lifecycle above it remains identical, while no VM is created.
 */
export class HostDockerProjectDriver implements ProjectVmMachineDriver {
  private readonly command: string
  private readonly stateRoot: string
  private readonly immutableSupabaseRoot: string
  private readonly supabaseStateRoot: string
  private readonly supabaseReleaseTrust: string
  private readonly execute: NonNullable<HostDockerProjectDriverOptions['execFile']>

  constructor(options: HostDockerProjectDriverOptions) {
    this.command = options.command?.trim() || 'docker'
    this.execute = options.execFile ?? (execFile as unknown as NonNullable<HostDockerProjectDriverOptions['execFile']>)
    this.stateRoot = resolve(options.stateRoot)
    this.immutableSupabaseRoot = resolve(options.immutableSupabaseRoot)
    this.supabaseStateRoot = resolve(options.supabaseStateRoot ?? resolve(this.stateRoot, 'project-supabase'))
    this.supabaseReleaseTrust = resolve(options.supabaseReleaseTrust)
  }

  async ensureMachine(_name: string, _spec: ProjectVmMachineSpec): Promise<void> {
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 })
    await this.run(this.command, ['info', '--format', '{{json .ServerVersion}}'])
  }

  async bootstrapToolchain(_name: string): Promise<void> {}

  async runInMachine(_name: string, command: string, args: string[] = []): Promise<ProjectVmCommandResult> {
    // ProjectRuntimeManager uses sudo only to cross the guest boundary. The
    // dedicated broker is already root, so unwrap that fixed prefix.
    if (command === 'sudo' && args[0] === '-n' && args[1]) return this.runHostCommand(_name, args[1], args.slice(2))
    if (command === 'podman') return this.run(this.command, args)
    return this.runHostCommand(_name, command, args)
  }

  async copyToMachine(name: string, sourcePath: string, destinationPath: string): Promise<void> {
    const destination = this.stagingPath(name, destinationPath)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await copyFile(sourcePath, destination)
    await chmod(destination, 0o600)
  }

  async stopMachine(_name: string): Promise<void> {}

  async removeMachine(_name: string): Promise<void> {
    // ProjectVmManager owns removal of the per-project state directory. Keep
    // this hook non-destructive so it cannot target an unresolved path.
  }

  private runHostCommand(name: string, command: string, args: string[]): Promise<ProjectVmCommandResult> {
    if (command === 'sh' && args[0] === '-c') {
      if (args.length !== 2 || args[1] !== 'mkdir -p /var/lib/openlink && cp /tmp/project-supabase-runtime.mjs /var/lib/openlink/project-supabase-runtime && cp /tmp/project-supabase-bundle.mjs /var/lib/openlink/project-supabase-bundle.mjs && chmod 0755 /var/lib/openlink/project-supabase-runtime') {
        throw new AgentHostError('INVALID_BODY', 'Project Container broker rejected an unexpected shell operation')
      }
      return this.installSupabaseController(name)
    }
    if (command === '/var/lib/openlink/project-supabase-runtime') {
      const append = (flag: string, value: string) => args.includes(flag) ? [] : [flag, value]
      return this.run(process.execPath, [this.controllerPath('project-supabase-runtime'),
        ...args,
        ...append('--state-root', this.supabaseStateRoot),
        ...append('--immutable-root', this.immutableSupabaseRoot),
        ...append('--release-trust', this.supabaseReleaseTrust),
      ], { OPENLINK_PROJECT_CONTAINER_NAMESPACE: String(args[args.indexOf('--project-id') + 1] || '').replaceAll('-', '').slice(0, 16) })
    }
    return this.run(command, args.map((argument) => argument.startsWith('/tmp/') ? this.stagingPath(name, argument) : argument))
  }

  private controllerPath(name: string): string {
    return resolve(this.stateRoot, 'controller', name)
  }

  private stagingPath(machineName: string, guestPath: string): string {
    if (!/^olc-[a-f0-9]{26}$/i.test(machineName) || !guestPath.startsWith('/tmp/') || basename(guestPath) !== guestPath.slice('/tmp/'.length)) {
      throw new AgentHostError('INVALID_BODY', 'Project Container staging path is invalid')
    }
    return resolve(this.stateRoot, 'staging', machineName, basename(guestPath))
  }

  private async installSupabaseController(machineName: string): Promise<ProjectVmCommandResult> {
    const destination = resolve(this.stateRoot, 'controller')
    await mkdir(destination, { recursive: true, mode: 0o700 })
    await copyFile(this.stagingPath(machineName, '/tmp/project-supabase-runtime.mjs'), this.controllerPath('project-supabase-runtime'))
    await copyFile(this.stagingPath(machineName, '/tmp/project-supabase-bundle.mjs'), this.controllerPath('project-supabase-bundle.mjs'))
    await chmod(this.controllerPath('project-supabase-runtime'), 0o700)
    await chmod(this.controllerPath('project-supabase-bundle.mjs'), 0o600)
    return { stdout: '', stderr: '' }
  }

  private async run(command: string, args: string[], extraEnvironment: Record<string, string> = {}): Promise<ProjectVmCommandResult> {
    try {
      const result = await this.execute(command, args, {
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, OPENLINK_PROJECT_CONTAINER_ENGINE: this.command === 'docker' ? 'docker' : 'podman', ...extraEnvironment },
      })
      return { stdout: result.stdout, stderr: result.stderr }
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
      const detail = [failure.stderr?.trim(), failure.stdout?.trim(), failure.message].filter(Boolean).join('; ')
      throw new AgentHostError(failure.code === 'ENOENT' ? 'BACKEND_NOT_CONFIGURED' : 'PROVISIONING_FAILED', `${command} failed: ${detail}`, { retryable: true })
    }
  }
}
