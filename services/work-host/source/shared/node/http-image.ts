/**
 * Reading an image out of a response without trusting it: the response is an image only when it says so, and the bytes
 * are read up to a limit that is checked against both the declared length and what actually arrives — a response that
 * lies about its size, or sends more than it promised, is refused instead of being read into memory.
 */

const CONTENT_TYPE = "content-type";
const CONTENT_LENGTH = "content-length";
const MEDIA_TYPE_SEPARATOR = ";";
const IMAGE_MEDIA_TYPE = "image/";
const NO_HEADER_VALUE = "";

/** The media type a response declares, with its parameters dropped: `image/png;charset=binary` is `image/png`. */
function mediaTypeDeclaredBy(headers: Headers): string {
  const declared = headers.get(CONTENT_TYPE) ?? NO_HEADER_VALUE;
  const mediaType = declared.split(MEDIA_TYPE_SEPARATOR)[0] ?? NO_HEADER_VALUE;
  return mediaType.trim();
}

export function imageContentType(response: Pick<Response, "headers">): string | null {
  const mediaType = mediaTypeDeclaredBy(response.headers);
  return mediaType.startsWith(IMAGE_MEDIA_TYPE) ? mediaType : null;
}

/** A body read up to a limit, with the stream cancelled when the limit is crossed rather than drained to its end. */
async function readUpTo(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array[] | null> {
  const stream = body.getReader();
  const received: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await stream.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await stream.cancel();
      return null;
    }
    received.push(value);
  }
  return size === 0 ? null : received;
}

export async function readCappedImageBytes(response: Pick<Response, "headers" | "body">, maxBytes: number): Promise<Buffer | null> {
  const promisedBytes = Number(response.headers.get(CONTENT_LENGTH));
  if (Number.isFinite(promisedBytes) && promisedBytes > maxBytes) return null;
  if (response.body == null) return null;
  const chunks = await readUpTo(response.body, maxBytes);
  return chunks == null ? null : Buffer.concat(chunks);
}

/** The bytes as what a renderer can show without another request, or nothing when they could not be had. */
export async function responseToImageDataUrl(response: Response, maxBytes: number): Promise<string | null> {
  if (response.ok === false) return null;
  const mediaType = imageContentType(response);
  if (mediaType == null) return null;
  const bytes = await readCappedImageBytes(response, maxBytes);
  if (bytes == null) return null;
  return `data:${mediaType};base64,${bytes.toString("base64")}`;
}
