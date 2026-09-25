/**
 * The policy every sandbox starts from, before a user or a project adds anything to it.
 *
 * A sandbox is only worth having if it denies by default, and denying everything makes a command useless —
 * so this is the list of what a command is allowed to reach and what it must not be able to write, written
 * down once and applied to every command. Reads are allowed where a program needs them to start: the system
 * binaries and libraries, the certificate stores, the files that say how names resolve, and the shell's own
 * startup files, per platform. Writes are protected where they would outlive the command: the platform's own
 * configuration, another editor's, a virtual environment, and the parts of a repository that change what the
 * repository *is* — hooks, config, the worktree pointer — since a sandbox that let a command rewrite those
 * would not be containing it.
 *
 * The exceptions in the write list are directories the platform itself reads and writes; a pattern starting
 * with a negation is how a rule says "everything here except this".
 *
 * Reads of paths that are not there are skipped rather than assumed, and a bundled path is only allowed when
 * the installation actually has it, since a policy that names a missing file is a policy that fails to
 * apply.
 */

import { existsSync, lstatSync, statSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import ignore from "ignore";

type AllowedReadPath = {
  platform: "linux" | "darwin";
  scope: "global" | "home" | "bundled";
  path: string;
};

type WriteProtectionPattern = {
  type: "workspace" | "git" | "worktree" | "absolute" | "home";
  pattern: string;
};

type IgnoreMapping = Record<string, string[]>;

type HardcodedNetworkPolicy = {
  version: 1;
  deny: string[];
};

export function getHardcodedAllowedReadPaths(
  platform = process.platform,
  homeDir = os.homedir(),
  bundledPaths: Record<string, string | undefined> = {},
): string[] {
  const paths: string[] = [];
  for (const entry of HARDCODED_ALLOWED_READ_PATHS) {
    if (entry.platform !== platform) {
      continue;
    }
    if (entry.scope === "global") {
      paths.push(entry.path);
      continue;
    }
    const candidate = entry.scope === "home"
      ? join(homeDir, entry.path)
      : bundledPaths[entry.path];
    if (!candidate) {
      continue;
    }
    try {
      const isAllowedFile = entry.scope === "home"
        ? lstatSync(candidate).isFile()
        : statSync(candidate).isFile();
      if (isAllowedFile) {
        paths.push(candidate);
      }
    } catch {
      // Ignore individual inaccessible candidates.
    }
  }
  return paths;
}

export function convertPathsToIgnoreMapping(...paths: string[]): IgnoreMapping {
  const mapping: IgnoreMapping = {};
  for (const path of paths) {
    let isDir = false;
    try {
      isDir = existsSync(path) && statSync(path).isDirectory();
    } catch {
      // Treat probe failures as non-directories.
    }
    if (isDir) {
      if (!mapping[path]) {
        mapping[path] = [];
      }
      mapping[path]!.push("**");
    } else {
      const lastSlash = path.lastIndexOf("/");
      const dir = lastSlash > 0 ? path.slice(0, lastSlash) : "/";
      const file = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
      if (!mapping[dir]) {
        mapping[dir] = [];
      }
      if (file) {
        mapping[dir]!.push(file, `${file}/**`);
      } else {
        mapping[dir]!.push("**");
      }
    }
  }
  return mapping;
}

function getWorkspaceWriteProtectionMapping(workspaceDir: string): IgnoreMapping {
  const patterns = HARDCODED_WRITE_PROTECTION_PATTERNS
    .filter((entry) => entry.type === "workspace")
    .map((entry) => entry.pattern);
  return { [workspaceDir]: patterns };
}

export function getGitWriteProtectionMapping(gitDirParent: string): IgnoreMapping {
  const patterns = HARDCODED_WRITE_PROTECTION_PATTERNS
    .filter((entry) => entry.type === "git")
    .map((entry) => entry.pattern);
  return { [gitDirParent]: patterns };
}

export function getWorktreeWriteProtectionMapping(workspaceDir: string): IgnoreMapping {
  const patterns = HARDCODED_WRITE_PROTECTION_PATTERNS
    .filter((entry) => entry.type === "worktree")
    .map((entry) => entry.pattern);
  return { [workspaceDir]: patterns };
}

function getHardcodedNetworkPolicy(): HardcodedNetworkPolicy | undefined {
  if (HARDCODED_NETWORK_DENYLIST.length === 0) {
    return undefined;
  }
  return {
    version: 1,
    deny: [...HARDCODED_NETWORK_DENYLIST],
  };
}

export function getHardcodedSandboxPolicy(workspaceDir: string) {
  const networkPolicy = getHardcodedNetworkPolicy();
  const homeDir = os.homedir();
  const additionalReadonlyPaths: string[] = [];
  for (const entry of HARDCODED_WRITE_PROTECTION_PATTERNS) {
    switch (entry.type) {
      case "workspace":
        break;
      case "git":
        break;
      case "worktree":
        break;
      case "absolute": {
        additionalReadonlyPaths.push(entry.pattern);
        break;
      }
      case "home": {
        if (homeDir.length > 0) {
          additionalReadonlyPaths.push(join(homeDir, entry.pattern));
        }
        break;
      }
      default: {
        const _exhaustive: never = entry.type;
        throw new Error(`Unknown entry type: ${_exhaustive}`);
      }
    }
  }
  return {
    type: "workspace_readwrite" as const,
    additionalReadonlyPaths,
    writeProtectionMapping: getWorkspaceWriteProtectionMapping(workspaceDir),
    ...(networkPolicy && { networkPolicy }),
    networkPolicyStrict: true as const,
  };
}

const HARDCODED_ALLOWED_READ_PATHS: AllowedReadPath[] = [
  { platform: "linux", scope: "global", path: "/bin" },
  { platform: "linux", scope: "global", path: "/sbin" },
  { platform: "linux", scope: "global", path: "/usr/bin" },
  { platform: "linux", scope: "global", path: "/usr/sbin" },
  { platform: "linux", scope: "global", path: "/usr/local/bin" },
  { platform: "linux", scope: "global", path: "/lib" },
  { platform: "linux", scope: "global", path: "/lib64" },
  { platform: "linux", scope: "global", path: "/usr/lib" },
  { platform: "linux", scope: "global", path: "/usr/lib64" },
  { platform: "linux", scope: "global", path: "/usr/local/lib" },
  { platform: "linux", scope: "global", path: "/usr/libexec" },
  { platform: "linux", scope: "global", path: "/usr/share" },
  { platform: "linux", scope: "global", path: "/etc/ld.so.cache" },
  { platform: "linux", scope: "global", path: "/etc/ld.so.conf" },
  { platform: "linux", scope: "global", path: "/etc/ld.so.conf.d" },
  { platform: "linux", scope: "global", path: "/etc/ssl/certs" },
  { platform: "linux", scope: "global", path: "/etc/ssl/openssl.cnf" },
  { platform: "linux", scope: "global", path: "/etc/ssl/cert.pem" },
  { platform: "linux", scope: "global", path: "/etc/ssl/ca-bundle.pem" },
  { platform: "linux", scope: "global", path: "/etc/ssl/certs/ca-certificates.crt" },
  { platform: "linux", scope: "global", path: "/etc/pki/tls/certs" },
  { platform: "linux", scope: "global", path: "/etc/pki/tls/openssl.cnf" },
  { platform: "linux", scope: "global", path: "/etc/pki/ca-trust/extracted" },
  { platform: "linux", scope: "global", path: "/etc/resolv.conf" },
  { platform: "linux", scope: "global", path: "/etc/hosts" },
  { platform: "linux", scope: "global", path: "/etc/nsswitch.conf" },
  { platform: "linux", scope: "global", path: "/etc/gai.conf" },
  { platform: "linux", scope: "global", path: "/etc/profile" },
  { platform: "linux", scope: "global", path: "/etc/bash.bashrc" },
  { platform: "linux", scope: "global", path: "/etc/zsh/zshenv" },
  { platform: "linux", scope: "global", path: "/etc/zsh/zprofile" },
  { platform: "linux", scope: "global", path: "/etc/zsh/zshrc" },
  { platform: "linux", scope: "global", path: "/etc/zsh/zlogin" },
  { platform: "linux", scope: "global", path: "/etc/gitconfig" },
  { platform: "linux", scope: "home", path: ".bashrc" },
  { platform: "linux", scope: "home", path: ".bash_profile" },
  { platform: "linux", scope: "home", path: ".profile" },
  { platform: "linux", scope: "home", path: ".zshenv" },
  { platform: "linux", scope: "home", path: ".zprofile" },
  { platform: "linux", scope: "home", path: ".zshrc" },
  { platform: "linux", scope: "home", path: ".zlogin" },
  { platform: "linux", scope: "home", path: ".gitconfig" },
  { platform: "linux", scope: "bundled", path: "ripgrep" },
  { platform: "darwin", scope: "global", path: "/bin" },
  { platform: "darwin", scope: "global", path: "/usr/bin" },
  { platform: "darwin", scope: "global", path: "/usr/lib" },
  { platform: "darwin", scope: "global", path: "/usr/libexec" },
  { platform: "darwin", scope: "global", path: "/usr/share" },
  { platform: "darwin", scope: "global", path: "/System/Library" },
  { platform: "darwin", scope: "global", path: "/System/Cryptexes" },
  { platform: "darwin", scope: "global", path: "/Library/Apple" },
  { platform: "darwin", scope: "global", path: "/private/etc/ssl/cert.pem" },
  { platform: "darwin", scope: "global", path: "/private/etc/ssl/certs" },
  { platform: "darwin", scope: "global", path: "/private/etc/hosts" },
  { platform: "darwin", scope: "global", path: "/private/etc/resolv.conf" },
  { platform: "darwin", scope: "global", path: "/etc/profile" },
  { platform: "darwin", scope: "global", path: "/etc/bashrc" },
  { platform: "darwin", scope: "global", path: "/etc/zshenv" },
  { platform: "darwin", scope: "global", path: "/etc/zprofile" },
  { platform: "darwin", scope: "global", path: "/etc/zshrc" },
  { platform: "darwin", scope: "global", path: "/etc/zlogin" },
  { platform: "darwin", scope: "global", path: "/etc/gitconfig" },
  { platform: "darwin", scope: "home", path: ".bashrc" },
  { platform: "darwin", scope: "home", path: ".bash_profile" },
  { platform: "darwin", scope: "home", path: ".profile" },
  { platform: "darwin", scope: "home", path: ".zshenv" },
  { platform: "darwin", scope: "home", path: ".zprofile" },
  { platform: "darwin", scope: "home", path: ".zshrc" },
  { platform: "darwin", scope: "home", path: ".zlogin" },
  { platform: "darwin", scope: "home", path: ".gitconfig" },
  { platform: "darwin", scope: "bundled", path: "ripgrep" },
  { platform: "darwin", scope: "global", path: "/dev/null" },
  { platform: "darwin", scope: "global", path: "/dev/zero" },
  { platform: "darwin", scope: "global", path: "/dev/random" },
  { platform: "darwin", scope: "global", path: "/dev/urandom" },
  { platform: "darwin", scope: "global", path: "/dev/tty" },
];

const HARDCODED_WRITE_PROTECTION_PATTERNS: WriteProtectionPattern[] = [
  { type: "workspace", pattern: "**/.cursor/*.json" },
  { type: "workspace", pattern: "**/.cursor/**/*.json" },
  { type: "workspace", pattern: "**/.cursor/.workspace-trusted" },
  { type: "workspace", pattern: "!**/.cursor/rules" },
  { type: "workspace", pattern: "!**/.cursor/rules/**" },
  { type: "workspace", pattern: "!**/.cursor/commands" },
  { type: "workspace", pattern: "!**/.cursor/commands/**" },
  { type: "workspace", pattern: "!**/.cursor/worktrees" },
  { type: "workspace", pattern: "!**/.cursor/worktrees/**" },
  { type: "workspace", pattern: "!**/.cursor/skills" },
  { type: "workspace", pattern: "!**/.cursor/skills/**" },
  { type: "workspace", pattern: "!**/.cursor/agents" },
  { type: "workspace", pattern: "!**/.cursor/agents/**" },
  { type: "workspace", pattern: "**/.claude/*.json" },
  { type: "workspace", pattern: "**/.claude/**/*.json" },
  { type: "workspace", pattern: "**/.vscode/**" },
  { type: "workspace", pattern: "**/.idea/**" },
  { type: "workspace", pattern: "**/.venv/" },
  { type: "workspace", pattern: "**/venv/" },
  { type: "workspace", pattern: "**/*.code-workspace" },
  { type: "workspace", pattern: "**/.cursorignore" },
  { type: "workspace", pattern: "**/.workspace-trusted" },
  { type: "workspace", pattern: "**/.cursor/**/cli.json" },
  { type: "workspace", pattern: "**/.cursor/**/cli-config.json" },
  { type: "workspace", pattern: "**/.cursor/**/mcp.json" },
  { type: "workspace", pattern: "**/.cursor/**/mcp-approvals.json" },
  { type: "workspace", pattern: "**/.cursor/**/permissions.json" },
  { type: "git", pattern: "**/.git/hooks/**" },
  { type: "git", pattern: "**/.git/config" },
  { type: "git", pattern: "**/.git/config.worktree" },
  { type: "git", pattern: "**/.git/info/attributes" },
  { type: "git", pattern: "**/.git/commondir" },
  { type: "git", pattern: "**/.git/worktrees/*/commondir" },
  { type: "worktree", pattern: ".git" },
  { type: "absolute", pattern: "/etc/ssl/cert.pem" },
  { type: "absolute", pattern: "/etc/ssl/ca-bundle.pem" },
  { type: "absolute", pattern: "/private/etc/ssl/cert.pem" },
  { type: "absolute", pattern: "/etc/ssl/certs/ca-certificates.crt" },
  { type: "absolute", pattern: "/etc/pki/tls/certs/ca-bundle.crt" },
  { type: "absolute", pattern: "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem" },
  { type: "home", pattern: ".ssh" },
  { type: "home", pattern: ".slate/sandbox-policies" },
];

const HARDCODED_PROTECTED_GIT_PATTERNS = HARDCODED_WRITE_PROTECTION_PATTERNS
  .filter((entry) => entry.type === "git")
  .map((entry) => entry.pattern);

const SLATE_ALLOWED_WRITE_SUBDIRS = HARDCODED_WRITE_PROTECTION_PATTERNS
  .filter((entry) => entry.type === "workspace" && entry.pattern.startsWith("!") && !entry.pattern.endsWith("/**"))
  .map((entry) => entry.pattern.replace(/^!(\*\*\/)?/, ""));

const HARDCODED_NETWORK_DENYLIST: string[] = [];
const _caseInsensitiveFs = process.platform === "win32" || process.platform === "darwin";

void ignore;
void HARDCODED_PROTECTED_GIT_PATTERNS;
void SLATE_ALLOWED_WRITE_SUBDIRS;
void _caseInsensitiveFs;
