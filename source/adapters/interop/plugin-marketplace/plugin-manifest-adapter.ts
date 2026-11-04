/**
 * Reading a plugin's manifest, and a marketplace's.
 *
 * A manifest is where a plugin says what it is: its name, what it needs, the commands, agents, skills, rules and hooks it
 * brings, the variables it asks for, and where its files come from — a repository, a git URL or a subdirectory of one,
 * pinned to a ref or a commit. The schema is what the manifest is read against, so a manifest that does not match is
 * refused with what was wrong rather than half-read, and the format's own conventions — the directories a manifest may
 * live in and the client versions it may require — are read as the format defines them. A marketplace is read the same
 * way: its name, its owner, and the plugins it lists.
 */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import { CapabilitiesSchema } from "../../../packages/plugin-install/capabilities.ts";
import { readSchemaId, resolveSchemaVersion } from "../../../packages/plugin-install/schema-version.ts";

/** The largest manifest that is read at all. */
export const MAX_MANIFEST_SIZE_BYTES = 10 * 1024 * 1024;

/** The shape the format gives a plugin's name. */
const KEBAB_CASE_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/** The files a plugin's manifest may live in, in the order they are looked for. */
export const PLUGIN_MANIFEST_PATHS = [
  ".cursor-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  "plugin.json",
] as const;

/** The directories that mark a plugin's root. */
export const PLUGIN_ROOT_DIR_NAMES = [".cursor-plugin", ".claude-plugin"] as const;
export const preferredPluginManifestRootDirectory = PLUGIN_ROOT_DIR_NAMES[0];

/** The files a marketplace's manifest may live in. */
export const MARKETPLACE_MANIFEST_PATHS = [
  ".cursor-plugin/marketplace.json",
  ".claude-plugin/marketplace.json",
] as const;

const GitHubSourceSchema = z.object({
  source: z.literal("github"),
  repo: z.string().regex(/^[^/]+\/[^/]+$/, "Must be in owner/repo format"),
  ref: z.string().optional(),
  sha: z.string().length(40, "SHA must be 40 characters").regex(/^[a-f0-9]+$/, "SHA must be hexadecimal").optional(),
});
const GitUrlSourceSchema = z.object({
  source: z.literal("url"),
  url: z.string().url().endsWith(".git", "URL must end with .git"),
  ref: z.string().optional(),
  sha: z.string().length(40, "SHA must be 40 characters").regex(/^[a-f0-9]+$/, "SHA must be hexadecimal").optional(),
});
const GitSubdirSourceSchema = z.object({
  source: z.literal("git-subdir"),
  url: z.string().url().endsWith(".git", "URL must end with .git"),
  path: z.string().min(1),
  ref: z.string().optional(),
  sha: z.string().length(40, "SHA must be 40 characters").regex(/^[a-f0-9]+$/, "SHA must be hexadecimal").optional(),
});
export const PluginSourceSchema = z.union([z.string(), GitHubSourceSchema, GitUrlSourceSchema, GitSubdirSourceSchema]);
export type PluginSource = z.infer<typeof PluginSourceSchema>;

/** A semver-shaped client version, with an optional pre-release tail. */
const MIN_CLIENT_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const MinClientVersionsSchema = z.object({
  cursor: z.string().regex(MIN_CLIENT_VERSION_PATTERN, "Must be a semver version (X.Y.Z)").optional(),
  slate: z.string().regex(MIN_CLIENT_VERSION_PATTERN, "Must be a semver version (X.Y.Z)").optional(),
});
const AuthorSchema = z.object({ name: z.string().min(1, "Author name is required"), email: z.string().email().optional() });

/** The descriptive fields a plugin and a marketplace listing both carry, in the order both declare them. */
const DESCRIPTIVE_FIELDS = {
  description: z.string().optional(),
  version: z.string().optional(),
  author: AuthorSchema.optional(),
  publisher: z.string().min(1).optional(),
  homepage: z.string().url().optional(),
  repository: z.string().url().optional(),
  license: z.string().optional(),
} as const;

