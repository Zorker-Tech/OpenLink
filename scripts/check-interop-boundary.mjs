/**
 * Keep the external wire-schema dependency visible while host modules move behind Slate adapters.
 * The allowlist is intentionally temporary: each module that learns an adapter can be removed from it.
 */
import { readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = path.join(root, "source")
const allowlistPath = path.join(root, "scripts", "interop-proto-consumers.txt")
const coreConsumersPath = path.join(root, "scripts", "interop-core-consumers.txt")
const workProtocolRoot = path.resolve(root, "..", "..", "packages", "work-protocol")

export function compareConsumerAllowlist(actual, allowed) {
  const actualSet = new Set(actual)
  const allowedSet = new Set(allowed)
  return {
    added: [...actualSet].filter((file) => !allowedSet.has(file)).sort(),
    stale: [...allowedSet].filter((file) => !actualSet.has(file)).sort(),
  }
}

export function importedInteropModules(contents) {
  const modules = new Set()
  const pattern = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']*adapters\/interop\/[^"']+)["']/g
  for (const match of contents.matchAll(pattern)) {
    const specifier = match[1]
    if (specifier !== undefined) modules.add(specifier)
  }
  return [...modules].sort()
}

export function coreInteropConsumers(files) {
  return files
    .flatMap(({ relative, contents }) =>
      importedInteropModules(contents).map(module => `${relative}\t${module}`)
    )
    .sort()
}

/** The external plugin MCP schema must be parsed at its interop adapter, not declared by the product package. */
export function declaresPluginMcpInteropSchema(contents) {
  return /\b(?:mcpConfigSchema|mcpServerConfigSchema)\b/.test(contents)
}

/** Foreign plugin manifest paths, platform-version fields and Zod schemas live at the marketplace boundary. */
export function declaresExternalPluginManifestDialect(contents) {
  return /\.cursor-plugin|\.claude-plugin/.test(contents) || /\bcursor\s*:\s*z\./.test(contents) ||
    /(?:PluginManifestSchema|MarketplacePluginEntrySchema|MinClientVersionsSchema)\s*=\s*z\./.test(contents)
}

