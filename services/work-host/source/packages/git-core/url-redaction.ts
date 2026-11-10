/** Remove credentials and query data from HTTP links echoed by Git. */

const HTTP_LINK = /https?:\/\/\S+/gi
const TRAILING_SENTENCE_MARK = /[)"'<>,.;:\]}]$/

interface LinkToken {
  readonly address: string
  readonly closingMarks: string
}

function separateClosingMarks(value: string): LinkToken {
  let addressEnd = value.length
  while (addressEnd > 0 && TRAILING_SENTENCE_MARK.test(value.slice(addressEnd - 1, addressEnd))) {
    addressEnd -= 1
  }
  return {
    address: value.slice(0, addressEnd),
    closingMarks: value.slice(addressEnd),
  }
}

function withoutSearchData(address: string): string {
  const queryOrFragment = address.search(/[?#]/)
  return queryOrFragment < 0 ? address : address.slice(0, queryOrFragment)
}

function authorityEnd(address: string, authorityStart: number): number {
  const boundary = address.slice(authorityStart).search(/[/?#]/)
  return boundary < 0 ? address.length : authorityStart + boundary
}

function stripAuthorityCredentials(address: string): string {
  const authorityStart = address.indexOf("//") + 2
  const end = authorityEnd(address, authorityStart)
  const lastAt = address.lastIndexOf("@", end - 1)
  if (lastAt < authorityStart) return address
  return address.slice(0, authorityStart) + address.slice(lastAt + 1)
}

function sanitizeLinkToken(token: string): string {
  const { address, closingMarks } = separateClosingMarks(token)
  return stripAuthorityCredentials(withoutSearchData(address)) + closingMarks
}

export function redactHttpUrlUserinfo(text: string): string {
  return text.replace(HTTP_LINK, sanitizeLinkToken)
}
