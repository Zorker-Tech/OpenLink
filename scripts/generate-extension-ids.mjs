import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const sourcePath = path.join(root, "source/host/extensions/extension-ids.data.json")
const outputPath = path.join(root, "source/host/extensions/slate-extension-ids.ts")

function render(entries) {
  const values = entries.map(([, value]) => value)
  for (const [key, value] of entries) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(key)) throw new Error(`invalid extension key: ${key}`)
    if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
      throw new Error(`invalid extension id for ${key}: ${String(value)}`)
    }
  }
  if (new Set(values).size !== values.length) throw new Error("extension ids must be unique")

  const properties = entries.map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`).join("\n")
  return `// Generated from extension-ids.data.json by scripts/generate-extension-ids.mjs. Do not edit.\n` +
    `export const HostExtensions = {\n${properties}\n} as const\n\n` +
    `export type HostExtensionId = (typeof HostExtensions)[keyof typeof HostExtensions]\n`
}

const source = JSON.parse(await readFile(sourcePath, "utf8"))
if (typeof source !== "object" || source === null || Array.isArray(source)) {
  throw new Error("extension id data must be an object")
}
const expected = render(Object.entries(source))

if (process.argv[2] === "check") {
  const actual = await readFile(outputPath, "utf8").catch(() => null)
  if (actual !== expected) {
    console.error("generated extension ids are stale; run pnpm extension-ids:generate")
    process.exitCode = 1
  }
} else {
  await writeFile(outputPath, expected)
  console.log(`wrote ${Object.keys(source).length} extension ids`)
}
