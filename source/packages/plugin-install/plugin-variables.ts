/**
 * The variables a plugin's own files may use to refer to where they are installed.
 *
 * A plugin cannot know its own path, so its files spell it as a variable. Both spellings are expanded, because the
 * plugin format is shared with another host whose files use its own name for the same thing.
 */
export function expandPluginVariables(value: string, pluginPath: string): string {
  return value
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => pluginPath)
    .replace(/\$\{CURSOR_PLUGIN_ROOT\}/g, () => pluginPath);
}
