/**
 * Generates the redacted message surface from the platform's own schema plus the redaction
 * annotations.
 *
 * For every message reachable from an annotated one, this emits a pair of functions: `toRedactedX`
 * turns a plain proto message into one whose sensitive fields are `RedactedString`s (or bytes), and
 * `fromRedactedX` turns it back, asking the redaction layer for a purpose on the way out. Everything
 * else — message nesting, repeated fields, maps, oneofs — is walked so a caller never has to think
 * about which level of a message holds the sensitive field.
 *
 *   pnpm --filter @slate/work-host redaction:generate
 *
 * Inputs: `source/packages/proto/generated/**` (the schema's descriptors, at runtime) and
 * `redaction.json` (which field of which message is redacted, under which classification).
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const protoRoot = path.join(packageRoot, "source", "packages", "proto", "generated")
const outputRoot = path.join(packageRoot, "source", "packages", "redacted-protos", "generated")
const annotationsPath = path.join(packageRoot, "source", "packages", "redacted-protos", "redaction.json")
const surfacePath = path.join(packageRoot, "source", "packages", "redacted-protos", "surface.json")

const CLASSIFICATION = { code: "CODE", path: "PATH", credentials: "CREDENTIALS", provider_info: "PROVIDER_INFO" }

const typeNameOf = value => (typeof value?.typeName === "string" ? value.typeName : undefined)

/** `aiserver.v1.Foo.Bar` → `Foo_Bar`, the suffix protoc-gen-es gives a nested message's export. */
const functionSuffix = typeName => {
  const segments = typeName.split(".")
  return [segments[2], ...segments.slice(3)].join("_")
}

const camelCase = value => value.replace(/_([a-z0-9])/g, (_, letter) => letter.toUpperCase())

async function loadSchema() {
  const messages = new Map()
  const modules = new Map()
  for (const namespace of (await readdir(protoRoot)).sort()) {
    const directory = path.join(protoRoot, namespace, "v1")
    const entries = (await readdir(directory)).filter(name => name.endsWith("_pb.ts")).sort()
    for (const entry of entries) {
      const module = await import(pathToFileURL(path.join(directory, entry)).href)
      const protoName = `${namespace}/v1/${entry}`
      modules.set(protoName, { protoName, messages: [] })
      for (const value of Object.values(module)) {
        const typeName = typeNameOf(value)
        if (typeName === undefined || typeof value !== "function" || value.fields === undefined) continue
        if (messages.has(typeName)) continue
        const fields = value.fields.list().map(field => ({
          name: field.name,
          property: field.jsonName ?? camelCase(field.name),
          kind: field.kind,
          repeated: field.repeated === true,
          oneof: field.oneof !== undefined && field.oneof !== null && field.oneof.kind === "oneof"
            ? field.oneof.name
            : undefined,
          reference: typeof field.T === "number" ? undefined : typeNameOf(field.T),
          key: field.kind === "map" ? field.K : undefined,
          value: field.kind === "map" ? field.V : undefined,
        }))
        messages.set(typeName, { typeName, protoName, fields })
        modules.get(protoName).messages.push(typeName)
      }
    }
  }
  return { messages, modules }
}

/** Messages reachable from an annotated one, plus every module that ends up carrying a function. */
function closureOf(annotations, messages) {
  const needed = new Set()
  const pending = Object.keys(annotations)
  while (pending.length > 0) {
    const typeName = pending.pop()
    if (needed.has(typeName)) continue
    const message = messages.get(typeName)
    if (message === undefined) continue
    needed.add(typeName)
    for (const field of message.fields) {
      if (field.reference !== undefined && !field.reference.startsWith("google.protobuf.")) pending.push(field.reference)
      if (field.value !== undefined && field.value.kind !== "scalar") {
        const reference = typeNameOf(field.value.T)
        if (reference !== undefined) pending.push(reference)
      }
    }
  }
  return needed
}

const isRedacted = (annotations, typeName, field) => annotations[typeName]?.[field.name]

/** `createRedactedString(expression, DataClassification.X, "field_name", privacyMode)`. */
function wrapRedacted(annotation, expression, field) {
  const classification = `DataClassification.${CLASSIFICATION[annotation.classification]}`
  const factory = annotation.bytes === true ? "createRedactedBytes" : "createRedactedString"
  return `${factory}(${expression}, ${classification}, ${JSON.stringify(field.name)}, privacyMode)`
}

