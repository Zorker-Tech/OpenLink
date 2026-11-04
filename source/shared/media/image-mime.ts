import {
  AUDIO_MIME_FROM_EXTENSION,
  CLIENT_NATIVE_IMAGE_MIME_FROM_EXTENSION,
  EXTENSION_FROM_IMAGE_MIME,
  IMAGE_MIME_FROM_EXTENSION,
  VIDEO_MIME_FROM_EXTENSION,
  extensionOf,
} from "./media-extensions.ts";

type ExtensionLookup = Readonly<Record<string, string>>;

function mediaTypeForPath(filePath: string, supported: ExtensionLookup): string | undefined {
  return supported[extensionOf(filePath)];
}

export function imageMimeFromPath(filePath: string): string | undefined {
  return mediaTypeForPath(filePath, IMAGE_MIME_FROM_EXTENSION);
}

export function servableImageMimeFromPath(filePath: string): string | undefined {
  const webType = mediaTypeForPath(filePath, IMAGE_MIME_FROM_EXTENSION);
  if (webType !== undefined) return webType;
  return mediaTypeForPath(filePath, CLIENT_NATIVE_IMAGE_MIME_FROM_EXTENSION);
}

export function extensionFromImageMime(mime: string): string | undefined {
  return EXTENSION_FROM_IMAGE_MIME[mime.toLowerCase()];
}

export function videoMimeFromPath(filePath: string): string | undefined {
  return mediaTypeForPath(filePath, VIDEO_MIME_FROM_EXTENSION);
}

export function audioMimeFromPath(filePath: string): string | undefined {
  return mediaTypeForPath(filePath, AUDIO_MIME_FROM_EXTENSION);
}