/** The components a plugin and a marketplace listing both point at, up to the variables they ask for. */
const COMPONENT_FIELDS_BEFORE_VARIABLES = {
  commands: z.union([z.string(), z.array(z.string())]).optional(),
  agents: z.union([z.string(), z.array(z.string())]).optional(),
  skills: z.union([z.string(), z.array(z.string())]).optional(),
  rules: z.union([z.string(), z.array(z.string())]).optional(),
  hooks: z.union([z.string(), z.record(z.unknown())]).optional(),
} as const;

/** The components that come after the variables both declare: the MCP servers. */
const COMPONENT_FIELDS_AFTER_VARIABLES = {
  mcpServers: z.union([z.string(), z.record(z.unknown()), z.array(z.union([z.string(), z.record(z.unknown())]))]).optional(),
} as const;

// ---------------------------------------------------------------------------------------------
// The variables a plugin asks for
// ---------------------------------------------------------------------------------------------

const PluginVariablePrimitiveTypeSchema = z.enum(["string", "number", "integer", "boolean", "object", "array", "null"]);
const PluginVariableTypeSchema = z.union([
  PluginVariablePrimitiveTypeSchema,
  z.array(PluginVariablePrimitiveTypeSchema).nonempty().superRefine((types, ctx) => {
    if (new Set(types).size !== types.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Schema type arrays must not contain duplicates" });
  }),
]);

/** The subset of JSON Schema a plugin's variable declarations are written in. */
export interface PluginVariableSchema {
  type?: z.infer<typeof PluginVariableTypeSchema> | undefined;
  title?: string | undefined;
  description?: string | undefined;
  format?: string | undefined;
  writeOnly?: boolean | undefined;
  default?: unknown;
  enum?: [unknown, ...unknown[]] | undefined;
  const?: unknown;
  properties?: Record<string, PluginVariableSchema> | undefined;
  required?: string[] | undefined;
  additionalProperties?: boolean | PluginVariableSchema | undefined;
  items?: PluginVariableSchema | PluginVariableSchema[] | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  exclusiveMinimum?: number | undefined;
  exclusiveMaximum?: number | undefined;
  multipleOf?: number | undefined;
  minItems?: number | undefined;
  maxItems?: number | undefined;
  uniqueItems?: boolean | undefined;
  minProperties?: number | undefined;
  maxProperties?: number | undefined;
}

/** The numeric bounds of a variable schema that have to sit in order. */
type OrderedBoundsField = "minLength" | "maxLength" | "minimum" | "maximum" | "exclusiveMinimum" | "exclusiveMaximum" | "minItems" | "maxItems" | "minProperties" | "maxProperties";

/** One pair of bounds that must not cross, and the issue to raise on the lower one when they do. */
interface OrderedBoundsRule {
  readonly min: OrderedBoundsField;
  readonly max: OrderedBoundsField;
  readonly message: string;
  readonly path: string;
  readonly exclusive: boolean;
}

/** The bounds that have to sit in order, in the order a manifest is checked against them. */
const ORDERED_BOUNDS_RULES: readonly OrderedBoundsRule[] = [
  { min: "minLength", max: "maxLength", message: "minLength must be less than or equal to maxLength", path: "minLength", exclusive: false },
  { min: "minimum", max: "maximum", message: "minimum must be less than or equal to maximum", path: "minimum", exclusive: false },
  { min: "exclusiveMinimum", max: "exclusiveMaximum", message: "exclusiveMinimum must be less than exclusiveMaximum", path: "exclusiveMinimum", exclusive: true },
  { min: "minItems", max: "maxItems", message: "minItems must be less than or equal to maxItems", path: "minItems", exclusive: false },
  { min: "minProperties", max: "maxProperties", message: "minProperties must be less than or equal to maxProperties", path: "minProperties", exclusive: false },
];

/** Adds an issue under the named path, for the checks that only need to say what is wrong. */
type SchemaIssue = (path: string, message: string) => void;

/** A required property has to be declared: it cannot be asked for without saying what it is. */
function reportUndeclaredRequiredProperties(schema: PluginVariableSchema, issue: SchemaIssue): void {
  if (schema.required === undefined) return;
  for (const propertyName of schema.required) {
    if (schema.properties !== undefined && propertyName in schema.properties) continue;
    issue("required", 'Required property "' + propertyName + '" must be declared in properties');
  }
}

/** The numeric bounds of a variable schema have to sit in order. */
function reportCrossedBounds(schema: PluginVariableSchema, issue: SchemaIssue): void {
  for (const rule of ORDERED_BOUNDS_RULES) {
    const min = schema[rule.min];
    const max = schema[rule.max];
    if (min === undefined || max === undefined) continue;
    if (rule.exclusive ? min >= max : min > max) issue(rule.path, rule.message);
  }
}

/** The checks a variable schema is written against, beyond its shape. */
function validatePluginVariableSchemaShape(schema: PluginVariableSchema, ctx: z.RefinementCtx): void {
  const issue: SchemaIssue = (path, message) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
  reportUndeclaredRequiredProperties(schema, issue);
  reportCrossedBounds(schema, issue);
}

const PluginVariableSchemaSchema: z.ZodType<PluginVariableSchema> = z.lazy(() => z.object({
  type: PluginVariableTypeSchema.optional(), title: z.string().optional(), description: z.string().optional(), format: z.string().optional(), writeOnly: z.boolean().optional(), default: z.unknown().optional(), enum: z.array(z.any()).nonempty().optional(), const: z.unknown().optional(),
  properties: z.record(z.string(), PluginVariableSchemaSchema).optional(), required: z.array(z.string()).optional(), additionalProperties: z.union([z.boolean(), PluginVariableSchemaSchema]).optional(), items: z.union([PluginVariableSchemaSchema, z.array(PluginVariableSchemaSchema)]).optional(),
  minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional(), minimum: z.number().optional(), maximum: z.number().optional(), exclusiveMinimum: z.number().optional(), exclusiveMaximum: z.number().optional(), multipleOf: z.number().positive().optional(), minItems: z.number().int().nonnegative().optional(), maxItems: z.number().int().nonnegative().optional(), uniqueItems: z.boolean().optional(), minProperties: z.number().int().nonnegative().optional(), maxProperties: z.number().int().nonnegative().optional(),
}).strict().superRefine(validatePluginVariableSchemaShape));

/** Parses a plugin's variable schema, which is a JSON Schema subset with its own rules on top. */
export function parsePluginVariablesJsonSchema(schema: unknown): z.SafeParseReturnType<unknown, PluginVariableSchema> {
  const result = PluginVariableSchemaSchema.superRefine((value, ctx) => {
    if (value.type !== "object") ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Plugin variable schemas must declare type "object"', path: ["type"] });
  }).safeParse(schema);
  return result.success ? { success: true, data: result.data } : result;
}

const PluginVariablesJsonSchemaSchema = z.unknown().superRefine((value, ctx) => {
  const result = parsePluginVariablesJsonSchema(value);
  if (!result.success) for (const issue of result.error.issues) ctx.addIssue(issue);
}).transform(value => value as PluginVariableSchema);

// ---------------------------------------------------------------------------------------------
// The manifest schemas
// ---------------------------------------------------------------------------------------------

const MarketplacePluginEntrySchema = z.object({
  name: z.string().min(1).transform(name => name.toLowerCase()).refine(name => KEBAB_CASE_PATTERN.test(name), "Name must be kebab-case (lowercase alphanumeric with hyphens and periods)"),
  displayName: z.string().optional(),
  source: PluginSourceSchema,
  ...DESCRIPTIVE_FIELDS,
  keywords: z.array(z.string()).optional(),
  capabilities: CapabilitiesSchema.optional(),
  logo: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  minClientVersions: MinClientVersionsSchema.optional(),
  strict: z.boolean().default(true),
  ...COMPONENT_FIELDS_BEFORE_VARIABLES,
  variables: PluginVariablesJsonSchemaSchema.optional(),
  ...COMPONENT_FIELDS_AFTER_VARIABLES,
});
export type MarketplacePluginEntry = z.infer<typeof MarketplacePluginEntrySchema>;

const PluginManifestSchema = z.object({
  name: z.string().min(1).regex(KEBAB_CASE_PATTERN, "Name must be kebab-case (lowercase alphanumeric with hyphens and periods)"),
  displayName: z.string().optional(),
  ...DESCRIPTIVE_FIELDS,
  logo: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  capabilities: CapabilitiesSchema.optional(),
  minClientVersions: MinClientVersionsSchema.optional(),
  ...COMPONENT_FIELDS_BEFORE_VARIABLES,
  variables: PluginVariablesJsonSchemaSchema.optional(),
  ...COMPONENT_FIELDS_AFTER_VARIABLES,
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ---------------------------------------------------------------------------------------------
// Reading the values a manifest may carry
// ---------------------------------------------------------------------------------------------

/** Text with something in it: a string whose length is not zero. */
function hasText(value: unknown): value is string { return typeof value === "string" && value.length > 0; }

/** Text with something in it once trimmed: a string that is not only whitespace. */
function hasVisibleText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

/** The string a value is, when it is one. */
function optionalText(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }

/** A value that is a plain record, when it is one. */
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** The client versions a manifest requires, when it requires any. */
function parsePluginMinClientVersions(value: unknown): z.infer<typeof MinClientVersionsSchema> | undefined {
  const result = MinClientVersionsSchema.safeParse(value);
  if (!result.success) return undefined;
  return result.data.cursor === undefined && result.data.slate === undefined ? undefined : result.data;
}

/** The marketplace's own name, normalized from what it says or from the repository it came from. */
export function normalizeMarketplaceName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The name a marketplace is known by when it does not name itself. */
function fallbackMarketplaceName(options: { repoName?: string; fallbackId?: string }): string {
  const repoName = options.repoName === undefined ? "" : normalizeMarketplaceName(options.repoName);
  return repoName.length > 0 ? repoName : "slate-marketplace-" + (options.fallbackId ?? randomUUID());
}

/** The name a marketplace manifest says, or the one its repository gives it. */
function readMarketplaceName(json: unknown, options: { repoName?: string; fallbackId?: string }): string {
  const declared = isRecord(json) ? optionalText(json.name) : undefined;
  if (declared !== undefined) {
    const name = normalizeMarketplaceName(declared);
    if (name.length > 0) return name;
  }
  return fallbackMarketplaceName(options);
}

/** The owner a marketplace names, and "Unknown" when it names none. */
function readOwner(json: unknown): { name: string; email?: string } {
  const owner = isRecord(json) && isRecord(json.owner) ? json.owner : undefined;
  if (owner === undefined) return { name: "Unknown" };
  const name = hasVisibleText(owner.name) ? owner.name : "Unknown";
  const email = hasVisibleText(owner.email) ? owner.email : undefined;
  return { name, ...(email === undefined ? {} : { email }) };
}

/** The strings of an array, when it holds any. */
function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

/** A component path: one path, or a list of them. */
function readComponentPaths(value: unknown): string | string[] | undefined { return typeof value === "string" ? value : readStringArray(value); }

/** The metadata block a marketplace may carry, when it names anything. */
function readMetadata(json: unknown): { description?: string | undefined; version?: string | undefined; pluginRoot?: string | undefined } | undefined {
  if (!isRecord(json) || !isRecord(json.metadata)) return undefined;
  const metadata = { description: optionalText(json.metadata.description), version: optionalText(json.metadata.version), pluginRoot: optionalText(json.metadata.pluginRoot) };
  if (metadata.description === undefined && metadata.version === undefined && metadata.pluginRoot === undefined) return undefined;
  return metadata;
}

/** An author, when the manifest names one. */
function readAuthor(value: unknown): { name: string; email?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const name = optionalText(value.name);
  if (name === undefined || name.length === 0) return undefined;
  const email = optionalText(value.email);
  return { name, ...(email === undefined ? {} : { email }) };
}

/** The MCP servers a plugin brings: a path, a map, or a list of both. */
function readMcpServers(value: unknown): string | Record<string, unknown> | Array<string | Record<string, unknown>> | undefined {
  if (typeof value === "string" || isRecord(value)) return value;
  if (Array.isArray(value)) {
    const servers = value.filter((item): item is string | Record<string, unknown> => typeof item === "string" || isRecord(item));
    return servers.length > 0 ? servers : undefined;
  }
  return undefined;
}

/** The hooks a plugin brings: a path or a map. */
function readHooks(value: unknown): string | Record<string, unknown> | undefined { return typeof value === "string" || isRecord(value) ? value : undefined; }

/** The variables a plugin asks for, when its schema parses. */
function readVariables(value: unknown): PluginVariableSchema | undefined {
  if (value === undefined) return undefined;
  const result = parsePluginVariablesJsonSchema(value);
  return result.success ? result.data : undefined;
}

/** Where a plugin's files come from, when the manifest says something usable. */
function readPluginSource(value: unknown): PluginSource | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  const ref = optionalText(value.ref);
  const sha = optionalText(value.sha);
  const repo = hasText(value.repo) ? value.repo : undefined;
  const url = hasText(value.url) ? value.url : undefined;
  if (value.source === "github" && repo !== undefined) return { source: "github", repo, ref, sha };
  if ((value.source === "url" || value.source === undefined) && url !== undefined) return { source: "url", url, ref, sha };
  if (value.source === "git-subdir" && url !== undefined && hasText(value.path)) return { source: "git-subdir", url, path: value.path, ref, sha };
  if (repo !== undefined) return { source: "github", repo, ref, sha };
  return undefined;
}

/** A name read from a path: its last segment, normalized. */
function nameFromPathPart(pathPart: string): string | undefined {
  const name = normalizeMarketplaceName(basename(pathPart));
  return name.length > 0 ? name : undefined;
}

/** A name read from a URL: its path with the trailing slash and the .git suffix taken off. */
function nameFromUrl(url: string): string | undefined {
  let urlPath = url;
  try { urlPath = new URL(url).pathname; } catch {}
  while (urlPath.endsWith("/")) urlPath = urlPath.slice(0, -1);
  if (urlPath.toLowerCase().endsWith(".git")) urlPath = urlPath.slice(0, -4);
  return nameFromPathPart(urlPath);
}

/** The name a plugin is known by when its entry does not name it. */
function derivePluginNameFromSource(source: PluginSource): string | undefined {
  if (typeof source === "string") return nameFromPathPart(source);
  if (source.source === "github") return nameFromPathPart(source.repo.split("/").at(-1) ?? "");
  if (source.source === "git-subdir") return nameFromPathPart(source.path);
  return nameFromUrl(source.url);
}

// ---------------------------------------------------------------------------------------------
// Reading one listing of a marketplace
// ---------------------------------------------------------------------------------------------

interface SkippedPluginEntry { index: number; name?: string; error: string }

/** The entry is left out, with the reason. */
function skippedPluginEntry(index: number, error: string, name?: string): { skippedEntry: SkippedPluginEntry } {
  return { skippedEntry: { index, ...(name === undefined ? {} : { name }), error } };
}

/** The name an entry may still be reported under when it is skipped for its source. */
function skippedEntryName(value: unknown): string | undefined {
  const name = optionalText(value);
  return name !== undefined && name.length > 0 ? name : undefined;
}

/** The name an entry is listed under: its own, normalized, or the one its source gives it. */
function readEntryName(rawEntry: Record<string, unknown>, source: PluginSource): string | undefined {
  const nameFromEntry = typeof rawEntry.name === "string" ? normalizeMarketplaceName(rawEntry.name) : "";
  return nameFromEntry || derivePluginNameFromSource(source);
}

/** The capabilities an entry asks for, when they are ones the platform knows. */
function readEntryCapabilities(rawEntry: Record<string, unknown>, index: number, name: string): { capabilities: z.infer<typeof CapabilitiesSchema> | undefined } | { skippedEntry: SkippedPluginEntry } {
  const result = CapabilitiesSchema.safeParse(rawEntry.capabilities);
  if (rawEntry.capabilities !== undefined && !result.success) {
    const issues = result.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join(", ");
    return skippedPluginEntry(index, "Plugin entry at index " + index + " has invalid capabilities: " + issues, name);
  }
  return { capabilities: result.success ? result.data : undefined };
}

/** One raw entry of a marketplace listing, as the plugin it describes or the reason it is left out. */
function readMarketplacePluginEntry(rawEntry: unknown, index: number): { entry: MarketplacePluginEntry } | { skippedEntry: SkippedPluginEntry } {
  if (!isRecord(rawEntry)) return skippedPluginEntry(index, "Plugin entry at index " + index + " is not an object");
  const source = readPluginSource(rawEntry.source);
  if (source === undefined) return skippedPluginEntry(index, "Plugin entry at index " + index + " has no usable source", skippedEntryName(rawEntry.name));
  const name = readEntryName(rawEntry, source);
  if (name === undefined) return skippedPluginEntry(index, "Plugin entry at index " + index + " has no usable name");
  const capabilities = readEntryCapabilities(rawEntry, index, name);
  if ("skippedEntry" in capabilities) return capabilities;
  const minClientVersions = parsePluginMinClientVersions(rawEntry.minClientVersions);
  return { entry: {
    name,
    displayName: optionalText(rawEntry.displayName),
    source,
    description: optionalText(rawEntry.description),
    version: optionalText(rawEntry.version),
    author: readAuthor(rawEntry.author),
    publisher: optionalText(rawEntry.publisher),
    homepage: optionalText(rawEntry.homepage),
    repository: optionalText(rawEntry.repository),
    license: optionalText(rawEntry.license),
    keywords: readStringArray(rawEntry.keywords),
    logo: optionalText(rawEntry.logo),
    category: optionalText(rawEntry.category),
    tags: readStringArray(rawEntry.tags),
    strict: typeof rawEntry.strict === "boolean" ? rawEntry.strict : true,
    commands: readComponentPaths(rawEntry.commands),
    agents: readComponentPaths(rawEntry.agents),
    skills: readComponentPaths(rawEntry.skills),
    rules: readComponentPaths(rawEntry.rules),
    hooks: readHooks(rawEntry.hooks),
    variables: readVariables(rawEntry.variables),
    mcpServers: readMcpServers(rawEntry.mcpServers),
    ...(capabilities.capabilities === undefined ? {} : { capabilities: capabilities.capabilities }),
    ...(minClientVersions === undefined ? {} : { minClientVersions }),
  } };
}

/** The plugins a listing holds, and the entries that were left out. */
function collectMarketplaceEntries(rawPlugins: unknown): { entries: MarketplacePluginEntry[]; skipped: SkippedPluginEntry[] } {
  const entries: MarketplacePluginEntry[] = [];
  const skipped: SkippedPluginEntry[] = [];
  const seenNames = new Set<string>();
  const list = Array.isArray(rawPlugins) ? rawPlugins : [];
  list.forEach((rawEntry, index) => {
    const result = readMarketplacePluginEntry(rawEntry, index);
    if ("skippedEntry" in result) {
      skipped.push(result.skippedEntry);
      return;
    }
    if (seenNames.has(result.entry.name)) {
      skipped.push({ index, name: result.entry.name, error: 'Duplicate plugin name "' + result.entry.name + '" at index ' + index });
      return;
    }
    seenNames.add(result.entry.name);
    entries.push(result.entry);
  });
  return { entries, skipped };
}

// ---------------------------------------------------------------------------------------------
// The two readers
// ---------------------------------------------------------------------------------------------

export interface MarketplaceManifest {
  name: string;
  owner: { name: string; email?: string };
  description?: string | undefined;
  plugins: MarketplacePluginEntry[];
  metadata?: { description?: string | undefined; version?: string | undefined; pluginRoot?: string | undefined } | undefined;
  skippedPluginEntries: SkippedPluginEntry[];
}

/** The JSON a manifest file holds, or why it cannot be read. */
function readManifestJson(content: string): { ok: true; json: unknown } | { ok: false; error: string } {
  if (content.length > MAX_MANIFEST_SIZE_BYTES) return { ok: false, error: "Manifest exceeds maximum size of " + MAX_MANIFEST_SIZE_BYTES + " bytes" };
  try {
    return { ok: true, json: JSON.parse(content) };
  } catch (error) {
    return { ok: false, error: "Invalid JSON: " + (error instanceof Error ? error.message : "Unknown error") };
  }
}

/** Reads a marketplace manifest: its name and owner, and the plugins it lists. */
export function parseMarketplaceManifest(content: string, options: { repoName?: string; fallbackId?: string } = {}): { success: true; data: MarketplaceManifest } | { success: false; error: string } {
  const parsed = readManifestJson(content);
  if (!parsed.ok) return { success: false, error: parsed.error };
  if (!isRecord(parsed.json)) return { success: false, error: "Invalid marketplace manifest: expected a JSON object" };
  const plugins = collectMarketplaceEntries(parsed.json.plugins);
  return { success: true, data: { name: readMarketplaceName(parsed.json, options), owner: readOwner(parsed.json), description: optionalText(parsed.json.description), plugins: plugins.entries, metadata: readMetadata(parsed.json), skippedPluginEntries: plugins.skipped } };
}

/** Reads a plugin manifest, against the schema its `$schema` names when that one is known. */
export function parsePluginManifest(content: string): { success: true; data: PluginManifest; unrecognizedSchemaId?: string } | { success: false; error: string; details?: z.ZodError } {
  const parsed = readManifestJson(content);
  if (!parsed.ok) return { success: false, error: parsed.error };
  const schema = resolveSchemaVersion(readSchemaId(parsed.json));
  const result = PluginManifestSchema.safeParse(parsed.json);
  if (!result.success) return { success: false, error: "Invalid plugin manifest: " + result.error.errors.map(error => error.path.join(".") + ": " + error.message).join(", "), details: result.error };
  return { success: true, data: result.data, ...(schema.kind === "unsupported" ? { unrecognizedSchemaId: schema.id } : {}) };
}

// ---------------------------------------------------------------------------------------------
// What a listing's entries are, and where they resolve to
// ---------------------------------------------------------------------------------------------

export type ClassifiedMarketplaceEntry =
  | { entry: MarketplacePluginEntry; kind: "local"; localPath: string }
  | { entry: MarketplacePluginEntry; kind: "unresolvable"; rawSource: string }
  | { entry: MarketplacePluginEntry; kind: "external-github" | "external-url"; externalUrl: string; externalRef?: string | undefined; externalSha?: string | undefined; effectiveRef?: string | undefined }
  | { entry: MarketplacePluginEntry; kind: "external-git-subdir"; externalUrl: string; externalRef?: string | undefined; externalSha?: string | undefined; effectiveRef?: string | undefined; subdirPath: string };

/** What one entry is: a path inside the marketplace, or the URL and ref it is fetched from. */
function classifyManifestEntry(entry: MarketplacePluginEntry, pluginRoot: string | undefined): ClassifiedMarketplaceEntry {
  const source = entry.source;
  if (typeof source === "string") {
    const localPath = resolvePluginSourcePath(source, pluginRoot);
    return localPath === null ? { entry, kind: "unresolvable", rawSource: source } : { entry, kind: "local", localPath };
  }
  const externalRef = source.ref;
  const externalSha = source.sha;
  const effectiveRef = source.sha ?? source.ref;
  switch (source.source) {
    case "github":
      return { entry, kind: "external-github", externalUrl: "https://github.com/" + source.repo + ".git", externalRef, externalSha, effectiveRef };
    case "url":
      return { entry, kind: "external-url", externalUrl: source.url, externalRef, externalSha, effectiveRef };
    case "git-subdir":
      return { entry, kind: "external-git-subdir", externalUrl: source.url, externalRef, externalSha, effectiveRef, subdirPath: source.path };
  }
}

/** What each entry of a marketplace listing is, in the order it was listed. */
export function parseAndClassifyManifestEntries(plugins: readonly MarketplacePluginEntry[], pluginRoot?: string): ClassifiedMarketplaceEntry[] {
  return plugins.map((entry) => classifyManifestEntry(entry, pluginRoot));
}

/** A path with one leading "./" taken off. */
function withoutLeadingDotSlash(value: string): string { return value.startsWith("./") ? value.slice(2) : value; }

/** A path with one trailing "/" taken off. */
function withoutTrailingSlash(value: string): string { return value.endsWith("/") ? value.slice(0, -1) : value; }

/** Where a path source resolves to, inside the marketplace's own root. */
export function resolvePluginSourcePath(source: PluginSource, pluginRoot?: string): string | null {
  if (typeof source !== "string") return null;
  const resolvedPath = withoutLeadingDotSlash(source);
  if (pluginRoot === undefined) return resolvedPath || ".";
  const root = withoutTrailingSlash(withoutLeadingDotSlash(pluginRoot));
  return root + "/" + resolvedPath || ".";
}

/** The names of the directories that mark a plugin's root, as a set for looking them up. */
const PLUGIN_ROOT_DIR_NAME_SET: ReadonlySet<string> = new Set(PLUGIN_ROOT_DIR_NAMES);

/** Whether the entry names a plugin root directory. */
function isPluginRootDirName(entryName: string): boolean { return PLUGIN_ROOT_DIR_NAME_SET.has(entryName); }

/** Whether a listing names a plugin root directory among its entries. */
export function containsPluginRootDir(entryNames: readonly string[]): boolean { return entryNames.some(isPluginRootDirName); }