function unwrapRedacted(expression) {
  return `${expression}.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing })`
}

/** The oneof member transform, shared by both directions so the two cannot drift apart. */
function oneofMember(message, field, annotations, direction, expression) {
  const annotation = isRedacted(annotations, message.typeName, field)
  if (annotation !== undefined) {
    if (direction === "to") return wrapRedacted(annotation, expression, field)
    return unwrapRedacted(expression)
  }
  const reference = field.kind === "message" ? field.reference : undefined
  if (reference !== undefined && !reference.startsWith("google.protobuf.")) {
    const fn = `${direction === "to" ? "toRedacted" : "fromRedacted"}${functionSuffix(reference)}`
    return direction === "to" ? `${fn}(${expression}, privacyMode)` : `${fn}(${expression}, purpose, opts)`
  }
  return expression
}

function renderField(message, field, annotations, direction, lines, indent) {
  const ts = `msg.${field.property}`
  const entry = isRedacted(annotations, message.typeName, field)
  const annotation = entry?.classification === undefined ? undefined : entry
  const keyAnnotation = entry?.key
  const valueAnnotation = entry?.value
  const mapValue = field.kind === "map" ? field.value : undefined
  // A map whose values (or keys) are redacted: the map survives, its entries do not.
  if (entry !== undefined && annotation === undefined && (field.kind === "map" || field.repeated)) {
    const key = keyAnnotation === undefined
      ? "k2"
      : (direction === "to" ? wrapRedacted(keyAnnotation, "k2", field) : unwrapRedacted("k2"))
    const value = valueAnnotation === undefined
      ? "v2"
      : (direction === "to" ? wrapRedacted(valueAnnotation, "v2", field) : unwrapRedacted("v2"))
    if (field.kind === "map") {
      lines.push(direction === "to"
        ? `${indent}${field.property}: new Map(Object.entries(${ts}).map(([k2, v2]) => [${key}, ${value}])),`
        : `${indent}${field.property}: Object.fromEntries(Array.from(${ts}.entries()).map(([k2, v2]) => [${key}, ${value}])),`)
    } else {
      lines.push(direction === "to"
        ? `${indent}${field.property}: ${ts}.map((v2) => ${value}),`
        : `${indent}${field.property}: ${ts}.map((v2) => ${value}),`)
    }
    return
  }
  if (annotation !== undefined) {
    if (field.repeated) {
      const entry = direction === "to" ? wrapRedacted(annotation, "v2", field) : unwrapRedacted("v2")
      lines.push(`${indent}${field.property}: ${ts}.map((v2) => ${entry}),`)
      return
    }
    lines.push(`${indent}${field.property}: ${direction === "to" ? wrapRedacted(annotation, ts, field) : unwrapRedacted(ts)},`)
    return
  }
  if (field.kind === "map" && mapValue !== undefined && mapValue.kind !== "scalar") {
    const reference = typeNameOf(mapValue.T)
    const keyAnnotation = annotations[message.typeName]?.[field.name]
    const key = direction === "to" ? `k2` : unwrapRedacted("k2")
    const value = reference !== undefined && !reference.startsWith("google.protobuf.")
      ? `${direction === "to" ? "toRedacted" : "fromRedacted"}${functionSuffix(reference)}(v2${direction === "to" ? ", privacyMode" : ", purpose, opts"})`
      : "v2"
    if (direction === "to") {
      lines.push(`${indent}${field.property}: new Map(Object.entries(${ts}).map(([k2, v2]) => [${key}, ${value}])),`)
    } else {
      lines.push(`${indent}${field.property}: Object.fromEntries(Array.from(${ts}.entries()).map(([k2, v2]) => [${key}, ${value}])),`)
    }
    void keyAnnotation
    return
  }
  if (field.kind === "map") {
    const keyAnnotation = annotations[message.typeName]?.[`${field.name}.key`]
    const key = keyAnnotation !== undefined && direction === "to" ? wrapRedacted(keyAnnotation, "k2", field) : direction === "to" ? "k2" : unwrapRedacted("k2")
    lines.push(`${indent}${field.property}: ${direction === "to"
      ? `new Map(Object.entries(${ts}).map(([k2, v2]) => [${key}, v2])),`
      : `Object.fromEntries(Array.from(${ts}.entries()).map(([k2, v2]) => [${key}, v2])),`}`)
    return
  }
  const reference = field.kind === "message" ? field.reference : undefined
  if (reference !== undefined && !reference.startsWith("google.protobuf.")) {
    const fn = `${direction === "to" ? "toRedacted" : "fromRedacted"}${functionSuffix(reference)}`
    if (field.repeated) {
      lines.push(`${indent}${field.property}: ${ts}.map((v2) => ${fn}(v2${direction === "to" ? ", privacyMode" : ", purpose, opts"})),`)
      return
    }
    if (field.oneof !== undefined) return
    const call = direction === "to" ? `${fn}(${ts}, privacyMode)` : `${fn}(${ts}, purpose, opts)`
    lines.push(`${indent}${field.property}: ${ts} !== void 0 ? ${call} : void 0,`)
    return
  }
  lines.push(`${indent}${field.property}: ${ts},`)
}

