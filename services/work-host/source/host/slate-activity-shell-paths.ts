const IGNORED_OUTPUT_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);
const OUTPUT_REDIRECT = /(?<![\d>&])>{1,2}\s*([^&\s;|<>]+)/;
const TEE_OUTPUT = /\btee\s+(?:-[a-zA-Z]+\s+)*([^\s;|&<>-][^\s;|&<>]*)/;
const IN_PLACE_SED = /\bsed\b[^;|&]*\s-i\b/;

function withoutWrappingQuote(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function basenameOfPath(path: string | undefined): string | undefined {
  return path?.split(/[\\/]/).filter(Boolean).at(-1);
}

/** Read a JSON object argument and refuse scalar or collection values. */
export function parseArgsJson(raw?: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function fileBasename(path?: string): string | undefined {
  return basenameOfPath(path);
}

export function urlHostname(raw?: string): string | undefined {
  try {
    if (raw == null) return undefined;
    return new URL(raw).hostname || undefined;
  } catch {
    return undefined;
  }
}

function usableOutputPath(candidate: string | undefined): string | undefined {
  if (candidate === undefined) return undefined;
  const path = withoutWrappingQuote(candidate);
  return IGNORED_OUTPUT_TARGETS.has(path) ? undefined : path;
}

function redirectedTarget(command: string): string | undefined {
  return usableOutputPath(OUTPUT_REDIRECT.exec(command)?.[1]);
}

function teeTarget(command: string): string | undefined {
  return usableOutputPath(TEE_OUTPUT.exec(command)?.[1]);
}

function inPlaceSedTarget(command: string): string | undefined {
  if (!IN_PLACE_SED.test(command)) return undefined;
  const path = command.trim()
    .split(/\s+/)
    .map(withoutWrappingQuote)
    .reverse()
    .find((token) => /[\\/]/.test(token) || /\.[A-Za-z0-9]+$/.test(token));
  return path;
}

/** Find a likely file being edited by one of the shell patterns shown in activity. */
export function extractShellEditTarget(command: string): string | undefined {
  const path = redirectedTarget(command) ?? teeTarget(command) ?? inPlaceSedTarget(command);
  return basenameOfPath(path);
}
