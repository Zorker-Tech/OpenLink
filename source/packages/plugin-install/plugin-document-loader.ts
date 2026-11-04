import { readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import matter from "gray-matter";
import { detectHookConfigDialect, transformForeignHookConfig } from "../../adapters/interop/hooks/foreign-hook-config-adapter.ts";
import type { HookConfig } from "../hooks/hook-config.ts";
import { validateHookConfig } from "../hooks/hook-config-validation.ts";
import { PluginComponentDiscovery, type PluginComponentDescriptor, type PluginFileFetcher } from "./component-discovery.ts";
import { isPathSafe, parsePluginManifest, PLUGIN_MANIFEST_PATHS, type PluginManifest } from "./manifest-parser.ts";
import { resolvePluginMcpConfigPaths, resolvePluginMcpConfigWithManifestLookup, type McpParserOptions } from "./mcp-parser.ts";
import { expandPluginVariables } from "./plugin-variables.ts";
import { noopPluginMetricsLogger, type PluginMetricsLogger } from "./types.ts";
import { assertPluginFileWithinLimit, createLocalPluginFileFetcher, isPluginFileSymlink, readPluginTextWithoutSymlink } from "./plugin-file-fetcher.ts";
import type { LoadedAgent, LoadedCommand, LoadedPlugin, LoadedSkill, MarketplacePluginSourceInfo, PluginFileContent, PluginHooksResult } from "./plugin-loader-contracts.ts";

interface PluginManifestRead {
  readonly path: string;
  readonly sections?: Pick<PluginManifest, "commands" | "agents" | "skills" | "rules" | "hooks" | "mcpServers"> | undefined;
  readonly details?: {
    readonly displayName?: string | undefined;
    readonly description?: string | undefined;
    readonly authorName?: string | undefined;
    readonly variables?: PluginManifest["variables"];
    readonly capabilities?: string[] | undefined;
  } | undefined;
}

type HookCheck = { readonly config: HookConfig } | { readonly error: { readonly source: "plugin-manifest"; readonly message: string } };

function hasManifestSections(manifest: PluginManifest): boolean {
  return manifest.commands !== undefined
    || manifest.agents !== undefined
    || manifest.skills !== undefined
    || manifest.rules !== undefined
    || manifest.hooks !== undefined
    || manifest.mcpServers !== undefined;
}

function readManifestDetails(manifest: PluginManifest): PluginManifestRead["details"] {
  const description = typeof manifest.description === "string" ? manifest.description : undefined;
  const displayName = typeof manifest.displayName === "string" ? manifest.displayName : undefined;
  const authorName = manifest.author?.name;
  const variables = manifest.variables;
  const capabilities = manifest.capabilities;
  if (description === undefined && displayName === undefined && authorName === undefined && variables === undefined && capabilities === undefined) {
    return undefined;
  }
  return { description, displayName, authorName, variables, capabilities };
}

async function readPluginManifest(
  installPath: string,
  displayId: string,
  logger: PluginMetricsLogger,
): Promise<PluginManifestRead | undefined> {
  for (const relativePath of PLUGIN_MANIFEST_PATHS) {
    const fullPath = join(installPath, relativePath);
    let sourceText: string;
    try {
      if (await isPluginFileSymlink(fullPath)) continue;
      if (!(await stat(fullPath)).isFile()) continue;
      await assertPluginFileWithinLimit(fullPath);
      sourceText = await readPluginTextWithoutSymlink(fullPath);
    } catch {
      continue;
    }

    const parsed = parsePluginManifest(sourceText);
    if (!parsed.success) continue;
    const sections = hasManifestSections(parsed.data)
      ? {
          commands: parsed.data.commands,
          agents: parsed.data.agents,
          skills: parsed.data.skills,
          rules: parsed.data.rules,
          hooks: parsed.data.hooks,
          mcpServers: parsed.data.mcpServers,
        }
      : undefined;
    const details = readManifestDetails(parsed.data);
    if (sections === undefined && details === undefined) continue;
    if (parsed.unrecognizedSchemaId !== undefined) {
      logger.log("warn", `${displayId}: ${relativePath} declares an unrecognized $schema, loading anyway: ${parsed.unrecognizedSchemaId}`);
    }
    return { path: fullPath, sections, details };
  }
  return undefined;
}

function normalizeStringList(value: unknown): string[] | undefined {
  const candidates = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? value.split(",")
      : [];
  const clean = candidates.map((item) => item.trim()).filter((item) => item.length > 0);
  return clean.length === 0 ? undefined : clean;
}

function globsFromText(value: string): string[] {
  const output: string[] = [];
  let itemStart = 0;
  let nestedBraces = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "{") nestedBraces += 1;
    else if (character === "}" && nestedBraces > 0) nestedBraces -= 1;
    else if (character === "," && nestedBraces === 0) {
      const item = value.slice(itemStart, index).trim();
      if (item.length > 0) output.push(item);
      itemStart = index + 1;
    }
  }
  const lastItem = value.slice(itemStart).trim();
  if (lastItem.length > 0) output.push(lastItem);
  return output;
}