function renderOneof(message, oneofName, members, annotations, direction, lines) {
  const suffix = `${functionSuffix(message.typeName)}_${oneofName}`
  const name = `${direction === "to" ? "toRedacted" : "fromRedacted"}${suffix}`
  lines.push(`function ${name}(oneof, ${direction === "to" ? "privacyMode" : "purpose, opts"}) {`)
  if (direction === "from") {
    lines.push("  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;")
    lines.push("  const enforcing = opts?.enforcing;")
  }
  lines.push("  if (oneof === void 0) {")
  lines.push("    return { case: void 0, value: void 0 };")
  lines.push("  }")
  lines.push("  switch (oneof.case) {")
  for (const field of members) {
    // A oneof case is named by the field's property, which is what protoc-gen-es writes into it.
    lines.push(`    case ${JSON.stringify(field.property)}:`)
    const expression = oneofMember(message, field, annotations, direction, "oneof.value")
    lines.push(`      return { case: ${JSON.stringify(field.property)}, value: ${expression} };`)
  }
  lines.push("    default:")
  lines.push("      return { case: void 0, value: void 0 };")
  lines.push("  }")
  lines.push("}")
}

function renderMessage(message, annotations, direction, lines) {
  const suffix = functionSuffix(message.typeName)
  const name = `${direction === "to" ? "toRedacted" : "fromRedacted"}${suffix}`
  lines.push(`function ${name}(msg, ${direction === "to" ? "privacyMode" : "purpose, opts"}) {`)
  if (direction === "from") {
    lines.push("  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;")
    lines.push("  const enforcing = opts?.enforcing;")
  }
  lines.push(direction === "to" ? "  return {" : `  return new ${suffix}({`)
  if (direction === "to") lines.push("    _privacyMode: privacyMode,")
  const oneofs = new Map()
  for (const field of message.fields) {
    if (field.oneof !== undefined) {
      if (!oneofs.has(field.oneof)) oneofs.set(field.oneof, [])
      oneofs.get(field.oneof).push(field)
      continue
    }
    renderField(message, field, annotations, direction, lines, "    ")
  }
  for (const [oneofName, members] of oneofs) {
    const property = camelCase(oneofName)
    const fn = `${direction === "to" ? "toRedacted" : "fromRedacted"}${functionSuffix(message.typeName)}_${oneofName}`
    lines.push(`    ${property}: ${fn}(msg.${property}${direction === "to" ? ", privacyMode" : ", purpose, opts"}),`)
  }
  lines.push(direction === "to" ? "  };" : "  });")
  lines.push("}")
}

