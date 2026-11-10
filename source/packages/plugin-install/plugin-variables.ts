/**
 * The variables a Slate plugin's own files may use to refer to where they are installed.
 *
 * A plugin cannot know its own path, so its files spell it as `${SLATE_PLUGIN_ROOT}`.
 */

export const SLATE_PLUGIN_ROOT_VARIABLE = "SLATE_PLUGIN_ROOT"

export const LOADER_PROVIDED_PLUGIN_VARIABLES: ReadonlySet<string> = new Set([SLATE_PLUGIN_ROOT_VARIABLE])

const pluginRootPattern = new RegExp(`\\$\\{${SLATE_PLUGIN_ROOT_VARIABLE}\\}`, "g")

/** The value with the install-path variable replaced by the path itself. */
export function expandPluginVariables(value: string, pluginPath: string): string {
  return value.replace(pluginRootPattern, () => pluginPath)
}
