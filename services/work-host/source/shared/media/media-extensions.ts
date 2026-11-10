/**
 * The extensions the platform knows, and the media types they stand for.
 *
 * An extension is read from a name or a path, and the tables go both ways for images — from the extension to the type
 * the platform sends, and from a type back to the extension a file would have — while video and audio are only read
 * one way, since what a surface is handed is the type. The image types a client can render itself are listed apart,
 * because those are passed through rather than converted. Each table is written as its entries and materialized as the
 * record callers read, so an entry is added by adding a pair.
 */

/** A table callers read: an extension or a media type, and the other side of the pair. */
type MediaTable = Readonly<Record<string, string>>;

/** One entry of a table: the key a caller looks up, and the value it gets. */
type TableEntry = readonly [key: string, value: string];

/** A table as the read-only record callers use. */
function tableOf(entries: readonly TableEntry[]): MediaTable {
  return Object.fromEntries(entries);
}

/** The part of a name after its last path separator: the file name on its own. */
function fileNameOf(name: string): string {
  const lastSeparator = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  return name.slice(lastSeparator + 1);
}

/** The extension a file name ends with, lower case, or the empty string when it has none to speak of. */
function extensionOfFileName(fileName: string): string {
  const lastDot = fileName.lastIndexOf(".");
  return lastDot <= 0 ? "" : fileName.slice(lastDot).toLowerCase();
}

/** The extension a name or path ends with, lower case, or the empty string when it has none. */
export function extensionOf(name: string): string {
  return extensionOfFileName(fileNameOf(name));
}

/** The image type each extension stands for. */
export const IMAGE_MIME_FROM_EXTENSION: MediaTable = tableOf([
  [".avif", "image/avif"], [".bmp", "image/bmp"], [".gif", "image/gif"], [".ico", "image/x-icon"], [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"], [".png", "image/png"], [".svg", "image/svg+xml"], [".webp", "image/webp"],
]);

/** The image type each extension stands for when the client converts the image itself. */
export const CLIENT_NATIVE_IMAGE_MIME_FROM_EXTENSION: MediaTable = tableOf([
  [".heic", "image/heic"], [".heif", "image/heif"],
]);

/** The extension a file would carry for each image type. */
export const EXTENSION_FROM_IMAGE_MIME: MediaTable = tableOf([
  ["image/avif", ".avif"], ["image/bmp", ".bmp"], ["image/gif", ".gif"], ["image/jpeg", ".jpg"], ["image/png", ".png"],
  ["image/svg+xml", ".svg"], ["image/webp", ".webp"], ["image/x-icon", ".ico"], ["image/vnd.microsoft.icon", ".ico"],
]);

/** The video type each extension stands for. */
export const VIDEO_MIME_FROM_EXTENSION: MediaTable = tableOf([
  [".m4v", "video/mp4"], [".mov", "video/quicktime"], [".mp4", "video/mp4"], [".ogv", "video/ogg"], [".webm", "video/webm"],
]);

/** The audio type each extension stands for. */
export const AUDIO_MIME_FROM_EXTENSION: MediaTable = tableOf([
  [".aac", "audio/aac"], [".flac", "audio/flac"], [".m4a", "audio/mp4"], [".mp3", "audio/mpeg"], [".oga", "audio/ogg"],
  [".ogg", "audio/ogg"], [".opus", "audio/ogg"], [".wav", "audio/wav"], [".weba", "audio/webm"],
]);
