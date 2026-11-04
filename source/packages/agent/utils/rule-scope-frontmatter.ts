interface ScopeAssignment {
  readonly lineNumber: number
  readonly value: string
}

function frontmatterRows(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n")
  const fence = /^(?:\uFEFF|\s)*---\n/.exec(normalized)
  if (fence === null) return []
  const contentStart = fence[0].length
  const contentEnd = normalized.indexOf("\n---", contentStart)
  return contentEnd < 0 ? [] : normalized.slice(contentStart, contentEnd).split("\n")
}

function leadingWhitespace(line: string): number {
  return /^\s*/.exec(line)?.[0].length ?? 0
}

function readScalar(text: string): string {
  const value = text.trim()
  if (value.length < 2) return value
  const quote = value[0]
  if ((quote === "'" || quote === '"') && value.at(-1) === quote) return value.slice(1, -1).trim()
  return value
}

function readInlineAddresses(value: string): string[] {
  const scalar = readScalar(value)
  const body = scalar.startsWith("[") && scalar.endsWith("]") ? scalar.slice(1, -1) : scalar
  return body.split(",").map(readScalar).filter((address) => address.length > 0)
}

function assignmentInRows(rows: readonly string[]): ScopeAssignment | undefined {
  let metadataIndent: number | undefined
  for (let lineNumber = 0; lineNumber < rows.length; lineNumber += 1) {
    const row = rows[lineNumber] as string
    const flat = /^\s*metadata\.scopedTo\s*:\s*(.*)$/.exec(row)
    if (flat !== null) return { lineNumber, value: flat[1] ?? "" }

    const section = /^(\s*)metadata\s*:\s*$/.exec(row)
    if (section !== null) {
      metadataIndent = section[1]?.length ?? 0
      continue
    }
    if (metadataIndent === undefined) continue
    if (row.trim().length > 0 && leadingWhitespace(row) <= metadataIndent) {
      metadataIndent = undefined
      continue
    }
    const nested = /^\s*scopedTo\s*:\s*(.*)$/.exec(row)
    if (nested !== null) return { lineNumber, value: nested[1] ?? "" }
  }
  return undefined
}

function readFollowingList(rows: readonly string[], propertyLine: number): string[] {
  const indentation = leadingWhitespace(rows[propertyLine] as string)
  const values: string[] = []
  for (let index = propertyLine + 1; index < rows.length; index += 1) {
    const row = rows[index] as string
    if (row.trim().length === 0) continue
    if (leadingWhitespace(row) < indentation) break
    const item = /^\s*-\s*(.+)$/.exec(row)
    if (item?.[1] === undefined) break
    values.push(readScalar(item[1]))
  }
  return values.filter((value) => value.length > 0)
}

/** Read the supported `metadata.scopedTo` spellings without bringing a YAML parser into rule handling. */
export function parseScopedToFromFrontmatter(text: string): string[] {
  const rows = frontmatterRows(text)
  const assignment = assignmentInRows(rows)
  if (assignment === undefined) return []
  if (assignment.value.trim().length > 0) return readInlineAddresses(assignment.value)
  return readFollowingList(rows, assignment.lineNumber)
}
