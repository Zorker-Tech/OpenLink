/**
 * Whether a local inference client is installed and signed in.
 *
 * The platform can route inference to a client that lives on the user's machine, and whether that is possible is read
 * from the machine: the executable is looked for where such clients install themselves, and a sign-in is looked for
 * where one would be kept.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface LocalInferenceCliStatus {
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly executablePath: string | null;
}

/** The directories a shell would look in, so a client installed by a package manager is found too. */
function directoriesOnPath(): string[] {
  return (process.env.PATH ?? "").split(delimiter).filter((directory) => directory.length > 0);
}

/** Every place a client of this name could be: the ones its installer uses, then the PATH, then the usual prefixes. */
function candidatesFor(name: string, ...installedAt: readonly string[]): string[] {
  return [...installedAt, ...directoriesOnPath().map((directory) => join(directory, name)), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`];
}

/** The first of these that is on the machine, and nothing when none is. */
function firstInstalled(candidates: readonly (string | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (candidate != null && candidate.length > 0 && existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveCodexCliPath(): string | null {
  const home = homedir();
  return firstInstalled([process.env.CODEX_PATH, ...candidatesFor("codex", join(home, ".local", "bin", "codex"), join(home, ".codex", "bin", "codex"))]);
}

export function resolveClaudeCodeCliPath(): string | null {
  const home = homedir();
  return firstInstalled([process.env.CLAUDE_CODE_PATH, ...candidatesFor("claude", join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude"))]);
}

/** A login file belongs to the user alone: not a link, and not readable by anybody else. */
function isPrivateFile(path: string): boolean {
  const stat = lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0;
}

/** The four tokens a chatgpt-login file must carry, each a non-empty string. */
const REQUIRED_TOKENS = ["access_token", "refresh_token", "id_token", "account_id"] as const;

/** Whether the login at this path is one this build can use, read without ever throwing for a file it cannot use. */
function hasUsableCodexLogin(path: string): boolean {
  try {
    if (!isPrivateFile(path)) return false;
    const stored = JSON.parse(readFileSync(path, "utf8")) as { auth_mode?: unknown; tokens?: Record<string, unknown> };
    if (stored.auth_mode !== "chatgpt") return false;
    const tokens = stored.tokens ?? {};
    return REQUIRED_TOKENS.every((name) => typeof tokens[name] === "string" && (tokens[name] as string).length > 0);
  } catch {
    return false;
  }
}

/** A signed-in claude-code, by its credentials file or by the key in the environment. */
function isClaudeCodeSignedIn(home: string): boolean {
  return existsSync(join(home, ".claude", ".credentials.json")) || (process.env.ANTHROPIC_API_KEY?.length ?? 0) > 0;
}

export function getLocalInferenceCliStatus(): { readonly codex: LocalInferenceCliStatus; readonly "claude-code": LocalInferenceCliStatus } {
  const home = homedir();
  const codexAuthPath = join(process.env.CODEX_HOME?.trim() || join(home, ".codex"), "auth.json");
  const claudePath = resolveClaudeCodeCliPath();
  return {
    // Codex inference is a Slate-owned HTTP transport authenticated by the existing Codex login. The CLI binary is not
    // in the request path, so what makes it "installed" is the login file, not the executable.
    codex: { installed: existsSync(codexAuthPath), authenticated: hasUsableCodexLogin(codexAuthPath), executablePath: resolveCodexCliPath() },
    "claude-code": { installed: claudePath != null, authenticated: isClaudeCodeSignedIn(home), executablePath: claudePath },
  };
}
