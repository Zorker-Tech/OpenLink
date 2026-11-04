/**
 * Finding what a plugin actually brings.
 *
 * A manifest says which commands, agents, skills, rules and hooks a plugin has, and those entries name files rather
 * than describe them: the discovery reads each named entry, tells a file from a directoryEntry, and describes what it found
 * so a surface can list it — with the entries that are not there left out rather than invented, and the ones that are
 * unusable reported as such instead of as content.
 */
import { basename } from "node:path";
import yaml from "js-yaml";
import { isPathSafe, type PluginManifest } from "./manifest-parser.ts";
import { PLUGIN_MCP_CONFIG_FILE_NAMES, resolvePluginMcpConfigFromReader } from "./mcp-parser.ts";
import { inferMcpPlaceholderVariables, type PlaceholderProperty } from "../../adapters/interop/plugin-marketplace/mcp-placeholder-variable-adapter.ts";

const MARKDOWN_SUFFIXES = [".md", ".mdc", ".markdown"];
const COMMAND_SUFFIXES = [...MARKDOWN_SUFFIXES, ".txt"];
const FRONTMATTER_PATTERN = /^---\s*\n([\s\S]*?)\n---/;
const EMPTY_DESCRIPTION = "";

export interface PluginFileEntry { name: string; path: string; type: "file" | "dir" }
export interface PluginFileFetcher {
  listDirectory(path: string, visitedRealDirPaths?: Set<string>): Promise<PluginFileEntry[]>;
  fetchFile(path: string): Promise<{ content: string }>;
  fileExists(path: string): Promise<boolean>;
}
export interface PluginComponentDescriptor {
  name: string;
  path: string;
  description?: string | undefined;
  environments?: string[] | undefined;
  disabledEnvironments?: string[] | undefined;
}
export interface DiscoveredPluginComponents {
  skills: PluginComponentDescriptor[];
  agents: PluginComponentDescriptor[];
  hooks: PluginComponentDescriptor[];
  commands: PluginComponentDescriptor[];
  rules: PluginComponentDescriptor[];
  mcpServers: PluginComponentDescriptor[];
  mcpVariables: { type: "object"; properties: Record<string, PlaceholderProperty> } | undefined;
}
export type PluginDiscoveryManifest = Pick<PluginManifest, "commands" | "agents" | "skills" | "rules" | "hooks" | "mcpServers">;

function slugifyName(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9.-]/g, ""); }
function normalizeEnvironments(value: unknown): string[] | undefined {
  if (Array.isArray(value)) { const normalizedEntries = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0); return normalizedEntries.length === 0 ? undefined : normalizedEntries; }
  if (typeof value === "string") { const normalizedEntries = value.split(",").map(entry => entry.trim()).filter(entry => entry.length > 0); return normalizedEntries.length === 0 ? undefined : normalizedEntries; }
  return undefined;
}
function readFrontmatter(content: string): { name?: string | undefined; description?: string | undefined; environments?: string[] | undefined; disabledEnvironments?: string[] | undefined } {
  const frontmatterBlock = content.match(FRONTMATTER_PATTERN); if (!frontmatterBlock) return {};
  try {
    const frontmatterFields = yaml.load(frontmatterBlock[1]!, { schema: yaml.JSON_SCHEMA }); if (!frontmatterFields || typeof frontmatterFields !== "object") return {};
    const frontmatterRecord = frontmatterFields as Record<string, unknown>, frontmatterMetadata = frontmatterRecord.frontmatterMetadata !== null && typeof frontmatterRecord.frontmatterMetadata === "object" ? frontmatterRecord.frontmatterMetadata as Record<string, unknown> : undefined;
    return { disabledEnvironments: normalizeEnvironments(frontmatterRecord["disabled-environments"] ?? frontmatterMetadata?.disabledEnvironments), environments: normalizeEnvironments(frontmatterRecord.environments ?? frontmatterMetadata?.environments), name: typeof frontmatterRecord.name === "string" ? frontmatterRecord.name : undefined, description: typeof frontmatterRecord.description === "string" ? frontmatterRecord.description : undefined };
  } catch {
    const frontmatterText = frontmatterBlock[1]!, nameLine = frontmatterText.match(/^name:\s*(.+)$/m), descriptionLine = frontmatterText.match(/^description:\s*(.+)$/m);
    return nameLine || descriptionLine ? { name: nameLine ? nameLine[1]!.trim() : undefined, description: descriptionLine ? descriptionLine[1]!.trim() : undefined } : {};
  }
}
function nameFromPath(filePath: string): string { return slugifyName(basename(filePath).replace(/\.(md|mdc|markdown|txt)$/i, "")); }
function uniqueByName(descriptors: PluginComponentDescriptor[]): PluginComponentDescriptor[] { const seenNames = new Set<string>(), result: PluginComponentDescriptor[] = []; for (const descriptor of descriptors) if (!seenNames.has(descriptor.name)) { seenNames.add(descriptor.name); result.push(descriptor); } return result; }