function renderModule(module, messages, annotations, needed) {
  const declared = module.messages.filter(typeName => needed.has(typeName))
  const lines = []
  lines.push("// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the")
  lines.push("// declaration pass for these modules is a separate mechanical step.")
  lines.push("//")
  lines.push("// @generated from this repository's schema and redaction annotations. Do not edit.")
  lines.push("//")
  lines.push("// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.")
  lines.push("// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.")
  // What the generated file needs: the proto message classes it constructs, and the redacted
  // functions of messages that live in another module.
  const protoImports = new Set()
  const crossModules = new Set()
  void crossModules
  for (const typeName of declared) {
    protoImports.add(typeName)
    const message = messages.get(typeName)
    for (const field of message.fields) {
      const references = []
      if (field.reference !== undefined && !field.reference.startsWith("google.protobuf.")) references.push(field.reference)
      if (field.value !== undefined && field.value.kind !== "scalar") {
        const reference = typeNameOf(field.value.T)
        if (reference !== undefined) references.push(reference)
      }
      for (const reference of references) {
        const owner = messages.get(reference)
        if (owner === undefined) continue
        protoImports.add(reference)
        if (owner.protoName !== module.protoName && needed.has(reference)) crossModules.add(owner.protoName)
      }
    }
  }
  const usesBytes = declared.some(typeName =>
    messages.get(typeName).fields.some(field => {
      const annotation = annotations[typeName]?.[field.name]
      return annotation?.bytes === true
    }))
  const usesStrings = declared.some(typeName =>
    messages.get(typeName).fields.some(field => {
      const annotation = annotations[typeName]?.[field.name]
      return annotation !== undefined && annotation.bytes !== true
    }))
  const redactionRoot = "../../../../redaction"
  if (usesBytes || usesStrings) {
    lines.push(`import { DataClassification } from ${JSON.stringify(`${redactionRoot}/classification.ts`)};`)
    if (usesStrings) lines.push(`import { createRedactedString } from ${JSON.stringify(`${redactionRoot}/create.ts`)};`)
    if (usesBytes) lines.push(`import { createRedactedBytes } from ${JSON.stringify(`${redactionRoot}/create.ts`)};`)
  }
  const protoByModule = new Map()
  for (const typeName of protoImports) {
    const owner = messages.get(typeName)
    if (owner === undefined) continue
    if (!protoByModule.has(owner.protoName)) protoByModule.set(owner.protoName, [])
    protoByModule.get(owner.protoName).push(functionSuffix(typeName))
  }
  for (const [protoName, names] of [...protoByModule].sort()) {
    const specifier = `../../../../proto/generated/${protoName}`
    lines.push(`import { ${names.sort().join(", ")} } from ${JSON.stringify(specifier)};`)
  }
  const redactedFunctions = [...protoImports].filter(typeName => {
    const owner = messages.get(typeName)
    return owner !== undefined && owner.protoName !== module.protoName && needed.has(typeName)
  })
  if (redactedFunctions.length > 0) {
    const byModule = new Map()
    for (const typeName of redactedFunctions) {
      const owner = messages.get(typeName)
      if (!byModule.has(owner.protoName)) byModule.set(owner.protoName, [])
      byModule.get(owner.protoName).push(`toRedacted${functionSuffix(typeName)}`, `fromRedacted${functionSuffix(typeName)}`)
    }
    for (const [protoName, names] of [...byModule].sort()) {
      const sameNamespace = protoName.split("/")[0] === module.protoName.split("/")[0]
      const target = protoName.replace(/_pb\.ts$/, "_redacted.ts")
      const specifier = sameNamespace ? `./${path.basename(target)}` : `../../${target}`
      lines.push(`import { ${names.sort().join(", ")} } from ${JSON.stringify(specifier)};`)
    }
  }
  lines.push("")
  for (const typeName of declared) {
    const message = messages.get(typeName)
    const oneofs = new Map()
    for (const field of message.fields) {
      if (field.oneof === undefined) continue
      if (!oneofs.has(field.oneof)) oneofs.set(field.oneof, [])
      oneofs.get(field.oneof).push(field)
    }
    for (const [oneofName, members] of oneofs) {
      renderOneof(message, oneofName, members, annotations, "to", lines)
      lines.push("")
      renderOneof(message, oneofName, members, annotations, "from", lines)
      lines.push("")
    }
    renderMessage(message, annotations, "to", lines)
    lines.push("")
    renderMessage(message, annotations, "from", lines)
    lines.push("")
  }
  const exports = declared.flatMap(typeName => {
    const message = messages.get(typeName)
    const names = [
      `toRedacted${functionSuffix(typeName)}`,
      `fromRedacted${functionSuffix(typeName)}`,
    ]
    for (const field of message.fields) {
      if (field.oneof === undefined) continue
      const oneofSuffix = `${functionSuffix(typeName)}_${field.oneof}`
      names.push(`toRedacted${oneofSuffix}`, `fromRedacted${oneofSuffix}`)
    }
    return [...new Set(names)]
  })
  lines.push("export {")
  for (const name of exports) lines.push(`  ${name},`)
  lines.push("};")
  return `${lines.join("\n")}\n`
}

/**
 * Annotation keys are written the way a generated function names a message (`Parent_Child`), which is
 * ambiguous against a message whose own name contains an underscore. Resolve every key against the
 * schema, including the trailing digit a name clash may have added.
 */
