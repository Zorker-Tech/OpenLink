/** How an attachment is previewed: which kinds can be shown, and what to say when one cannot. */
import { attachmentExtension } from "./attachment-open-policy.ts";

const TEXT_PREVIEWABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  "adoc", "astro", "bash", "bat", "c", "cc", "cfg", "cjs", "conf", "cpp",
  "cs", "css", "csv", "cts", "cxx", "dart", "diff", "dockerfile", "env", "fish",
  "go", "gql", "gradle", "graphql", "h", "hh", "hpp", "htm", "html", "ini",
  "java", "js", "json", "json5", "jsonc", "jsx", "kt", "kts", "less", "log",
  "lua", "markdown", "md", "mdx", "mjs", "mts", "ndjson", "patch", "php", "pl",
  "plist", "pm", "properties", "proto", "ps1", "py", "pyi", "r", "rb", "rs",
  "rst", "sass", "scala", "scss", "sh", "sql", "svelte", "svg", "swift", "tex",
  "text", "tf", "tfvars", "toml", "ts", "tsv", "tsx", "txt", "vue", "xml",
  "yaml", "yml", "zsh",
])

export function isTextPreviewableName(nameOrPath: string): boolean {
  const extension = attachmentExtension(nameOrPath);
  return extension !== null && TEXT_PREVIEWABLE_EXTENSIONS.has(extension)
}

export const BINARY_SNIFF_BYTE_WINDOW = 8 * 1024;
export const BINARY_CONTROL_BYTE_RATIO = 0.3;

export function looksLikeBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, BINARY_SNIFF_BYTE_WINDOW))
  if (sample.length === 0) return false

  let nonTextControls = 0
  for (let offset = 0; offset < sample.length; offset += 1) {
    const byte = sample[offset]!
    if (byte === 0) return true
    const isWhitespaceControl = byte >= 9 && byte <= 13
    if (byte < 32 && !isWhitespaceControl) nonTextControls += 1
  }
  return nonTextControls / sample.length > BINARY_CONTROL_BYTE_RATIO
}
