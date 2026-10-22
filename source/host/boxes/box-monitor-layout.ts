/**
 * The coordinate space a box's screen is described in.
 *
 * A box's screen has a fixed size, and a model that clicks or moves has to be told which space its coordinates are in —
 * including the bounds — since coordinates outside the space are not a click somewhere else but a click that cannot
 * happen.
 */

/** The size a box's screen is described in when the caller does not say otherwise. */
export const SLATE_MONITOR_WIDTH = 1280;
export const SLATE_MONITOR_HEIGHT = 800;

/** The space a caller may describe a box's screen in: either side of the default size or neither. */
type DisplaySpace = {
  width?: number;
  height?: number;
};

/** The bounds a coordinate may fall in, given the space's size. */
function coordinateBounds(space: { width: number; height: number }): string {
  return `0..${space.width - 1} × 0..${space.height - 1}`;
}

/** The sentence that tells a model what coordinate space a box's screen has. */
export function displaySpaceSentence(
  { width: requestedWidth = SLATE_MONITOR_WIDTH, height: requestedHeight = SLATE_MONITOR_HEIGHT }: DisplaySpace = {},
): string {
  const bounds = coordinateBounds({ width: requestedWidth, height: requestedHeight });
  return `Display is ${requestedWidth}×${requestedHeight}. Computer click/move/scroll x,y are pixels in that space (origin top-left); never emit coordinates outside ${bounds}.`;
}
