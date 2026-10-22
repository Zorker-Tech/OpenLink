/**
 * The variables a plugin's own files may use to refer to where they are installed.
 *
 * A plugin cannot know its own path, so its files spell it as a variable. Both spellings are expanded, because the
 * plugin format is shared with another host whose files use its own name for the same thing.
 */

/** The names a plugin's own files may use for its install path: the shared format's and this platform's. */
const PLUGIN_ROOT_VARIABLE_NAMES = ["CLAUDE_PLUGIN_ROOT", "CURSOR_PLUGIN_ROOT"] as const;

/** The pattern a file spells the install path with, for one of those names. */
const pluginRootPattern = (name: string): RegExp => new RegExp(`\\$\\{${name}\\}`, "g");

/** The value with both spellings of the install path replaced by the path itself. */
export function expandPluginVariables(value: string, pluginPath: string): string {
  const [sharedFormatName, platformName] = PLUGIN_ROOT_VARIABLE_NAMES;
  return value
    .replace(pluginRootPattern(sharedFormatName), () => pluginPath)
    .replace(pluginRootPattern(platformName), () => pluginPath);
}
