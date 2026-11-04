export const MAX_IMAGE_DIMENSION = 1024
export const MAX_WEBP_IMAGE_DIMENSION = 1280
export const MAX_IMAGE_SIZE_BYTES = 1024 * 1024

export function targetDimensions(
  width: number,
  height: number,
  maxDimension = MAX_IMAGE_DIMENSION,
): { width: number; height: number; needsResize: boolean } {
  let scaledWidth = width
  let scaledHeight = height
  if (width > height) {
    if (width > maxDimension) {
      scaledWidth = maxDimension
      scaledHeight = Math.max(1, Math.round(height * maxDimension / width))
    }
  } else if (height > maxDimension) {
    scaledHeight = maxDimension
    scaledWidth = Math.max(1, Math.round(width * maxDimension / height))
  }
  return {
    width: scaledWidth,
    height: scaledHeight,
    needsResize: scaledWidth !== width || scaledHeight !== height,
  }
}
