/**
 * Where the platform draws its own window furniture.
 *
 * The traffic lights on macOS and the title bar on Windows are the platform's to place, and the placement is a
 * constant rather than a measurement; the colour a title bar is given is darkened from the window's background so the
 * two do not fight.
 */
export const TRAFFIC_LIGHTS_AT = { x: 16, y: 15 } as const;

export const TITLE_BAR_BLOCK_PX = 52;

/** The overlay sits one pixel inside the block it covers, so its edge is not the window's edge. */
export const TITLE_BAR_OVERLAY_HEIGHT_PX = TITLE_BAR_BLOCK_PX - 1;

export const COMPUTER_TOP_BAR_PX = 44;
export const COMPUTER_OVERLAY_HEIGHT_PX = COMPUTER_TOP_BAR_PX - 1;

/** The colour a window is assumed to have when nothing readable was given: a neutral dark. */
const ASSUMED_BACKGROUND: readonly [number, number, number] = [24, 24, 24];

/** A `#rrggbb` colour as its three channels, or nothing when it is not written that way. */
function rgbOf(backgroundHex: string): readonly [number, number, number] | undefined {
  if (!/^#[0-9A-Fa-f]{6}$/.test(backgroundHex)) return undefined;
  const hex = backgroundHex.slice(1);
  return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
}

/** One channel as the two hex digits a colour is written with. */
function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0").toUpperCase();
}

/** One channel of a colour laid over another at this alpha. */
function blendChannel(over: number, under: number, alpha: number): number {
  return Math.round(over * alpha + under * (1 - alpha));
}

/** A colour laid over a background colour, as a colour this platform can use. */
export function blendOver(rgb: readonly [number, number, number], alpha: number, backgroundHex: string): string {
  const background = rgbOf(backgroundHex) ?? ASSUMED_BACKGROUND;
  return `#${hexByte(blendChannel(rgb[0], background[0], alpha))}${hexByte(blendChannel(rgb[1], background[1], alpha))}${hexByte(blendChannel(rgb[2], background[2], alpha))}`;
}

/** The height the overlay is given: the computer's top bar when the window draws its own tone, the block otherwise. */
export function overlayHeightFor(isOverlayTone: boolean): number {
  return isOverlayTone ? COMPUTER_OVERLAY_HEIGHT_PX : TITLE_BAR_OVERLAY_HEIGHT_PX;
}

/** The colour the overlay is given: the window's own, or a darkened one when the title bar draws its own tone. */
export function overlayBackgroundFor(themeBackground: string, isOverlayTone: boolean): string {
  if (!isOverlayTone) return themeBackground;
  const cover = blendOver([20, 20, 20], 0.95, themeBackground);
  return blendOver([0, 0, 0], 0.55, cover);
}

/** Perceived brightness, weighted the way a reader sees the three channels. */
function isDark(rgb: readonly [number, number, number]): boolean {
  const [red, green, blue] = rgb;
  return (red * 299 + green * 587 + blue * 114) / 1_000 < 128;
}

/** The colour the overlay's symbols are drawn in, chosen so they can be read on this background. */
export function overlaySymbolColorFor(backgroundHex: string): string {
  return isDark(rgbOf(backgroundHex) ?? ASSUMED_BACKGROUND) ? "#FFFFFF" : "#000000";
}
