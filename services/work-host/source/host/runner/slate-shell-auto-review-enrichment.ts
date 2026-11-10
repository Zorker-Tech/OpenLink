/**
 * Adding what a shell review needs to decide.
 *
 * The commands a turn ran and the files it touched are gathered into the review's turnContext, readText in how much is
 * included, so a review can judge a command by what it was actually asked to do.
 */
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";


export const SLATE_SHELL_ENRICHMENT_MAX_CHARS = 8_000;
export const SLATE_SHELL_ENRICHMENT_MAX_LINES = 200;
export const SLATE_SHELL_APPROVAL_HASH_CHUNK_LINES = 50;
export const SLATE_SHELL_APPROVAL_HASH_MAX_LINES = 20_000;
export const SLATE_SHELL_APPROVAL_PARSE_MAX_CHARS = 1_000_000;

export type SlateShellEnrichmentCandidate =
  | { readonly kind: "executable"; readonly path: string }
  | {
    readonly kind: "package_script";
    readonly packageJsonPath: string;
    readonly scriptName: string;
  }
  | {
    readonly kind: "package_script_unresolved";
    readonly packageJsonPath?: string;
    readonly invocation: string;
  };

export interface SlateShellReadAccessor<Context> {
  read(
    turnContext: Context,
    request: { readonly path: string; readonly toolCallId: string; readonly offset: number; readonly limit: number },
  ): Promise<BoundedText | undefined>;
}

export interface BoundedText {
  readonly content: string;
  readonly totalLines: number;
  readonly truncated: boolean;
}

export interface FullTextHash {
  readonly definitionHash: string;
  readonly fullContent?: string;
}

export type SlateShellTargetEnrichment =
  | {
    readonly kind: "executable" | "package_script" | "package_script_unresolved";
    readonly path: string;
    readonly approval_binding_unavailable: true;
    readonly approval_binding_nonce: string;
  }
  | {
    readonly kind: "executable";
    readonly path: string;
    readonly definition: string;
    readonly definition_hash: string;
    readonly truncated: boolean;
  }
  | {
    readonly kind: "package_script";
    readonly path: string;
    readonly name: string;
    readonly definition: string;
    readonly definition_hash: string;
    readonly truncated: false;
  };

export function unquote(rawToken: string): string {
  if (
    (rawToken.startsWith('"') && rawToken.endsWith('"'))
    || (rawToken.startsWith("'") && rawToken.endsWith("'"))
  ) {
    return rawToken.slice(1, -1);
  }
  return rawToken;
}

/** The command after the environment assignments it starts with. */
function withoutEnvironmentPrefix(commandText: string): string {
  const envPrefix = commandText.match(
    /^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+)+/,
  );
  return envPrefix == null ? commandText : commandText.slice(envPrefix[0].length);
}

/** The directory a `cd … &&` prefix names, or nothing when the command does not start with one. */
function directoryFromChangePrefix(commandText: string, currentDirectory: string | undefined): { readonly directory: string | undefined; readonly rest: string } | undefined {
  const cdPrefix = commandText.match(
    /^cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*&&\s*(.+)$/,
  );
  if (cdPrefix == null) return undefined;
  const directoryText = cdPrefix[1];
  const rest = cdPrefix[2];
  if (directoryText == null || rest == null) return undefined;
  return {
    directory: currentDirectory == null ? undefined : resolve(currentDirectory, unquote(directoryText)),
    rest,
  };
}

/** The package.json a directory would hold. */
function packageJsonIn(directory: string): string {
  return resolve(directory, "package.json");
}

/** The package manager's script invocation a command names, or nothing when it names none. */
function packageScriptOf(commandText: string, currentDirectory: string | undefined): SlateShellEnrichmentCandidate | undefined {
  const packageMatch = commandText.match(
    /^(?:npm(?:\s+run)?|pnpm(?:\s+run)?|yarn(?:\s+run)?)\s+([A-Za-z0-9_:][A-Za-z0-9:_-]*)(?:\s|$)/,
  );
  if (packageMatch == null) return undefined;
  const scriptName = packageMatch[1];
  if (scriptName == null) return undefined;
  if (currentDirectory == null) {
    return { kind: "package_script_unresolved", invocation: packageMatch[0].trim() };
  }
  return {
    kind: "package_script",
    packageJsonPath: packageJsonIn(currentDirectory),
    scriptName,
  };
}

