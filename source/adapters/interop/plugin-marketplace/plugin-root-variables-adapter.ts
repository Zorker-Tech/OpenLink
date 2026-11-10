/**
 * Plugin install-path variables.
 *
 * Slate's own plugin format spells the install path with its own variable. Plugin bundles written for other
 * hosts are still read, so their spellings are recognized here rather than throughout the installer.
 */

export const SLATE_PLUGIN_ROOT_VARIABLE = "SLATE_PLUGIN_ROOT"

export const EXTERNAL_PLUGIN_ROOT_VARIABLES = ["CLAUDE_PLUGIN_ROOT", "CURSOR_PLUGIN_ROOT"] as const

export const LOADER_PROVIDED_PLUGIN_VARIABLES: ReadonlySet<string> = new Set([
  SLATE_PLUGIN_ROOT_VARIABLE,
  ...EXTERNAL_PLUGIN_ROOT_VARIABLES,
])
