import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import { synthesizeInlinePluginDir } from "../../source/packages/plugin-install/inline-plugin-synthesizer.ts";

function currentOperatingSystemName(): string {
  return process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "Macintosh" : "Linux";
}

describe("inline plugin synthesis behavior", () => {
  it("writes active rules, commands, compatible hooks, MCP config and their manifest paths", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "slate-inline-plugin-contract-"));
    try {
      await synthesizeInlinePluginDir({
        targetDir,
        pluginName: "First Party",
        inlineContentJson: JSON.stringify({
          rules: [
            { name: "unsafe: rule", content: "rule body", globs: ["**/*.ts", "src:*.ts"], isRequired: true },
            { name: "inactive", content: "skip", isActive: false },
            { name: "empty", content: "" },
          ],
          commands: [
            { name: "setup", content: "command body", description: 'deploy: "safely"' },
            { name: "disabled", content: "skip", isActive: false },
          ],
          hooks: [
            { hookStep: "afterAgentThought", hookType: "prompt", promptContent: "review this", promptModel: "local-model", operatingSystems: [currentOperatingSystemName()] },
            { hookStep: "afterAgentThought", hookType: "prompt", promptContent: "wrong platform", operatingSystems: ["Unsupported"] },
            { hookStep: "beforeShellExecution", hookType: "command", operatingSystems: [currentOperatingSystemName()] },
            { hookStep: "toString", hookType: "command", scriptContent: "safe property name" },
            { hookStep: "ignored", hookType: "command", isActive: false, scriptContent: "skip" },
            { hookType: "command", scriptContent: "no step" },
          ],
          mcpServers: [
            { name: "local", config: { command: "node", args: ["server.js"] } },
            { name: "__proto__", config: { command: "safe" } },
            { name: "empty", config: null },
          ],
        }),
      });

      const manifest = JSON.parse(readFileSync(join(targetDir, ".cursor-plugin", "plugin.json"), "utf8")) as {
        name: string;
        rules?: string[];
        commands?: string[];
      };
      assert.equal(manifest.name, "First Party");
      assert.equal(manifest.rules?.length, 1);
      assert.deepEqual(manifest.commands, ["commands/setup.md"]);
      const rulePath = manifest.rules![0]!;
      assert.equal(readdirSync(join(targetDir, "rules")).length, 1);
      assert.equal(readFileSync(join(targetDir, rulePath), "utf8"),
        '---\ndescription: "unsafe: rule"\nglobs: "**/*.ts, src:*.ts"\nalwaysApply: true\n---\n\nrule body');
      assert.equal(readFileSync(join(targetDir, "commands", "setup.md"), "utf8"),
        '---\ndescription: "deploy: \\\"safely\\\""\n---\n\ncommand body');
      assert.deepEqual(JSON.parse(readFileSync(join(targetDir, "hooks", "hooks.json"), "utf8")), {
        version: 1,
        hooks: {
          afterAgentThought: [{ type: "prompt", prompt: "review this", model: "local-model" }],
          beforeShellExecution: [{ type: "command", command: "" }],
          toString: [{ type: "command", command: "safe property name" }],
        },
      });
      const mcp = JSON.parse(readFileSync(join(targetDir, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
      assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ["__proto__", "local"]);
      assert.deepEqual(mcp.mcpServers.local, { command: "node", args: ["server.js"] });
      assert.deepEqual(mcp.mcpServers["__proto__"], { command: "safe" });
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("writes an empty manifest without adding disabled files or empty MCP configuration", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "slate-inline-plugin-empty-"));
    try {
      await synthesizeInlinePluginDir({
        targetDir,
        pluginName: "empty-plugin",
        inlineContentJson: JSON.stringify({
          rules: [{ name: "disabled", content: "skip", isActive: false }],
          commands: [{ name: "disabled", content: "skip", isActive: false }],
          hooks: [{ hookStep: "beforeShellExecution", hookType: "command", operatingSystems: ["Unsupported"] }],
          mcpServers: [{ name: "none", config: null }],
        }),
      });
      assert.deepEqual(JSON.parse(readFileSync(join(targetDir, ".cursor-plugin", "plugin.json"), "utf8")), { name: "empty-plugin" });
      assert.equal(readFileSync(join(targetDir, "hooks", "hooks.json"), "utf8"), JSON.stringify({ version: 1, hooks: {} }, null, 2));
      assert.equal(readdirSync(join(targetDir, "rules")).length, 0);
      assert.equal(readdirSync(join(targetDir, "commands")).length, 0);
      assert.equal(readdirSync(targetDir).includes(".mcp.json"), false);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
