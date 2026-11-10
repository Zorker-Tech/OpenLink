/** Canvas documents are the one workspace-managed file shape the editor may change directly. */

const WORKSPACE_CANVAS_DOCUMENT_PATTERN = /(?:^|\/)\.slate\/projects\/[^/]+\/canvases\/[^/]+\.canvas\.tsx$/i

/** Convert path syntax to a stable workspace-relative form without consulting the filesystem. */
export function canonicalizeWorkspacePath(value: string): string {
  const components: string[] = []
  const segments = value.replace(/\\/g, "/").split("/")

  for (const segment of segments) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      components.pop()
      continue
    }
    components.push(segment)
  }

  return components.join("/")
}

export function isWorkspaceCanvasDocument(value: string): boolean {
  return WORKSPACE_CANVAS_DOCUMENT_PATTERN.test(canonicalizeWorkspacePath(value))
}
