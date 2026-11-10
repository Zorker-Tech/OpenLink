import { promises as fs } from "node:fs"
import { dirname, join } from "node:path"
import { getSlateRootDir } from "../../host-paths.ts"
import { parseSlateSourceMap } from "./source-map-codec.ts"
import type { SlateSourceMapValue } from "./source-map-contracts.ts"

export function getSourceMapPath(): string {
  return join(getSlateRootDir(), "source-map.json")
}

export async function readSlateSourceMap(filePath: string): Promise<SlateSourceMapValue> {
  try {
    const contents = await fs.readFile(filePath, "utf8")
    return parseSlateSourceMap(JSON.parse(contents) as unknown)
  } catch {
    return Object.create(null) as SlateSourceMapValue
  }
}

export async function writeSlateSourceMap(filePath: string, value: SlateSourceMapValue): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf8")
  await fs.rename(temporaryPath, filePath)
}
