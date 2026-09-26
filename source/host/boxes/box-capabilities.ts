/**
 * What a box can do, asked of the box when the question arises.
 *
 * Every capability is optional — a box that cannot open several windows simply has one, one that keeps no
 * terminals folder has none — so the host asks rather than assumes, and multi-window support is exactly "more than
 * one".
 */
import { BoxEnvironmentSyncUnsupportedError, BoxMcpUnsupportedError } from "../ports/box.ts";
import type { Context } from "../../packages/context/context.ts";
export interface CapableBox { maxWindows?(): number; getAgentWindowIndex?(agentId: string): number | undefined; getTerminalsFolder?(): string | undefined; isAvailable?(): boolean | Promise<boolean>; isPreparing?(agentId: string): boolean; describe?(): unknown; applyEnvironment?(ctx: Context, update: unknown): Promise<void>; loadMcpServers?(ctx: Context, configJson: string): Promise<unknown>; mcpResourceAccessor?(ctx: Context): Promise<unknown>; }
export function boxMaxWindows(box: CapableBox): number { return box.maxWindows?.() ?? 1; } export function boxSupportsMultiWindow(box: CapableBox): boolean { return boxMaxWindows(box) > 1; } export function boxAgentWindowIndex(box: CapableBox, agentId: string): number | undefined { return box.getAgentWindowIndex?.(agentId); } export function boxTerminalsFolder(box: CapableBox): string | undefined { return box.getTerminalsFolder?.(); } export async function boxIsAvailable(box: CapableBox): Promise<boolean> { return box.isAvailable == null ? true : box.isAvailable(); } export function boxIsPreparing(box: CapableBox, agentId: string): boolean { return box.isPreparing?.(agentId) ?? false; } export function boxDescription(box: CapableBox): unknown { return box.describe?.(); }
export async function boxApplyEnvironment(box: CapableBox, ctx: Context, update: unknown): Promise<void> { if (box.applyEnvironment == null) throw new BoxEnvironmentSyncUnsupportedError(); await box.applyEnvironment(ctx, update); } export async function boxLoadMcpServers(box: CapableBox, ctx: Context, configJson: string): Promise<unknown> { if (box.loadMcpServers == null) throw new BoxMcpUnsupportedError(); return box.loadMcpServers(ctx, configJson); } export async function boxMcpResourceAccessor(box: CapableBox, ctx: Context): Promise<unknown> { if (box.mcpResourceAccessor == null) throw new BoxMcpUnsupportedError(); return box.mcpResourceAccessor(ctx); }