export class PluginComponentDiscovery {
  constructor(private readonly fileFetcher: PluginFileFetcher) {}

  async discoverComponents(discoveryOptions: { rootPath?: string | undefined; metadataOnly?: boolean | undefined; manifest?: PluginDiscoveryManifest | undefined } = {}): Promise<DiscoveredPluginComponents> {
    const rootPath = discoveryOptions.rootPath ?? "", rootPrefix = rootPath ? `${rootPath}/` : "", metadataOnlyMode = discoveryOptions.metadataOnly ?? false, manifest = discoveryOptions.manifest;
    let rootEntries: PluginFileEntry[]; try { rootEntries = await this.fileFetcher.listDirectory(rootPath); } catch { rootEntries = []; }
    const directoryNames = new Set(rootEntries.filter(item => item.type === "dir").map(item => item.name.toLowerCase()));
    const mcpConfigFiles = PLUGIN_MCP_CONFIG_FILE_NAMES.filter(name => rootEntries.some(item => item.type === "file" && item.name === name));
    const hasRootSkillFile = rootEntries.some(item => item.type === "file" && item.name === "SKILL.md");
    const [rootSkillComponent, skills, agents, hooks, commands, rules, mcp] = await Promise.all([
      hasRootSkillFile && manifest?.skills === undefined ? this.readRootSkill(rootPrefix, metadataOnlyMode) : Promise.resolve(null),
      manifest?.skills !== undefined ? this.readManifestPaths(rootPrefix, manifest.skills, true, MARKDOWN_SUFFIXES, metadataOnlyMode) : directoryNames.has("skills") ? this.readSkillsFolder(`${rootPrefix}skills`, metadataOnlyMode) : Promise.resolve([]),
      manifest?.agents !== undefined ? this.readManifestPaths(rootPrefix, manifest.agents, false, MARKDOWN_SUFFIXES, metadataOnlyMode) : directoryNames.has("agents") ? this.readMarkdownFolder(`${rootPrefix}agents`, MARKDOWN_SUFFIXES, metadataOnlyMode) : Promise.resolve([]),
      manifest?.hooks !== undefined ? this.readHooksFromManifest(rootPrefix, manifest.hooks, metadataOnlyMode) : directoryNames.has("hooks") ? this.readHooksJson(`${rootPrefix}hooks/hooks.json`, metadataOnlyMode) : Promise.resolve([]),
      manifest?.commands !== undefined ? this.readManifestPaths(rootPrefix, manifest.commands, false, COMMAND_SUFFIXES, metadataOnlyMode) : directoryNames.has("commands") ? this.readMarkdownFolder(`${rootPrefix}commands`, COMMAND_SUFFIXES, metadataOnlyMode) : Promise.resolve([]),
      manifest?.rules !== undefined ? this.readManifestPaths(rootPrefix, manifest.rules, false, MARKDOWN_SUFFIXES, metadataOnlyMode) : directoryNames.has("rules") ? this.readMarkdownFolder(`${rootPrefix}rules`, MARKDOWN_SUFFIXES, metadataOnlyMode) : Promise.resolve([]),
      this.readMcpServers(rootPrefix, manifest?.mcpServers, mcpConfigFiles),
    ]);
    return { skills: uniqueByName(rootSkillComponent ? [rootSkillComponent, ...skills] : skills), agents: uniqueByName(agents), hooks, commands: uniqueByName(commands), rules: uniqueByName(rules), mcpServers: mcp.servers, mcpVariables: mcp.variables };
  }

