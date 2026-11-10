/**
 * An avatar's source image: how large it may be, and what kind of file an extension names.
 *
 * An avatar is picked from a file on disk, and the file is checked by its size and by its extension before anything is
 * read: a file over the limit is refused with the notice below, and an extension this platform does not know is handed
 * to the image decoder as a generic binary rather than guessed at.
 */

/** A megabyte, so that the limit below reads as the number of megabytes it is. */
const MEGABYTE = 1024 * 1024;

/** How many megabytes an avatar's source image may be. */
const MAX_SOURCE_MEGABYTES = 25;

/** What the user is told when the image they chose is larger than an avatar may be. */
const AVATAR_TOO_LARGE_NOTICE = "Choose an image smaller than 25 MB.";

/** The type given to a file whose extension this platform does not know. */
const UNKNOWN_AVATAR_MIME = "application/octet-stream";

/** How many bytes an avatar's source image may be. */
export const AVATAR_SOURCE_MAX_BYTES = MAX_SOURCE_MEGABYTES * MEGABYTE;

/** The notice to show for a source image over the limit, or null when the image fits. */
export function avatarSourceSizeError(byteCount: number): string | null {
  return byteCount > AVATAR_SOURCE_MAX_BYTES ? AVATAR_TOO_LARGE_NOTICE : null;
}

/** The extensions an avatar may arrive under, and the image type each one names, in the order they are offered. */
const AVATAR_EXTENSION_TYPES: ReadonlyArray<readonly [string, string]> = [
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
  [".avif", "image/avif"],
  [".svg", "image/svg+xml"],
];

/** The image type each avatar extension names. */
export const AVATAR_EXTENSION_MIME = new Map<string, string>(AVATAR_EXTENSION_TYPES);

/** The type to hand an avatar file by, from its extension; an extension this platform does not know is binary data. */
export function avatarMimeHintForExtension(fileExtension: string): string {
  return AVATAR_EXTENSION_MIME.get(fileExtension.toLowerCase()) ?? UNKNOWN_AVATAR_MIME;
}