function parseGlobs(value: unknown): string[] | undefined {
  const parsed = typeof value === "string"
    ? globsFromText(value)
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
      : [];
  return parsed.length === 0 ? undefined : parsed;
}

function fallbackSkillName(relativePath: string): string {
  const pathParts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  const leaf = pathParts.at(-1) ?? relativePath;
  return pathParts.length > 1 ? pathParts.at(-2)! : leaf.replace(/\.md$/i, "");
}

function parseSkillFile(sourceText: string, relativePath: string): LoadedSkill | null {
  try {
    const document = matter(sourceText);
    const fields = document.data as Record<string, unknown>;
    const extra = fields.metadata as Record<string, unknown> | undefined;
    const declaredName = typeof fields.name === "string" ? fields.name.trim() : "";
    const environmentValues = normalizeStringList(fields.environments ?? extra?.environments);
    const disabledValues = normalizeStringList(fields["disabled-environments"] ?? extra?.disabledEnvironments);
    const globs = parseGlobs(fields.globs);
    return {
      path: relativePath,
      name: declaredName.length > 0 ? declaredName : fallbackSkillName(relativePath),
      description: typeof fields.description === "string" ? fields.description : undefined,
      globs,
      alwaysApply: fields.alwaysApply === true,
      content: sourceText,
      environments: environmentValues,
      disabledEnvironments: disabledValues,
    };
  } catch {
    return null;
  }
}

function permissionModeFrom(raw: unknown): "readonly" | "default" {
  return typeof raw === "string" && raw.trim().toLowerCase() === "readonly" ? "readonly" : "default";
}

function toolsFrom(raw: unknown): string[] | undefined {
  if (typeof raw === "string") return normalizeStringList(raw);
  if (!Array.isArray(raw)) return undefined;
  const names = raw.map((item) => typeof item === "string" ? item.trim() : String(item)).filter(Boolean);
  return names.length === 0 ? undefined : names;
}

function parseAgentFile(sourceText: string, relativePath: string): LoadedAgent | null {
  try {
    const document = matter(sourceText);
    const fields = document.data as Record<string, unknown>;
    const prompt = document.content.trim();
    if (prompt.length === 0) return null;
    const fileName = basename(relativePath);
    const declaredName = typeof fields.name === "string"
      ? fields.name
      : basename(fileName, extname(fileName)).replace(/[\s_]+/g, "-");
    const rawPermission = fields.permissionMode ?? fields.permissionmode;
    return {
      path: relativePath,
      name: declaredName,
      description: typeof fields.description === "string" ? fields.description : undefined,
      tools: toolsFrom(fields.tools),
      model: typeof fields.model === "string" ? fields.model : "inherit",
      prompt,
      permissionMode: permissionModeFrom(rawPermission),
    };
  } catch {
    return null;
  }
}

function argumentHintFrom(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return `[${value.join(" ")}]`;
  return undefined;
}

function parseCommandFile(sourceText: string, relativePath: string): LoadedCommand | null {
  try {
    const document = matter(sourceText);
    const fields = document.data as Record<string, unknown>;
    const fileName = basename(relativePath);
    return {
      path: relativePath,
      name: typeof fields.name === "string" ? fields.name : basename(fileName, extname(fileName)),
      description: typeof fields.description === "string" ? fields.description : undefined,
      argumentHint: argumentHintFrom(fields["argument-hint"]),
      content: document.content.trim(),
    };
  } catch {
    return null;
  }
}

type ContentParser<T> = (sourceText: string, relativePath: string) => T | null;

