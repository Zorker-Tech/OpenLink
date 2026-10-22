/**
 * A path inside a plugin, refused if it leaves the plugin.
 *
 * A manifest names files by a path relative to the plugin's own directory; a path that resolves outside that directory
 * is not a file of this plugin, and is refused rather than read.
 */
import { isAbsolute, relative, resolve } from "node:path";

/** The refusal a subpath outside the plugin carries, naming the path that was asked for. */
function traversalRefusal(subPath: string): Error {
  return new Error(`Invalid subPath: path traversal not allowed (${JSON.stringify(subPath)})`);
}

/** Whether a path relative to the plugin's directory still points inside it. */
function staysInsideBase(relPath: string): boolean {
  return !relPath.startsWith("..") && !isAbsolute(relPath);
}

export function validateAndResolveSubpath(baseDir: string, subPath: string): string {
  const resolvedBase = resolve(baseDir);
  const resolved = resolve(baseDir, subPath);
  if (!staysInsideBase(relative(resolvedBase, resolved))) throw traversalRefusal(subPath);
  return resolved;
}
