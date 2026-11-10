import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { preferredPluginManifestRootDirectory } from "../../adapters/interop/plugin-marketplace/plugin-manifest-adapter.ts";
import { sanitizeFilename } from "../utils/managed-paths.ts";
import type { InlineContent, InlineHook, InlineManifestPaths } from "./inline-plugin-contracts.ts";
import { inlineHookAppliesToThisPlatform } from "./inline-plugin-platform.ts";
import { quoteInlineYamlScalar } from "./inline-plugin-yaml.ts";

function hookRow(hook: InlineHook): Record<string, string> {
  if (hook.hookType !== "prompt") return { type: "command", command: hook.scriptContent ?? "" };
  return {
    type: "prompt",
    prompt: hook.promptContent ?? "",
    ...(hook.promptModel ? { model: hook.promptModel } : {}),
  };
}

export class InlinePluginWriter {
  private readonly manifestPaths: InlineManifestPaths = {};

  constructor(
    private readonly targetDir: string,
    private readonly content: InlineContent,
  ) {}

  async write(pluginName: string): Promise<void> {
    await mkdir(this.targetDir, { recursive: true });
    await this.writeRules();
    await this.writeCommands();
    await this.writeHooks();
    await this.writeMcpConfiguration();

    const manifestDirectory = join(this.targetDir, preferredPluginManifestRootDirectory);
    await mkdir(manifestDirectory, { recursive: true });
    const manifest = { name: pluginName, ...this.manifestPaths };
    await writeFile(join(manifestDirectory, "plugin.json"), JSON.stringify(manifest, null, 2), "utf-8");
  }

  private async writeRules(): Promise<void> {
    const rules = this.content.rules;
    if (rules == null || rules.length === 0) return;

    const directory = join(this.targetDir, "rules");
    await mkdir(directory, { recursive: true });
    const publishedPaths: string[] = [];
    for (const rule of rules) {
      if (!rule.content || rule.isActive === false) continue;
      const fileName = `${sanitizeFilename(rule.name)}.md`;
      const metadata = [
        `description: ${quoteInlineYamlScalar(rule.name)}`,
        ...(rule.globs && rule.globs.length > 0 ? [`globs: ${quoteInlineYamlScalar(rule.globs.join(", "))}`] : []),
        `alwaysApply: ${rule.isRequired === true}`,
      ];
      const document = `---\n${metadata.join("\n")}\n---\n\n${rule.content}`;
      await writeFile(join(directory, fileName), document, "utf-8");
      publishedPaths.push(`rules/${fileName}`);
    }
    if (publishedPaths.length > 0) this.manifestPaths.rules = publishedPaths;
  }

  private async writeCommands(): Promise<void> {
    const commands = this.content.commands;
    if (commands == null || commands.length === 0) return;

    const directory = join(this.targetDir, "commands");
    await mkdir(directory, { recursive: true });
    const publishedPaths: string[] = [];
    for (const command of commands) {
      if (!command.content || command.isActive === false) continue;
      const fileName = `${sanitizeFilename(command.name)}.md`;
      const header = command.description
        ? `---\ndescription: ${quoteInlineYamlScalar(command.description)}\n---\n\n`
        : "";
      await writeFile(join(directory, fileName), `${header}${command.content}`, "utf-8");
      publishedPaths.push(`commands/${fileName}`);
    }
    if (publishedPaths.length > 0) this.manifestPaths.commands = publishedPaths;
  }

  private async writeHooks(): Promise<void> {
    const hooks = this.content.hooks;
    if (hooks == null || hooks.length === 0) return;

    const directory = join(this.targetDir, "hooks");
    await mkdir(directory, { recursive: true });
    const configuration: Record<string, unknown[]> = Object.create(null) as Record<string, unknown[]>;
    for (const hook of hooks) {
      const step = hook.hookStep;
      if (!step || hook.isActive === false || !inlineHookAppliesToThisPlatform(hook)) continue;
      const rows = configuration[step] ?? (configuration[step] = []);
      rows.push(hookRow(hook));
    }
    await writeFile(join(directory, "hooks.json"), JSON.stringify({ version: 1, hooks: configuration }, null, 2), "utf-8");
  }

  private async writeMcpConfiguration(): Promise<void> {
    const servers = this.content.mcpServers;
    if (servers == null || servers.length === 0) return;

    const configuration: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const server of servers) {
      if (server.config) configuration[server.name] = server.config;
    }
    if (Object.keys(configuration).length === 0) return;
    const path = join(this.targetDir, ".mcp.json");
    await writeFile(path, JSON.stringify({ mcpServers: configuration }, null, 2), "utf-8");
  }
}
