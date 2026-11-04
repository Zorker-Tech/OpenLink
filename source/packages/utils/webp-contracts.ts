export interface WebpBitmap {
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
}

export interface WebpCodec {
  decode(data: Buffer): Promise<WebpBitmap> | WebpBitmap
  encode(bitmap: WebpBitmap): Promise<Buffer> | Buffer
}

export interface WebpDimensions {
  readonly width: number
  readonly height: number
}
