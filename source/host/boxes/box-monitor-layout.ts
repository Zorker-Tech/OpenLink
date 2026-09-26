/**
 * The coordinate space a box's screen is described in.
 *
 * A box's screen has a fixed size, and a model that clicks or moves has to be told which space its coordinates are in —
 * including the bounds — since coordinates outside the space are not a click somewhere else but a click that cannot
 * happen.
 */
export const SLATE_MONITOR_WIDTH = 1280;
export const SLATE_MONITOR_HEIGHT = 800;
export function displaySpaceSentence({ width = SLATE_MONITOR_WIDTH, height = SLATE_MONITOR_HEIGHT }: { width?: number; height?: number } = {}): string { return `Display is ${width}×${height}. Computer click/move/scroll x,y are pixels in that space (origin top-left); never emit coordinates outside 0..${width - 1} × 0..${height - 1}.`; }
