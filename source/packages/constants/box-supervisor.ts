/**
 * The box supervisor's filesystem contract.
 *
 * Inside a box the platform runs a supervisor that owns the host's lifecycle: it reads commands from
 * a file, writes status and acknowledgements next to it, stages an incoming host bundle before
 * switching to it, and keeps a health record the desktop can read. The paths are shared by the
 * desktop, the supervisor and the host, so they live here rather than in any one of them.
 */

export const BOX_SUPERVISOR_DIR = "/tmp/slate-supervisor"
export const BOX_SUPERVISOR_COMMAND_PATH = `${BOX_SUPERVISOR_DIR}/command.json`
export const BOX_SUPERVISOR_COMMAND_PART_PATH = `${BOX_SUPERVISOR_COMMAND_PATH}.part`
export const BOX_SUPERVISOR_STATUS_PATH = `${BOX_SUPERVISOR_DIR}/status.json`
export const BOX_SUPERVISOR_ACKS_DIR = `${BOX_SUPERVISOR_DIR}/acks`
export const BOX_SUPERVISOR_STAGED_BUNDLE_PATH = `${BOX_SUPERVISOR_DIR}/incoming-host-bundle.tgz`
export const BOX_SUPERVISOR_STAGED_BUNDLE_PART_PATH = `${BOX_SUPERVISOR_STAGED_BUNDLE_PATH}.part`
export const BOX_SUPERVISOR_DESKTOP_HEALTH_PATH = `${BOX_SUPERVISOR_DIR}/desktop-health.json`

export const BOX_AGENT_DATA_ROOT = "/home/box/slate-data"
export const BOX_HOST_UPGRADE_MARKER_PATH = `${BOX_AGENT_DATA_ROOT}/.slate-host-upgrade.json`
export const BOX_HOST_DIR = "/home/box/slate-host"
export const BOX_HOST_ENTRY = `${BOX_HOST_DIR}/host-main.cjs`
export const BOX_HOST_VERSION_PATH = `${BOX_HOST_DIR}/version`

/** How long an upgrade may be deferred before it stops being optional. */
export const HOST_UPGRADE_MAX_DEFER_MS = 6 * 60 * 60 * 1_000

export interface BoxSupervisorCommand {
  readonly id: string
  readonly kind: string
  readonly issuedAtMs: number
  readonly reason?: string
  readonly mode?: string
  readonly version?: string
  readonly bundlePath?: string
  readonly forceNow?: true
}

export interface BuildBoxSupervisorCommandArgs extends Omit<BoxSupervisorCommand, "issuedAtMs"> {
  readonly nowMs: number
}

/**
 * A command is stamped with the time it was issued here, and the upgrade-only fields are only
 * attached to an upgrade: a restart that carried a stale version would be read as an upgrade.
 */
export function buildBoxSupervisorCommand(args: BuildBoxSupervisorCommandArgs): BoxSupervisorCommand {
  const command: {
    id: string
    kind: string
    issuedAtMs: number
    reason?: string
    mode?: string
    version?: string
    bundlePath?: string
    forceNow?: true
  } = { id: args.id, kind: args.kind, issuedAtMs: args.nowMs }
  if (args.reason !== undefined) command.reason = args.reason
  if (args.kind === "upgrade") {
    if (args.mode !== undefined) command.mode = args.mode
    if (args.version !== undefined) command.version = args.version
    if (args.bundlePath !== undefined) command.bundlePath = args.bundlePath
    if (args.forceNow === true) command.forceNow = true
  }
  return command
}

export function serializeBoxSupervisorCommand(command: BoxSupervisorCommand): string {
  return JSON.stringify(command)
}

export function isHostUpgradeAvailable(current: string, target: string | null | undefined): boolean {
  return target != null && target.length > 0 && current !== target
}
