import { randomUUID } from "node:crypto"
import type { Context } from "../../packages/context/context.ts"
import type { HostShellArgsInput } from "./box-shell-command.ts"
import type {
  BoxWindowShellAccessor,
  BoxWindowShellCommandExecutor,
  SlateWindowShellOutcome,
} from "./box-window-shell-contract.ts"
import { isPrimaryWindowIndex, SLATE_BOX_PRIMARY_WINDOW_INDEX, SlateBoxNoMonitorAvailableError } from "../ports/box.ts"

export class BoxWindowError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "BoxWindowError"
  }
}

export const SLATE_BOX_FORK_ROUTER_PORT = 1339
export const SLATE_BOX_DISPLAY_HEADER = "x-slate-display"
export const SLATE_BOX_WINDOW_OWNER_HEADER = "x-slate-window-owner"
export const SLATE_BOX_WINDOW_OWNER_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/
export const SLATE_BOX_WINDOW_UNAVAILABLE_EXIT_CODE = 75
export type ShellExecutionResult = SlateWindowShellOutcome

export interface ShellAccessor extends BoxWindowShellAccessor {}

export function mintSlateWindowOwnerToken(): string {
  return randomUUID()
}

export function envInt(name: string, fallback: number, env: Record<string, string | undefined> = process.env): number {
  const text = env[name]?.trim()
  if (text == null || text.length === 0) return fallback
  const parsed = Number.parseInt(text, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export const SLATE_BOX_MAX_WINDOWS = envInt("SLATE_BOX_MAX_WINDOWS", 100)

export function boxDisplayToken(windowIndex: number): string {
  return String(windowIndex)
}

function commandForWindow(label: string, windowIndex: number, ownerToken: string | undefined): string {
  return ownerToken == null
    ? `/usr/local/bin/${label} ${windowIndex}`
    : `/usr/local/bin/${label} ${windowIndex} ${ownerToken}`
}

export type {
  BoxWindowShellAccessor,
  BoxWindowShellCommandExecutor,
  SlateWindowShellOutcome,
} from "./box-window-shell-contract.ts"

function assertWindowCommandSucceeded(label: string, windowIndex: number, outcome: SlateWindowShellOutcome): void {
  if (outcome.kind === "not-completed") throw new BoxWindowError(`${label} failed (${outcome.resultKind})`)
  if (outcome.exitCode === SLATE_BOX_WINDOW_UNAVAILABLE_EXIT_CODE) {
    throw new SlateBoxNoMonitorAvailableError(`${label} could not claim display :${windowIndex}: it is a live fork owned by a different agent`)
  }
  if (outcome.exitCode !== 0) throw new BoxWindowError(`${label} exited ${outcome.exitCode}: ${outcome.stderr}`)
}

export async function runWindowScript(
  ctx: Context,
  accessor: ShellAccessor,
  executeWindowCommand: BoxWindowShellCommandExecutor,
  label: string,
  windowIndex: number,
  options: { readonly ownerToken?: string; readonly reportGuardRefused?: (stage: string) => void } = {},
): Promise<void> {
  if (isPrimaryWindowIndex(windowIndex)) {
    options.reportGuardRefused?.(label)
    return
  }
  const ownerToken = options.ownerToken
  if (ownerToken != null && !SLATE_BOX_WINDOW_OWNER_TOKEN_PATTERN.test(ownerToken)) {
    throw new BoxWindowError(`refusing to run ${label} with a malformed owner token`)
  }

  const request: HostShellArgsInput = {
    command: commandForWindow(label, windowIndex, ownerToken),
    name: label,
    workingDirectory: "/workspace",
    toolCallId: `slate-${label}`,
  }
  assertWindowCommandSucceeded(label, windowIndex, await executeWindowCommand(ctx, accessor, request))
}

export async function runStartWindow(
  ctx: Context,
  accessor: ShellAccessor,
  executeWindowCommand: BoxWindowShellCommandExecutor,
  windowIndex: number,
  ownerToken?: string,
): Promise<void> {
  await runWindowScript(
    ctx,
    accessor,
    executeWindowCommand,
    "start-window",
    windowIndex,
    ownerToken == null ? {} : { ownerToken },
  )
}

export async function runStopWindow(
  ctx: Context,
  accessor: ShellAccessor,
  executeWindowCommand: BoxWindowShellCommandExecutor,
  windowIndex: number,
): Promise<void> {
  await runWindowScript(ctx, accessor, executeWindowCommand, "stop-window", windowIndex)
}

export async function touchSlateMonitorBusyLease(
  ctx: Context,
  accessor: ShellAccessor,
  executeWindowCommand: BoxWindowShellCommandExecutor,
  windowIndex: number,
): Promise<void> {
  if (!Number.isInteger(windowIndex) || windowIndex < 1) return
  try {
    await executeWindowCommand(ctx, accessor, {
      command: `touch /tmp/slate-monitor-busy-${windowIndex}`,
      name: "touch",
      workingDirectory: "/workspace",
      toolCallId: "slate-monitor-busy-lease",
    })
  } catch {}
}

export function boxWindowKey(agentId: string, windowIndex: number): string {
  return `${agentId}#${windowIndex}`
}

export function clearAgentWindowConnections(connections: Map<string, unknown>, agentId: string): void {
  const agentPrefix = `${agentId}#`
  for (const key of connections.keys()) {
    if (key.startsWith(agentPrefix)) connections.delete(key)
  }
}

export function primaryBoxWindow<T>(connection: { remoteAccessor: T; vncUrl: string }): {
  windowIndex: number
  computerUse: T
  vncUrl: string
} {
  return {
    windowIndex: SLATE_BOX_PRIMARY_WINDOW_INDEX,
    computerUse: connection.remoteAccessor,
    vncUrl: connection.vncUrl,
  }
}
