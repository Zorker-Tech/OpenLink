/**
 * Coordinates between the display and the API the computer-use surface is driven through.
 *
 * The two are the same picture at different sizes, so a point is scaled up or down between them. A pair of sizes
 * whose aspect ratios differ is not the same picture at all, and is refused rather than scaled into something wrong.
 */
export interface Size {
  width: number;
  height: number;
}

export interface ScreenPair {
  display: Size;
  api: Size;
}

/** How far two aspect ratios may differ before they are not the same picture. */
const ASPECT_TOLERANCE = 0.02;

/** The shape of a picture: its width over its height. */
function aspectRatio(resolution: Size): number {
  return resolution.width / resolution.height;
}

/** One axis' scale from one size to the other. */
function ratio(from: number, to: number): number {
  return from / to;
}

export class PointScaler {
  private readonly upX: number;
  private readonly upY: number;
  private readonly downX: number;
  private readonly downY: number;

  constructor(private readonly config: ScreenPair) {
    const displayRatio = aspectRatio(config.display);
    const apiRatio = aspectRatio(config.api);
    if (Math.abs(displayRatio - apiRatio) > ASPECT_TOLERANCE) {
      throw new Error(`Aspect ratio mismatch: display=${displayRatio.toFixed(3)}, api=${apiRatio.toFixed(3)}`);
    }
    this.upX = ratio(config.display.width, config.api.width);
    this.upY = ratio(config.display.height, config.api.height);
    this.downX = ratio(config.api.width, config.display.width);
    this.downY = ratio(config.api.height, config.display.height);
  }

  /** A point the API knows, as the pixel of the picture the display shows. */
  toDisplay(x: number, y: number): { x: number; y: number } {
    return { x: Math.round(x * this.upX), y: Math.round(y * this.upY) };
  }

  /** A pixel of the picture, as the point the API knows. */
  toApi(x: number, y: number): { x: number; y: number } {
    return { x: Math.round(x * this.downX), y: Math.round(y * this.downY) };
  }

  get apiWidth(): number {
    return this.config.api.width;
  }

  get apiHeight(): number {
    return this.config.api.height;
  }

  get displayWidth(): number {
    return this.config.display.width;
  }

  get displayHeight(): number {
    return this.config.display.height;
  }
}