function resolveAnnotations(raw, messages) {
  const index = new Map()
  for (const typeName of messages.keys()) {
    const namespace = typeName.split(".")[0]
    const key = `${namespace}|${functionSuffix(typeName)}`
    if (!index.has(key)) index.set(key, [])
    index.get(key).push(typeName)
  }
  const resolved = {}
  const unmatched = []
  for (const [key, fields] of Object.entries(raw)) {
    const [namespace] = key.split(".")
    const segments = key.split(".").slice(2)
    const lookup = candidate => index.get(`${namespace}|${candidate}`) ?? []
    // A key may name a message directly, a message whose name a clash suffixed with a digit, or a
    // oneof function (`Message_oneof`) — whose redacted members belong to the message itself.
    let candidates = []
    const parts = segments.join("_").split("_")
    for (let take = parts.length; take > 0 && candidates.length !== 1; take -= 1) {
      const candidate = parts.slice(0, take).join("_")
      const direct = lookup(candidate)
      candidates = direct.length === 1 ? direct : lookup(candidate.replace(/[0-9]+$/, ""))
    }
    if (candidates.length !== 1) {
      unmatched.push(key)
      continue
    }
    resolved[candidates[0]] = { ...(resolved[candidates[0]] ?? {}), ...fields }
  }
  return { resolved, unmatched }
}

const raw = JSON.parse(await readFile(annotationsPath, "utf8"))
const surface = JSON.parse(await readFile(surfacePath, "utf8"))
const { messages, modules } = await loadSchema()
const { resolved: annotations, unmatched } = resolveAnnotations(raw, messages)

/** The surface manifest names a message the way a generated function does; resolve it to a type. */
function resolveSuffix(namespace, suffix, index) {
  const parts = suffix.split("_")
  for (let take = parts.length; take > 0; take -= 1) {
    const candidate = parts.slice(0, take).join("_")
    const direct = index.get(`${namespace}|${candidate}`) ?? []
    if (direct.length === 1) return direct[0]
    const stripped = index.get(`${namespace}|${candidate.replace(/[0-9]+$/, "")}`) ?? []
    if (stripped.length === 1) return stripped[0]
  }
  return undefined
}

const suffixIndex = new Map()
for (const typeName of messages.keys()) {
  const namespace = typeName.split(".")[0]
  const key = `${namespace}|${functionSuffix(typeName)}`
  if (!suffixIndex.has(key)) suffixIndex.set(key, [])
  suffixIndex.get(key).push(typeName)
}

/** What each module emits: exactly the surface the manifest lists, resolved against the schema. */
const emittedByModule = new Map()
const needed = new Set()
let unresolvedSurface = 0
for (const [listedName, suffixes] of Object.entries(surface)) {
  // The manifest names modules as the baseline did; our schema files are named after the platform.
  const protoName = listedName
    .replace(/cursor_rules_pb\.ts$/, "rules_pb.ts")
    .replace(/cursor_packages_pb\.ts$/, "packages_pb.ts")
    .replace(/grok_bot_connect\.ts$/, "slate_bot_connect.ts")
    .replace(/sand_box_pb\.ts$/, "sandbox_pb.ts")
  const namespace = protoName.split("/")[0]
  const typeNames = []
  for (const suffix of suffixes) {
    const typeName = resolveSuffix(namespace, suffix, suffixIndex)
    if (typeName === undefined) {
      unresolvedSurface += 1
      continue
    }
    typeNames.push(typeName)
    needed.add(typeName)
  }
  emittedByModule.set(protoName, typeNames)
}
void closureOf

let written = 0
let missing = 0
for (const typeName of Object.keys(annotations)) {
  if (!messages.has(typeName)) {
    missing += 1
    process.stdout.write(`annotation without a message in the schema: ${typeName}\n`)
  }
}
for (const key of unmatched) {
  missing += 1
  process.stdout.write(`annotation key that resolves to no message: ${key}\n`)
}
for (const module of modules.values()) {
  const declared = emittedByModule.get(module.protoName) ?? []
  if (declared.length === 0) continue
  const target = path.join(outputRoot, module.protoName.replace(/_pb\.ts$/, "_redacted.ts"))
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, renderModule(module, messages, annotations, needed))
  written += 1
}
process.stdout.write(
  `${Object.keys(annotations).length} annotated message(s), ${needed.size} message(s) emitted, ${written} module(s) written, ${missing} annotation(s) unmatched, ${unresolvedSurface} surface entry(ies) unresolved\n`,
)