async function readDiscoveredFiles<T>(
  fetcher: PluginFileFetcher,
  descriptors: readonly PluginComponentDescriptor[],
  installPath: string,
  parser: ContentParser<T>,
): Promise<T[]> {
  const parsedItems: T[] = [];
  for (const item of descriptors) {
    try {
      const fileContent = await fetcher.fetchFile(item.path);
      const expandedText = expandPluginVariables(fileContent.content, installPath);
      const parsedItem = parser(expandedText, item.path);
      if (parsedItem !== null) parsedItems.push(parsedItem);
    } catch {
      // A component that cannot be read is omitted while its plugin remains loadable.
    }
  }
  return parsedItems;
}

async function readPluginComponents(
  installPath: string,
  manifest?: PluginManifestRead["sections"],
): Promise<Pick<PluginFileContent, "skills" | "rules" | "agents" | "commands">> {
  const fetcher = createLocalPluginFileFetcher(installPath);
  const discovered = await new PluginComponentDiscovery(fetcher).discoverComponents({ manifest });
  const [skills, agents, commands, rules] = await Promise.all([
    readDiscoveredFiles(fetcher, discovered.skills, installPath, parseSkillFile),
    readDiscoveredFiles(fetcher, discovered.agents, installPath, parseAgentFile),
    readDiscoveredFiles(fetcher, discovered.commands, installPath, parseCommandFile),
    readDiscoveredFiles(fetcher, discovered.rules, installPath, (sourceText, relativePath) => {
      const skill = parseSkillFile(sourceText, relativePath);
      if (skill === null) return null;
      const descriptor = discovered.rules.find((candidate) => candidate.path === relativePath);
      return descriptor === undefined ? skill : { ...skill, name: descriptor.name };
    }),
  ]);
  return { skills, agents, commands, rules };
}

function mcpOptionsFor(sourceInfo?: MarketplacePluginSourceInfo): McpParserOptions | undefined {
  if (sourceInfo === undefined) return undefined;
  return { configuredVariables: sourceInfo.configuredVariables as Readonly<Record<string, unknown>> | undefined };
}

function mcpConfigFileReader(installPath: string) {
  return async (relativePath: string): Promise<string | null> => {
    if (!isPathSafe(relativePath)) return null;
    const fullPath = join(installPath, relativePath);
    try {
      if (await isPluginFileSymlink(fullPath)) return null;
      if (!(await stat(fullPath)).isFile()) return null;
      await assertPluginFileWithinLimit(fullPath);
      return await readPluginTextWithoutSymlink(fullPath);
    } catch {
      return null;
    }
  };
}

async function readPluginMcpConfig(
  installPath: string,
  sourceInfo: MarketplacePluginSourceInfo | undefined,
  explicitOptions?: McpParserOptions,
): Promise<PluginFileContent["mcpConfig"]> {
  const parserOptions = explicitOptions ?? mcpOptionsFor(sourceInfo);
  return resolvePluginMcpConfigWithManifestLookup(mcpConfigFileReader(installPath), {
    fallbackFileNames: resolvePluginMcpConfigPaths(),
    manifestPrecedence: "override",
    toSourcePath: (relativePath) => join(installPath, relativePath),
    installPathForExpansion: installPath,
    parserOptions,
  });
}

function expandHookScripts(config: HookConfig, installPath: string): HookConfig {
  const rewrittenHooks: HookConfig["hooks"] = {};
  for (const [hookName, scripts] of Object.entries(config.hooks)) {
    if (!Array.isArray(scripts)) continue;
    rewrittenHooks[hookName] = scripts.map((script) => {
      if ("command" in script && typeof script.command === "string") {
        return { ...script, command: expandPluginVariables(script.command, installPath) };
      }
      if ("prompt" in script && typeof script.prompt === "string") {
        return { ...script, prompt: expandPluginVariables(script.prompt, installPath) };
      }
      return script;
    });
  }
  return { ...config, hooks: rewrittenHooks };
}

function validateHookShape(parsed: unknown, pluginLabel: string): HookCheck | undefined {
  const dialect = detectHookConfigDialect(parsed);
  let candidate: HookConfig | undefined;
  if (dialect === "direct-scripts") candidate = parsed as HookConfig;
  else if (dialect === "nested-matcher-scripts") {
    const hooks = (parsed as { hooks?: Record<string, unknown> } | null)?.hooks;
    if (hooks === undefined || Object.keys(hooks).length === 0) return undefined;
    candidate = transformForeignHookConfig(hooks);
  }
  if (candidate === undefined) return undefined;

  const validation = validateHookConfig(candidate);
  if (validation.isValid) return { config: candidate };
  return {
    error: {
      source: "plugin-manifest",
      message: `Plugin ${pluginLabel} hooks: ${validation.errors.join("; ")}`,
    },
  };
}