/** A package-manager invocation whose script cannot be resolved. */
function unresolvedPackageOf(commandText: string, currentDirectory: string | undefined): SlateShellEnrichmentCandidate | undefined {
  const unresolvedPackageMatch = commandText.match(/^(?:npm|pnpm|yarn)\s+[^;&|]+/);
  if (unresolvedPackageMatch != null) {
    return {
      kind: "package_script_unresolved",
      ...(currentDirectory == null ? {} : { packageJsonPath: packageJsonIn(currentDirectory) }),
      invocation: unresolvedPackageMatch[0],
    };
  }
  if (/\b(?:npm|pnpm|yarn)\b/.test(commandText)) {
    return {
      kind: "package_script_unresolved",
      ...(currentDirectory == null ? {} : { packageJsonPath: packageJsonIn(currentDirectory) }),
      invocation: commandText,
    };
  }
  return undefined;
}

/** The executable path a command names, as written. */
function executableTokenOf(commandText: string): string | undefined {
  const interpreterMatch = commandText.match(
    /^(?:python(?:3(?:\.\d+)?)?|node|bash|sh|zsh)\s+("[^"]+"|'[^']+'|[^\s;&|]+)(?:\s|$)/,
  );
  const directMatch = commandText.match(
    /^((?:\/|\.{1,2}\/)("[^"]+"|'[^']+'|[^\s;&|]+)|(?:\/|\.{1,2}\/)[^\s;&|]+)(?:\s|$)/,
  );
  return interpreterMatch?.[1] ?? directMatch?.[1];
}

export function parseSlateShellEnrichmentCandidate(
  command: string,
  workingDirectory?: string,
): SlateShellEnrichmentCandidate | undefined {
  let remainingCommand = command.trim();
  let currentDirectory = workingDirectory;
  for (let pass = 0; pass < 4; pass += 1) {
    const withoutEnvironment = withoutEnvironmentPrefix(remainingCommand);
    if (withoutEnvironment !== remainingCommand) {
      remainingCommand = withoutEnvironment;
      continue;
    }
    const change = directoryFromChangePrefix(remainingCommand, currentDirectory);
    if (change === undefined) break;
    currentDirectory = change.directory;
    remainingCommand = change.rest;
  }

  const segments = remainingCommand
    .split(/[;&|\n]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length > 1) {
    const containsScript = segments.some((segment) => {
      const nested = parseSlateShellEnrichmentCandidate(segment, currentDirectory);
      return nested?.kind === "package_script" || nested?.kind === "package_script_unresolved";
    });
    if (containsScript) {
      return {
        kind: "package_script_unresolved",
        ...(currentDirectory == null ? {} : { packageJsonPath: packageJsonIn(currentDirectory) }),
        invocation: remainingCommand,
      };
    }
  }

  const packageCandidate = packageScriptOf(remainingCommand, currentDirectory);
  if (packageCandidate !== undefined) return packageCandidate;
  const unresolvedCandidate = unresolvedPackageOf(remainingCommand, currentDirectory);
  if (unresolvedCandidate !== undefined) return unresolvedCandidate;

  const rawToken = executableTokenOf(remainingCommand);
  if (rawToken == null) return undefined;
  const targetPath = unquote(rawToken);
  if (isAbsolute(targetPath)) return { kind: "executable", path: targetPath };
  return currentDirectory == null
    ? undefined
    : { kind: "executable", path: resolve(currentDirectory, targetPath) };
}

export async function readBoundedText<Context>(
  turnContext: Context,
  reads: SlateShellReadAccessor<Context>,
  path: string,
  callId: string,
): Promise<BoundedText | undefined> {
  const readText = await reads.read(
    turnContext,
    {
      path,
      toolCallId: callId,
      offset: 1,
      limit: SLATE_SHELL_ENRICHMENT_MAX_LINES,
    },
  );
  if (readText == null) return undefined;
  return {
    content: readText.content.slice(0, SLATE_SHELL_ENRICHMENT_MAX_CHARS),
    totalLines: readText.totalLines,
    truncated: readText.truncated
      || readText.content.length > SLATE_SHELL_ENRICHMENT_MAX_CHARS
      || readText.totalLines > SLATE_SHELL_ENRICHMENT_MAX_LINES,
  };
}

export async function hashFullText<Context>(
  turnContext: Context,
  reads: SlateShellReadAccessor<Context>,
  path: string,
  callId: string,
  totalLines: number,
): Promise<FullTextHash | undefined> {
  if (totalLines > SLATE_SHELL_APPROVAL_HASH_MAX_LINES) return undefined;
  const hash = createHash("sha256");
  let keptContent = "";
  let keepsContent = true;
  for (
    let offsetLine = 1;
    offsetLine <= Math.max(1, totalLines);
    offsetLine += SLATE_SHELL_APPROVAL_HASH_CHUNK_LINES
  ) {
    const readChunk = await reads.read(
      turnContext,
      {
        path,
        toolCallId: callId,
        offset: offsetLine,
        limit: SLATE_SHELL_APPROVAL_HASH_CHUNK_LINES,
      },
    );
    if (readChunk == null || readChunk.truncated) return undefined;
    hash.update(String(offsetLine)).update("\0").update(readChunk.content).update("\0");
    if (keepsContent && keptContent.length + readChunk.content.length <= SLATE_SHELL_APPROVAL_PARSE_MAX_CHARS) {
      keptContent += readChunk.content;
    } else {
      keepsContent = false;
      keptContent = "";
    }
  }
  return {
    definitionHash: hash.digest("hex"),
    ...(keepsContent ? { fullContent: keptContent } : {}),
  };
}

/** The path an enrichment candidateItem is reported under. */
function candidatePath(candidateItem: SlateShellEnrichmentCandidate): string {
  return candidateItem.kind === "executable"
    ? candidateItem.path
    : candidateItem.kind === "package_script"
      ? candidateItem.packageJsonPath
      : candidateItem.packageJsonPath ?? candidateItem.invocation;
}

export function unavailableBinding(
  candidateItem: SlateShellEnrichmentCandidate,
): SlateShellTargetEnrichment {
  return {
    kind: candidateItem.kind,
    path: candidatePath(candidateItem),
    approval_binding_unavailable: true,
    approval_binding_nonce: randomUUID(),
  };
}

export async function buildSlateShellAutoReviewTargetEnrichment<Context>(
  turnContext: Context,
  input: {
    readonly command: string;
    readonly workingDirectory?: string;
    readonly resourceAccessor: SlateShellReadAccessor<Context>;
    readonly toolCallId: string;
  },
): Promise<SlateShellTargetEnrichment | undefined> {
  const candidateItem = parseSlateShellEnrichmentCandidate(input.command, input.workingDirectory);
  if (candidateItem == null) return undefined;
  if (candidateItem.kind === "package_script_unresolved") return unavailableBinding(candidateItem);
  try {
    const path = candidateItem.kind === "executable" ? candidateItem.path : candidateItem.packageJsonPath;
    const readText = await readBoundedText(turnContext, input.resourceAccessor, path, input.toolCallId);
    if (readText == null) return unavailableBinding(candidateItem);
    const hashResult = await hashFullText(turnContext, input.resourceAccessor, path, input.toolCallId, readText.totalLines);
    if (hashResult == null) return unavailableBinding(candidateItem);
    if (candidateItem.kind === "executable") {
      if (readText.truncated) return unavailableBinding(candidateItem);
      return {
        kind: "executable",
        path: candidateItem.path,
        definition: readText.content,
        definition_hash: hashResult.definitionHash,
        truncated: readText.truncated,
      };
    }
    const manifestJson = JSON.parse(hashResult.fullContent ?? readText.content) as {
      readonly scripts?: Readonly<Record<string, unknown>>;
    };
    const scriptText = manifestJson.scripts?.[candidateItem.scriptName];
    if (typeof scriptText !== "string" || scriptText.length > SLATE_SHELL_ENRICHMENT_MAX_CHARS) {
      return unavailableBinding(candidateItem);
    }
    return {
      kind: "package_script",
      path: candidateItem.packageJsonPath,
      name: candidateItem.scriptName,
      definition: scriptText.slice(0, SLATE_SHELL_ENRICHMENT_MAX_CHARS),
      definition_hash: hashResult.definitionHash,
      truncated: false,
    };
  } catch {
    return unavailableBinding(candidateItem);
  }
}
