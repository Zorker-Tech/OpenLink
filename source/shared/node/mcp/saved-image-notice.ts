export interface SavedImageLocation {
  readonly fileUrl: string
  readonly width?: number | undefined
  readonly height?: number | undefined
}

export function describeSavedImage(image: SavedImageLocation): string {
  const dimensions =
    image.width != null && image.height != null
      ? ` (${image.width}x${image.height})`
      : ""
  return `Image saved at ${image.fileUrl}${dimensions}. To show it to the user, call SendMessage with {"type":"attachment","url":"${image.fileUrl}"}.`
}
