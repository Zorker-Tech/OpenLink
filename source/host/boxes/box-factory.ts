/**
 * Which box a host runs on.
 *
 * A box that can open several windows is a shared desktop and one that cannot is reached over its own loopback port,
 * so the host builds the one the machine can actually give it.
 */
import { boxSupportsMultiWindow } from "./box-capabilities.ts";
import { LoopbackBox, type LoopbackBoxOptions } from "./loopback-slate-box.ts";
import { SharedDesktopBox, type SharedDesktopOptions, type SharedInnerBox } from "./shared-desktop-slate-box.ts";
import type { ShellAccessor } from "./box-windows.ts";

export function createBox<Accessor extends ShellAccessor>(options: LoopbackBoxOptions<Accessor>): LoopbackBox<Accessor> { return new LoopbackBox(options); }
export function formatBoxStartupSummary(args: { autoUpdateEnabled: boolean; isPackaged: boolean }): string { return `[slate-host] agent box backend: loopback (in-box); image: host's own container; auto-update: ${args.autoUpdateEnabled ? "on" : "off"}; build: ${args.isPackaged ? "packaged" : "dev"}`; }
export function applySharedDesktop<Accessor extends ShellAccessor>(box: LoopbackBox<Accessor>, options?: SharedDesktopOptions<Accessor>): SharedDesktopBox<Accessor>;
export function applySharedDesktop<Accessor, Box extends SharedInnerBox<Accessor>>(box: Box, options: SharedDesktopOptions<Accessor> = {}): Box | SharedDesktopBox<Accessor> { return boxSupportsMultiWindow(box) ? new SharedDesktopBox(box, options) : box; }