  private async readHooksJson(hooksJsonPath: string, metadataOnlyMode = false): Promise<PluginComponentDescriptor[]> {
    try { if (!await this.fileFetcher.fileExists(hooksJsonPath)) return []; const config = JSON.parse((await this.fileFetcher.fetchFile(hooksJsonPath)).content) as { hooks?: unknown }; if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) return []; return Object.keys(config.hooks).map(name => ({ name: slugifyName(name), path: hooksJsonPath, description: metadataOnlyMode ? EMPTY_DESCRIPTION : `Hook: ${name}` })); } catch { return []; }
  }
  private async readHooksFromManifest(rootPrefix: string, hooksSetting: NonNullable<PluginManifest["hooks"]>, metadataOnlyMode = false): Promise<PluginComponentDescriptor[]> {
    if (typeof hooksSetting === "string") { if (!isPathSafe(hooksSetting)) return []; const targetPath = `${rootPrefix}${hooksSetting.replace(/^\.\//, "")}`; return this.readHooksJson(targetPath.endsWith(".json") ? targetPath : `${targetPath}/hooks.json`, metadataOnlyMode); }
    const hooksObject = hooksSetting as Record<string, unknown>, hooks = hooksObject.hooks ?? hooksObject; if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return [];
    return Object.keys(hooks).map(name => ({ name: slugifyName(name), path: "manifest", description: metadataOnlyMode ? EMPTY_DESCRIPTION : `Hook: ${name}` }));
  }

  private async readManifestPaths(rootPrefix: string, entryPaths: string | string[], skillDirectory = false, suffixes = MARKDOWN_SUFFIXES, metadataOnlyMode = false): Promise<PluginComponentDescriptor[]> {
    if (typeof entryPaths === "string") { if (!isPathSafe(entryPaths)) return []; const directoryEntry = `${rootPrefix}${entryPaths.replace(/^\.\//, "")}`.replace(/\/$/, ""); return skillDirectory ? this.readSkillsFolder(directoryEntry, metadataOnlyMode) : this.readMarkdownFolder(directoryEntry, suffixes, metadataOnlyMode); }
    const descriptors: PluginComponentDescriptor[] = [];
    for (const entryPath of entryPaths) {
      try {
        if (!isPathSafe(entryPath)) continue; const targetPath = `${rootPrefix}${entryPath.replace(/^\.\//, "")}`;
        if (skillDirectory) {
          const skillPath = targetPath.endsWith("SKILL.md") ? targetPath : `${targetPath.replace(/\/$/, "")}/SKILL.md`;
          if (!await this.fileFetcher.fileExists(skillPath)) { descriptors.push(...await this.readSkillsFolder(targetPath.replace(/\/$/, ""), metadataOnlyMode)); continue; }
          const directoryEntry = targetPath.endsWith("SKILL.md") ? targetPath.slice(0, -"SKILL.md".length).replace(/\/$/, "") : targetPath; let name = nameFromPath(directoryEntry), description = metadataOnlyMode ? EMPTY_DESCRIPTION : undefined;
          if (!metadataOnlyMode) { const frontmatterFields = readFrontmatter((await this.fileFetcher.fetchFile(skillPath)).content); name = frontmatterFields.name ?? name; description = frontmatterFields.description; if (name) { const descriptor: PluginComponentDescriptor = { disabledEnvironments: frontmatterFields.disabledEnvironments, environments: frontmatterFields.environments, name: slugifyName(name), path: skillPath }; if (description !== undefined) descriptor.description = description; descriptors.push(descriptor); } continue; }
          if (name) { const descriptor: PluginComponentDescriptor = { name: slugifyName(name), path: skillPath }; if (description !== undefined) descriptor.description = description; descriptors.push(descriptor); }
        } else {
          if (!await this.fileFetcher.fileExists(targetPath)) continue; let name = nameFromPath(targetPath), description = metadataOnlyMode ? EMPTY_DESCRIPTION : undefined;
          if (!metadataOnlyMode) { const frontmatterFields = readFrontmatter((await this.fileFetcher.fetchFile(targetPath)).content); name = frontmatterFields.name ?? name; description = frontmatterFields.description; }
          if (name) { const descriptor: PluginComponentDescriptor = { name: slugifyName(name), path: targetPath }; if (description !== undefined) descriptor.description = description; descriptors.push(descriptor); }
        }
      } catch {}
    }
    return descriptors;
  }

  private async readMarkdownFolder(folderPath: string, suffixes = MARKDOWN_SUFFIXES, metadataOnlyMode = false, visited = new Set<string>()): Promise<PluginComponentDescriptor[]> {
    let directoryEntries: PluginFileEntry[]; try { directoryEntries = await this.fileFetcher.listDirectory(folderPath, visited); } catch { return []; }
    const files = directoryEntries.filter(item => item.type === "file" && suffixes.some(extension => item.name.endsWith(extension))), directories = directoryEntries.filter(item => item.type === "dir");
    const [fileDescriptors, nestedDescriptors] = await Promise.all([
      Promise.all(files.map(async file => { try { let name = nameFromPath(file.name), description = metadataOnlyMode ? EMPTY_DESCRIPTION : undefined; if (!metadataOnlyMode) { const frontmatterFields = readFrontmatter((await this.fileFetcher.fetchFile(file.path)).content); name = frontmatterFields.name ? slugifyName(frontmatterFields.name) : name; description = frontmatterFields.description; } if (!name) return null; const descriptor: PluginComponentDescriptor = { name, path: file.path }; if (description !== undefined) descriptor.description = description; return descriptor; } catch { return null; } })),
      Promise.all(directories.map(directoryEntry => this.readMarkdownFolder(directoryEntry.path, suffixes, metadataOnlyMode, visited))),
    ]);
    return [...fileDescriptors.filter((descriptor): descriptor is PluginComponentDescriptor => descriptor !== null), ...nestedDescriptors.flat()];
  }

  private async readRootSkill(rootPrefix: string, metadataOnlyMode = false): Promise<PluginComponentDescriptor | null> {
    try {
      const skillPath = `${rootPrefix}SKILL.md`, directoryName = basename(rootPrefix.replace(/[\\/]+$/, "")); let name = metadataOnlyMode ? slugifyName(directoryName || nameFromPath(skillPath)) : slugifyName(directoryName), description = metadataOnlyMode ? EMPTY_DESCRIPTION : undefined;
      if (!metadataOnlyMode) { const frontmatterFields = readFrontmatter((await this.fileFetcher.fetchFile(skillPath)).content); name = frontmatterFields.name ? slugifyName(frontmatterFields.name) : name; description = frontmatterFields.description; if (!name) return null; const descriptor: PluginComponentDescriptor = { disabledEnvironments: frontmatterFields.disabledEnvironments, environments: frontmatterFields.environments, name, path: skillPath }; if (description !== undefined) descriptor.description = description; return descriptor; }
      if (!name) return null; return { name, path: skillPath, ...(description !== undefined ? { description } : {}) };
    } catch { return null; }
  }

  private async readSkillsFolder(skillsPath: string, metadataOnlyMode = false): Promise<PluginComponentDescriptor[]> {
    let directoryEntries: PluginFileEntry[]; try { directoryEntries = await this.fileFetcher.listDirectory(skillsPath); } catch { return []; }
    const descriptors = await Promise.all(directoryEntries.filter(item => item.type === "dir").map(async directoryEntry => {
      try { const skillPath = `${directoryEntry.path}/SKILL.md`; if (!await this.fileFetcher.fileExists(skillPath)) return null; if (metadataOnlyMode) { const name = slugifyName(directoryEntry.name); return name ? { name, path: skillPath, description: EMPTY_DESCRIPTION } : null; } const frontmatterFields = readFrontmatter((await this.fileFetcher.fetchFile(skillPath)).content), name = frontmatterFields.name ? slugifyName(frontmatterFields.name) : slugifyName(directoryEntry.name); if (!name) return null; const descriptor: PluginComponentDescriptor = { disabledEnvironments: frontmatterFields.disabledEnvironments, environments: frontmatterFields.environments, name, path: skillPath }; if (frontmatterFields.description !== undefined) descriptor.description = frontmatterFields.description; return descriptor; } catch { return null; }
    }));
    return descriptors.filter((descriptor): descriptor is PluginComponentDescriptor => descriptor !== null);
  }

  private async readMcpServers(rootPrefix: string, manifestMcpServers: unknown, mcpConfigFiles: readonly string[]): Promise<{ servers: PluginComponentDescriptor[]; variables: DiscoveredPluginComponents["mcpVariables"] }> {
    const fileCache = new Map<string, Promise<string | null>>();
    const readConfigContent = async (relativePath: string): Promise<string | null> => { const cached = fileCache.get(relativePath); if (cached !== undefined) return cached; const pending = this.fileFetcher.fetchFile(`${rootPrefix}${relativePath}`).then(({ content }) => content).catch(() => null); fileCache.set(relativePath, pending); return pending; };
    const resolveManifestConfig = async (precedence: "fill" | "override") => resolvePluginMcpConfigFromReader(readConfigContent, manifestMcpServers, manifestMcpServers !== undefined ? "manifest" : undefined, { fallbackFileNames: mcpConfigFiles, manifestPrecedence: precedence, toSourcePath: relativePath => `${rootPrefix}${relativePath}`, parserOptions: { skipExpansion: true } });
    const resolved = await resolveManifestConfig("fill"); if (resolved?.mcpServers === undefined) return { servers: [], variables: undefined };
    const runtimeConfig = manifestMcpServers === undefined ? resolved : await resolveManifestConfig("override");
    return { servers: Object.keys(resolved.mcpServers).map(name => ({ name: slugifyName(name), path: resolved.mcpServerSourcePaths?.[name] ?? "manifest" })), variables: inferMcpPlaceholderVariables(runtimeConfig ?? resolved) };
  }
}
