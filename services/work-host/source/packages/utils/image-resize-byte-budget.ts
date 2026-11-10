interface ResizableRaster {
  readonly bitmap: { readonly width: number; readonly height: number }
  resize(size: { readonly w: number; readonly h: number }): unknown
}

export interface ResizeTarget {
  readonly width: number
  readonly height: number
  readonly needsResize: boolean
}

/** Apply the dimensional limit first, then reduce both axes until the encoded buffer fits. */
export async function encodeWithinByteLimit(
  image: ResizableRaster,
  target: ResizeTarget,
  encode: () => Promise<Buffer>,
  maxBytes: number,
): Promise<Buffer> {
  let width = target.width
  let height = target.height
  if (target.needsResize) image.resize({ w: width, h: height })

  let output = await encode()
  while (output.length > maxBytes && width > 1 && height > 1) {
    width = Math.max(1, Math.round(width * 0.8))
    height = Math.max(1, Math.round(height * 0.8))
    image.resize({ w: width, h: height })
    output = await encode()
  }
  return output
}
