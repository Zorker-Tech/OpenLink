/**
 * Opening a window on a box that has several.
 *
 * The primary window is the one a box always has, and further windows are opened for the agents that need their own
 * screen; a box with no free monitor refuses rather than sharing one, and each window is reached over its own
 * forwarding port.
 */
import { randomUUID } from "node:crypto";
import type { Context } from "../../packages/context/context.ts";
import {
  shellExecutorResource,
  type ShellExecResponse,
  type ShellExecutor
} from "../../packages/agent-exec/shell.ts";
import { SLATE_BOX_PRIMARY_WINDOW_INDEX, SlateBoxNoMonitorAvailableError, isPrimaryWindowIndex } from "../ports/box.ts";
import { buildHostShellArgs } from "./box-shell-command.ts";

export class BoxWindowError extends Error { constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "BoxWindowError"; } }
export const SLATE_BOX_FORK_ROUTER_PORT = 1339;
export const SLATE_BOX_DISPLAY_HEADER = "x-slate-display";
export const SLATE_BOX_WINDOW_OWNER_HEADER = "x-slate-window-owner";
export const SLATE_BOX_WINDOW_OWNER_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
export const SLATE_BOX_WINDOW_UNAVAILABLE_EXIT_CODE = 75;
export function mintSlateWindowOwnerToken(): string { return randomUUID(); }
export function envInt(name: string, fallback: number, env: Record<string, string | undefined> = process.env): number { const raw = env[name]; if (raw == null || !raw.trim()) return fallback; const value = Number.parseInt(raw.trim(), 10); return Number.isInteger(value) && value > 0 ? value : fallback; }
export const SLATE_BOX_MAX_WINDOWS = envInt("SLATE_BOX_MAX_WINDOWS", 100);
export function boxDisplayToken(windowIndex: number): string { return String(windowIndex); }
export type ShellExecutionResult = ShellExecResponse;
export interface ShellAccessor { get(resource: typeof shellExecutorResource): ShellExecutor }
export async function runWindowScript(ctx: Context, accessor: ShellAccessor, label: string, windowIndex: number, options: { ownerToken?: string; reportGuardRefused?: (stage: string) => void } = {}): Promise<void> { if (isPrimaryWindowIndex(windowIndex)) { options.reportGuardRefused?.(label); return; } const ownerToken = options.ownerToken; if (ownerToken != null && !SLATE_BOX_WINDOW_OWNER_TOKEN_PATTERN.test(ownerToken)) throw new BoxWindowError(`refusing to run ${label} with a malformed owner token`); const command = ownerToken == null ? `/usr/local/bin/${label} ${windowIndex}` : `/usr/local/bin/${label} ${windowIndex} ${ownerToken}`; const result = await accessor.get(shellExecutorResource).execute(ctx, buildHostShellArgs({ command, name: label, workingDirectory: "/workspace", toolCallId: `slate-${label}` })); if (result.result.case !== "success") throw new BoxWindowError(`${label} failed (${result.result.case})`); const { exitCode, stderr } = result.result.value; if (exitCode === SLATE_BOX_WINDOW_UNAVAILABLE_EXIT_CODE) throw new SlateBoxNoMonitorAvailableError(`${label} could not claim display :${windowIndex}: it is a live fork owned by a different agent`); if (exitCode !== 0) throw new BoxWindowError(`${label} exited ${exitCode}: ${stderr}`); }
export async function runStartWindow(ctx: Context, accessor: ShellAccessor, windowIndex: number, ownerToken?: string): Promise<void> { await runWindowScript(ctx, accessor, "start-window", windowIndex, ownerToken == null ? {} : { ownerToken }); }
export async function runStopWindow(ctx: Context, accessor: ShellAccessor, windowIndex: number): Promise<void> { await runWindowScript(ctx, accessor, "stop-window", windowIndex); }
export async function touchSlateMonitorBusyLease(ctx: Context, accessor: ShellAccessor, windowIndex: number): Promise<void> { if (!Number.isInteger(windowIndex) || windowIndex < 1) return; try { await accessor.get(shellExecutorResource).execute(ctx, buildHostShellArgs({ command: `touch /tmp/slate-monitor-busy-${windowIndex}`, name: "touch", workingDirectory: "/workspace", toolCallId: "slate-monitor-busy-lease" })); } catch {} }
export function boxWindowKey(agentId: string, windowIndex: number): string { return `${agentId}#${windowIndex}`; }
export function clearAgentWindowConnections(connections: Map<string, unknown>, agentId: string): void { const prefix = `${agentId}#`; for (const key of connections.keys()) if (key.startsWith(prefix)) connections.delete(key); }
export function primaryBoxWindow<T>(connection: { remoteAccessor: T; vncUrl: string }): { windowIndex: number; computerUse: T; vncUrl: string } { return { windowIndex: SLATE_BOX_PRIMARY_WINDOW_INDEX, computerUse: connection.remoteAccessor, vncUrl: connection.vncUrl }; }
