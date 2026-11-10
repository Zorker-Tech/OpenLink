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
import { SANDBOX_WORKSPACE_WRITE_PROTECTION_PATTERNS } from "../../../adapters/interop/agent/sandbox-workspace-path-adapter.ts";

type ReadPathScope = "global" | "home" | "bundled";
type ReadPathGroup = { readonly scope: ReadPathScope; readonly paths: readonly string[] };
type HostPlatform = "linux" | "darwin";
type WriteProtectionScope = "workspace" | "git" | "worktree" | "absolute" | "home";

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
  const pathGroups = READ_PATH_GROUPS[platform as HostPlatform];
  if (pathGroups === undefined) return paths;

  for (const group of pathGroups) {
    if (group.scope === "global") {
      paths.push(...group.paths);
      continue;
    }
    for (const path of group.paths) {
      const candidate = group.scope === "home" ? join(homeDir, path) : bundledPaths[path];
      if (!candidate) continue;
      try {
        const isAllowedFile = group.scope === "home"
          ? lstatSync(candidate).isFile()
          : statSync(candidate).isFile();
        if (isAllowedFile) paths.push(candidate);
      } catch {
        // Unreadable optional paths do not enter the allowlist.
      }
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
  return { [workspaceDir]: [...WRITE_PROTECTION_PATHS.workspace] };
}

export function getGitWriteProtectionMapping(gitDirParent: string): IgnoreMapping {
  return { [gitDirParent]: [...WRITE_PROTECTION_PATHS.git] };
}

export function getWorktreeWriteProtectionMapping(workspaceDir: string): IgnoreMapping {
  return { [workspaceDir]: [...WRITE_PROTECTION_PATHS.worktree] };
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
  const additionalReadonlyPaths = [
    ...WRITE_PROTECTION_PATHS.absolute,
    ...(homeDir.length === 0 ? [] : WRITE_PROTECTION_PATHS.home.map((path) => join(homeDir, path))),
  ];
  return {
    type: "workspace_readwrite" as const,
    additionalReadonlyPaths,
    writeProtectionMapping: getWorkspaceWriteProtectionMapping(workspaceDir),
    ...(networkPolicy && { networkPolicy }),
    networkPolicyStrict: true as const,
  };
}

const READ_PATH_GROUPS = {
  linux: [
    { scope: "global", paths: [
      "/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local/bin", "/lib", "/lib64", "/usr/lib", "/usr/lib64", "/usr/local/lib", "/usr/libexec", "/usr/share",
      "/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld.so.conf.d", "/etc/ssl/certs", "/etc/ssl/openssl.cnf", "/etc/ssl/cert.pem", "/etc/ssl/ca-bundle.pem", "/etc/ssl/certs/ca-certificates.crt",
      "/etc/pki/tls/certs", "/etc/pki/tls/openssl.cnf", "/etc/pki/ca-trust/extracted", "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/gai.conf",
      "/etc/profile", "/etc/bash.bashrc", "/etc/zsh/zshenv", "/etc/zsh/zprofile", "/etc/zsh/zshrc", "/etc/zsh/zlogin", "/etc/gitconfig",
    ] },
    { scope: "home", paths: [".bashrc", ".bash_profile", ".profile", ".zshenv", ".zprofile", ".zshrc", ".zlogin", ".gitconfig"] },
    { scope: "bundled", paths: ["ripgrep"] },
  ],
  darwin: [
    { scope: "global", paths: [
      "/bin", "/usr/bin", "/usr/lib", "/usr/libexec", "/usr/share", "/System/Library", "/System/Cryptexes", "/Library/Apple",
      "/private/etc/ssl/cert.pem", "/private/etc/ssl/certs", "/private/etc/hosts", "/private/etc/resolv.conf",
      "/etc/profile", "/etc/bashrc", "/etc/zshenv", "/etc/zprofile", "/etc/zshrc", "/etc/zlogin", "/etc/gitconfig",
    ] },
    { scope: "home", paths: [".bashrc", ".bash_profile", ".profile", ".zshenv", ".zprofile", ".zshrc", ".zlogin", ".gitconfig"] },
    { scope: "bundled", paths: ["ripgrep"] },
    { scope: "global", paths: ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/tty"] },
  ],
} as const satisfies Record<HostPlatform, readonly ReadPathGroup[]>;

const WRITE_PROTECTION_PATHS = {
  workspace: [...SANDBOX_WORKSPACE_WRITE_PROTECTION_PATTERNS],
  git: [
    "**/.git/hooks/**",
    "**/.git/config",
    "**/.git/config.worktree",
    "**/.git/info/attributes",
    "**/.git/commondir",
    "**/.git/worktrees/*/commondir",
  ],
  worktree: [".git"],
  absolute: [
    "/etc/ssl/cert.pem",
    "/etc/ssl/ca-bundle.pem",
    "/private/etc/ssl/cert.pem",
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
  ],
  home: [".ssh", ".slate/sandbox-policies"],
} as const satisfies Record<WriteProtectionScope, readonly string[]>;

const HARDCODED_NETWORK_DENYLIST: string[] = [];
