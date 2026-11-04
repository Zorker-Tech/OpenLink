import type { InlineContent } from "./inline-plugin-contracts.ts";
import { InlinePluginWriter } from "./inline-plugin-writer.ts";

export async function synthesizeInlinePluginDir(options: {
  targetDir: string;
  inlineContentJson: string;
  pluginName: string;
}): Promise<void> {
  const content = JSON.parse(options.inlineContentJson) as InlineContent;
  const writer = new InlinePluginWriter(options.targetDir, content);
  await writer.write(options.pluginName);
}