function hooksFromManifestObject(
  rawHooks: object,
  installPath: string,
  pluginLabel: string,
  manifestPath?: string,
): PluginHooksResult | undefined {
  const result = validateHookShape(rawHooks, pluginLabel);
  if (result === undefined || "error" in result) return result;
  return {
    config: expandHookScripts(result.config, installPath),
    ...(manifestPath === undefined ? {} : { sourcePath: manifestPath }),
  };
}

function hookFilePath(installPath: string, rawHooks: unknown): string | undefined {
  if (typeof rawHooks !== "string") return join(installPath, "hooks", "hooks.json");
  const relativePath = rawHooks.replace(/^\.\//, "");
  if (!isPathSafe(relativePath)) return undefined;
  return relativePath.endsWith(".json")
    ? join(installPath, relativePath)
    : join(installPath, relativePath, "hooks.json");
}

async function readPluginHooks(
  installPath: string,
  pluginLabel: string,
  rawHooks: unknown,
  manifestPath?: string,
): Promise<PluginHooksResult | undefined> {
  if (typeof rawHooks === "object" && rawHooks !== null) {
    return hooksFromManifestObject(rawHooks, installPath, pluginLabel, manifestPath);
  }
  const fullPath = hookFilePath(installPath, rawHooks);
  if (fullPath === undefined) return undefined;
  try {
    if (await isPluginFileSymlink(fullPath) || !(await stat(fullPath)).isFile()) return undefined;
  } catch {
    return undefined;
  }

  let sourceText: string;
  try {
    await assertPluginFileWithinLimit(fullPath);
    sourceText = await readFile(fullPath, "utf-8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch {
    return { error: { source: "plugin-manifest", message: `Plugin ${pluginLabel} ${fullPath}: invalid JSON` } };
  }
  const result = validateHookShape(parsed, pluginLabel);
  if (result === undefined || "error" in result) return result;
  return { config: expandHookScripts(result.config, installPath), sourcePath: fullPath };
}

async function readPluginDirectory(
  installPath: string,
  pluginLabel: string,
  sourceInfo: MarketplacePluginSourceInfo | undefined,
  options?: { readonly log?: PluginMetricsLogger | undefined; readonly configuredVariables?: Readonly<Record<string, unknown>> | undefined },
): Promise<PluginFileContent> {
  const logger = options?.log ?? noopPluginMetricsLogger;
  const manifest = await readPluginManifest(installPath, pluginLabel, logger);
  const configuredVariables = sourceInfo === undefined
    ? options?.configuredVariables
    : sourceInfo.configuredVariables as Readonly<Record<string, unknown>> | undefined;
  const parserOptions: McpParserOptions = { configuredVariables, log: logger };
  const [components, mcpConfig, hooks] = await Promise.all([
    readPluginComponents(installPath, manifest?.sections),
    readPluginMcpConfig(installPath, sourceInfo, parserOptions),
    readPluginHooks(installPath, pluginLabel, manifest?.sections?.hooks, manifest?.path),
  ]);
  const details = manifest?.details;
  return {
    ...components,
    displayName: details?.displayName,
    description: details?.description,
    authorName: details?.authorName,
    variablesSchema: details?.variables,
    mcpConfig,
    capabilities: details?.capabilities ?? [],
    hooks,
  };
}

export async function loadPluginFromPath(
  installPath: string,
  source: LoadedPlugin["identifier"]["source"],
  sourceInfo: MarketplacePluginSourceInfo,
  options?: { readonly log?: PluginMetricsLogger | undefined },
): Promise<LoadedPlugin> {
  const pluginLabel = `${sourceInfo.name}@${sourceInfo.version}`;
  const content = await readPluginDirectory(installPath, pluginLabel, sourceInfo, { log: options?.log });
  return {
    identifier: { source, sourceInfo },
    installPath,
    ...(content.displayName === undefined ? {} : { displayName: content.displayName }),
    ...(content.description === undefined ? {} : { description: content.description }),
    ...(content.authorName === undefined ? {} : { authorName: content.authorName }),
    variablesSchema: content.variablesSchema,
    skills: content.skills,
    rules: content.rules,
    agents: content.agents,
    commands: content.commands,
    mcpConfig: content.mcpConfig ?? undefined,
    capabilities: content.capabilities,
    hooks: content.hooks,
  };
}
