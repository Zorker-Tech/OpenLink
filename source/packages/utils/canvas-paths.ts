/**
 * Canvas paths.
 *
 * A canvas is a platform-managed file (a `.canvas.tsx` under the workspace's canvas directory) and
 * the agent is allowed to treat it as editable, unlike the rest of the managed directory. Because a
 * path can arrive with `..` or backslashes, it is normalized before it is judged.
 */

const MANAGED_CANVAS_PATTERN = /(?:^|\/)\.slate\/projects\/[^/]+\/canvases\/[^/]+\.canvas\.tsx$/i

/** Collapses `.`/`..` and backslashes without touching the filesystem. */
export function normalizeCanvasPath(value: string): string {
  const segments: string[] = []
  for (const segment of value.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") segments.pop()
    else segments.push(segment)
  }
  return segments.join("/")
}

export const isManagedCanvasPath = (value: string): boolean => MANAGED_CANVAS_PATTERN.test(normalizeCanvasPath(value))