/** A Slate-owned execution contract may not import or name generated counterpart message surfaces. */
export const importsCounterpartExecutionWire = (contents) => {
  return /\bfrom\s+["']@bufbuild\/protobuf["']/.test(contents)
    || /\bfrom\s+["'][^"']*adapters\/interop\/(?:proto|redacted-protos)\//.test(contents)
    || /\b(?:agent|aiserver)\.v1\./.test(contents)
}

/** Product modules exchange JSON and message contracts of their own; generated protobuf values stay at the edge. */
export const importsExternalProtobufRuntime = (contents) =>
  /\bfrom\s+["']@bufbuild\/protobuf["']/.test(contents)

async function sourceFiles(directory, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    const relative = path.relative(root, absolute).split(path.sep).join("/")
    if (entry.isDirectory()) {
      if (relative === "source/adapters/interop") continue
      await sourceFiles(absolute, output)
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      output.push({ absolute, relative })
    }
  }
  return output
}

async function main() {
  const files = await sourceFiles(sourceRoot)
  const consumers = []
  const coreConsumers = []
  const legacyPaths = []
  const pluginMcpSchemaLeaks = []
  const pluginManifestLeaks = []
  const localExecWireLeaks = []
  const protobufRuntimeLeaks = []
  const ownedLocalExecWireFiles = new Set([
    "source/shared/local-exec-protocol.ts",
    "source/host/local-exec/local-exec-provider.ts",
    "source/local-exec/production-executor.ts",
  ])
  for (const file of files) {
    const contents = await readFile(file.absolute, "utf8")
    for (const imported of importedInteropModules(contents)) {
      coreConsumers.push(`${file.relative}\t${imported}`)
    }
    if (contents.includes("adapters/interop/proto") || contents.includes("adapters/interop/redacted-protos")) {
      consumers.push(file.relative)
    }
    if (contents.includes("packages/proto") || contents.includes("packages/redacted-protos")) {
      legacyPaths.push(file.relative)
    }
    if (declaresPluginMcpInteropSchema(contents)) pluginMcpSchemaLeaks.push(file.relative)
    if (declaresExternalPluginManifestDialect(contents)) pluginManifestLeaks.push(file.relative)
    if (importsExternalProtobufRuntime(contents)) {
      protobufRuntimeLeaks.push(file.relative)
    }
    if (ownedLocalExecWireFiles.has(file.relative) && importsCounterpartExecutionWire(contents)) {
      localExecWireLeaks.push(file.relative)
    }
  }

  coreConsumers.sort()
  const expectedCoreConsumers = "# Slate core imports of interop adapters. Remove entries as they migrate.\n" +
    coreConsumers.join("\n") +
    (coreConsumers.length === 0 ? "" : "\n")
  if (process.argv.includes("--write-baseline")) {
    await writeFile(coreConsumersPath, expectedCoreConsumers)
    console.log(`wrote ${coreConsumers.length} core interop imports across ${new Set(coreConsumers.map(line => line.split("\t")[0])).size} files`)
    return
  }

  const allowed = (await readFile(allowlistPath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
  const difference = compareConsumerAllowlist(consumers, allowed)
  const recordedCoreConsumers = (await readFile(coreConsumersPath, "utf8").catch(() => ""))
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"))
    .sort()
  const coreDifference = compareConsumerAllowlist(coreConsumers, recordedCoreConsumers)

  const protocolFiles = await sourceFiles(workProtocolRoot, [])
  const protocolImports = []
  for (const file of protocolFiles) {
    const contents = await readFile(file.absolute, "utf8")
    if (contents.includes("adapters/interop") || contents.includes("packages/proto")) {
      protocolImports.push(path.relative(workProtocolRoot, file.absolute).split(path.sep).join("/"))
    }
  }

  for (const file of difference.added) console.error("new external wire-schema consumer: " + file)
  for (const file of difference.stale) console.error("remove stale external wire-schema allowlist entry: " + file)
  for (const importRecord of coreDifference.added) console.error("new core interop import: " + importRecord.replace("\t", " -> "))
  for (const importRecord of coreDifference.stale) console.error("remove stale core interop baseline entry: " + importRecord.replace("\t", " -> "))
  for (const file of legacyPaths) console.error("legacy packages/proto path remains in source: " + file)
  for (const file of protocolImports) console.error("Work API contract imports external wire schema: " + file)
  for (const file of pluginMcpSchemaLeaks) console.error("external plugin MCP schema is declared outside the interop adapter: " + file)
  for (const file of pluginManifestLeaks) console.error("external plugin manifest dialect is declared outside the interop adapter: " + file)
  for (const file of protobufRuntimeLeaks) console.error("core imports the external protobuf runtime instead of a Slate contract: " + file)
  for (const file of localExecWireLeaks) console.error("Slate local-exec wire imports counterpart execution types: " + file)

  const problems = difference.added.length + difference.stale.length + coreDifference.added.length +
    coreDifference.stale.length + legacyPaths.length + protocolImports.length +
    pluginMcpSchemaLeaks.length + pluginManifestLeaks.length + localExecWireLeaks.length
    + protobufRuntimeLeaks.length
  if (problems > 0) {
    console.error("interop boundary: " + problems + " problem(s)")
    process.exitCode = 1
    return
  }
  console.log(
    "interop boundary: " + consumers.length + " direct proto consumers tracked; " +
    coreConsumers.length + " core interop imports across " +
    new Set(coreConsumers.map(line => line.split("\t")[0])).size +
    " files; plugin manifest schemas stay in interop",
  )
}

if (import.meta.filename === process.argv[1]) await main()
