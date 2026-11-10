/**
 * The variables a plugin's own files may use to refer to where they are installed.
 *
 * A plugin cannot know its own path, so its files spell it as a variable. Slate's spelling is the primary
 * one; bundles written for other hosts are expanded through the interop adapter.
 */
import {
  EXTERNAL_PLUGIN_ROOT_VARIABLES,
  SLATE_PLUGIN_ROOT_VARIABLE,
} from "../../adapters/interop/plugin-marketplace/plugin-root-variables-adapter.ts";

const PLUGIN_ROOT_VARIABLE_NAMES = [SLATE_PLUGIN_ROOT_VARIABLE, ...EXTERNAL_PLUGIN_ROOT_VARIABLES] as const;

/** The pattern a file spells the install path with, for one of those names. */
const pluginRootPattern = (name: string): RegExp => new RegExp(`\\$\\{${name}\\}`, "g");

/** The value with every recognized spelling of the install path replaced by the path itself. */
export function expandPluginVariables(value: string, pluginPath: string): string {
  return PLUGIN_ROOT_VARIABLE_NAMES.reduce(
    (expanded, name) => expanded.replace(pluginRootPattern(name), () => pluginPath),
    value,
  );
}
