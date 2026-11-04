/**
 * Encoding names, normalized to the spellings this platform uses internally.
 *
 * File encodings arrive from many places — a detection library, a user hint, a saved per-file
 * choice — and each spells them differently. Everything is folded to a canonical name here, and the
 * iconv mapping table bridges the canonical names to what a decoder expects.
 */

export const UTF8_ENCODING = "utf8"
export const UTF8_BOM_ENCODING = "utf8bom"
export const LATIN1_ENCODING = "latin1"

const encodingDecoderPairs = [
  ["windows-1250", "cp1250"],
  ["windows-1251", "cp1251"],
  ["windows-1252", "cp1252"],
  ["windows-1253", "cp1253"],
  ["windows-1254", "cp1254"],
  ["windows-1255", "cp1255"],
  ["windows-1256", "cp1256"],
  ["windows-1257", "cp1257"],
  ["windows-1258", "cp1258"],
  ["iso-8859-1", "iso88591"],
  ["iso-8859-2", "iso88592"],
  ["iso-8859-5", "iso88595"],
  ["iso-8859-6", "iso88596"],
  ["iso-8859-7", "iso88597"],
  ["iso-8859-8", "iso88598"],
  ["iso-8859-9", "iso88599"],
  ["iso-8859-15", "iso885915"],
  ["iso-8859-16", "iso885916"],
  ["shift_jis", "shiftjis"],
  ["euc-jp", "eucjp"],
  ["euc-kr", "euckr"],
  ["iso-2022-jp", "iso2022jp"],
  ["iso-2022-kr", "iso2022kr"],
  ["gb2312", "gb2312"],
  ["gbk", "gbk"],
  ["gb18030", "gb18030"],
  ["big5", "big5"],
  ["big5-hkscs", "big5hkscs"],
  ["koi8-r", "koi8r"],
  ["koi8-u", "koi8u"],
  ["ibm855", "cp855"],
  ["ibm866", "cp866"],
  ["maccyrillic", "maccyrillic"],
  ["utf-16le", "utf16le"],
  ["utf-16be", "utf16be"],
  ["utf-32le", "utf32le"],
  ["utf-32be", "utf32be"],
  ["johab", "johab"],
  ["cp949", "cp949"],
  ["cp932", "cp932"],
] as const satisfies readonly (readonly [string, string])[]

export const ENCODING_MAPPINGS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(encodingDecoderPairs),
)

export function mapToIconvEncoding(encoding: string): string {
  return ENCODING_MAPPINGS[encoding] ?? encoding
}

const BYTE_ORDER_MARK = "\ufeff"

export function stripUtf8Bom(text: string): string {
  return text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text
}

const canonicalEncodingNames: ReadonlyMap<string, string> = new Map([
  ["latin-1", LATIN1_ENCODING],
  ["utf-8", UTF8_ENCODING],
  ["utf-8-bom", UTF8_BOM_ENCODING],
  ["utf-8 bom", UTF8_BOM_ENCODING],
])

export function normalizeEncodingName(encoding: string): string {
  const foldedName = encoding.toLowerCase()
  return canonicalEncodingNames.get(foldedName) ?? foldedName
}
