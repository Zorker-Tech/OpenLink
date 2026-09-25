/**
 * A path inside a plugin, refused if it leaves the plugin.
 *
 * A manifest names files by a path relative to the plugin's own directory; a path that resolves outside that directory
 * is not a file of this plugin, and is refused rather than read.
 */
import { isAbsolute, relative, resolve } from "node:path";
export function validateAndResolveSubpath(baseDir: string, subPath: string): string {
  const resolvedBase = resolve(baseDir), resolved = resolve(baseDir, subPath), rel = relative(resolvedBase, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Invalid subPath: path traversal not allowed (${JSON.stringify(subPath)})`);
  return resolved;
}
