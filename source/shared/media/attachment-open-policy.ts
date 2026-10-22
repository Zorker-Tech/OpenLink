/** The last path segment of an attachment's name, which is the file the name points at. */
function fileNameOf(nameOrPath: string): string {
  const segments = nameOrPath.split(/[/\\]/);
  return segments[segments.length - 1] ?? "";
}

/** The extension an attachment's name ends with, lower-cased, or nothing when the name has none. */
export function attachmentExtension(nameOrPath: string): string | null {
  const name = fileNameOf(nameOrPath);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}
