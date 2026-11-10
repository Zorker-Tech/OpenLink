/**
 * Whether a file is a PDF.
 *
 * A PDF is not text, so reading one as text produces noise and the platform has to know before it tries.
 * The magic bytes are the answer when they are there, and the extension is the answer when they are not:
 * a file whose first bytes are not a header may still be a PDF the platform should hand to the reader
 * that understands it, and refusing on the header alone would make it unreadable.
 */

const PDF_HEADER = [37, 80, 68, 70] as const
const PDF_EXTENSION_REGEX = /\.pdf$/i

/** Whether these bytes begin with the four bytes every PDF starts with. */
export function hasPdfMagicBytes(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_HEADER.length) return false
  return PDF_HEADER.every((byte, position) => bytes[position] === byte)
}

/** Whether the name ends in the extension a PDF carries, which is the clue when the header is not there. */
function hasPdfExtension(filePath: string | undefined): boolean {
  return filePath !== undefined && PDF_EXTENSION_REGEX.test(filePath)
}

export function isPdfBinary(bytes: Uint8Array, filePath?: string): boolean {
  return hasPdfMagicBytes(bytes) || hasPdfExtension(filePath)
}
