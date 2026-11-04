import type { WebpBitmap, WebpCodec } from "./webp-contracts.ts"

let activeCodec: WebpCodec | undefined

export function registerWebpCodec(registered: WebpCodec): void {
  activeCodec = registered
}

function registeredCodec(): WebpCodec {
  if (activeCodec === undefined) {
    throw new Error(
      "webp codec not registered: registerWebpCodec() must be called by a Node server before decoding/encoding webp",
    )
  }
  return activeCodec
}

export function decodeWebp(data: Buffer): Promise<WebpBitmap> | WebpBitmap {
  return registeredCodec().decode(data)
}

export function encodeWebp(bitmap: WebpBitmap): Promise<Buffer> | Buffer {
  return registeredCodec().encode(bitmap)
}
