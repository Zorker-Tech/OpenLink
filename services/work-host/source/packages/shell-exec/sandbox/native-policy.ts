/**
 * The policy a sandboxed command is actually run under, once the platform has resolved it.
 *
 * What a caller asks for and what the sandbox is given are not the same document. A caller says "this
 * workspace may be written, read the system's entries, allow this network"; the sandbox is given a working
 * directory, the list of entries it may read, and a mapping of directories to the rules it must not write.
 * This is that translation, and most of it is about making the two agree on what a path is.
 *
 * Paths are canonicalized, because the same directory reached by two names is two directories to a sandbox
 * that was handed two strings: a path that is a symlink is resolved to what it points at, and a mapping is
 * written under both names so that whichever one the command uses is covered. A read path that names a glob
 * is reduced to the directory the glob was anchored at, since a sandbox is given directories rather than
 * rules. Home-relative entries are expanded, and a path that was already listed is not listed twice.
 *
 * What is protected from writing depends on where the command runs. The workspace's own protections apply
 * everywhere except Linux, where they apply only when the workspace is inside a git repository — because on
 * Linux the sandbox's own filesystem rules already cover what a repository protects, and applying them twice
 * would only make the policy harder to read.
 *
 * The read boundary decides how much is trusted: a command that may read anywhere is given the system's
 * entries, and one confined to its workspace is given only the rootList the caller named.
 */

import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getRipgrepBinaryPath } from "../ripgrep.ts";
import { isNetworkEnabledByPolicy, type NetworkPolicy } from "./network-policy-utils.ts";
import { convertPathsToIgnoreMapping, getHardcodedAllowedReadPaths } from "./hardcoded-policy.ts";

export type NativeSandboxPolicyType = "workspace_readwrite" | "workspace_readonly" | "insecure_none";
export type NativeReadBoundary = "system" | "workspace";
export type NativeIgnoreMapping = Record<string, readonly string[]>;

export interface NativeSandboxPolicyInput {
  readonly type: NativeSandboxPolicyType;
  readonly readBoundary?: NativeReadBoundary;
  readonly additionalReadPaths?: readonly string[];
  readonly additionalReadwritePaths?: readonly string[];
  readonly additionalReadonlyPaths?: readonly string[];
  readonly writeProtectionMapping?: NativeIgnoreMapping;
  readonly ignoreMapping?: NativeIgnoreMapping;
  readonly networkPolicy?: NetworkPolicy;
  readonly disableTmpWrite?: boolean;
}

export interface NativeSandboxPolicy {
  readonly type: NativeSandboxPolicyType;
  readonly cwd: string;
  readonly readBoundary: NativeReadBoundary;
  readonly hardcodedReadPaths: readonly string[];
  readonly additionalReadonlyPaths: NativeIgnoreMapping | undefined;
  readonly networkAccess: boolean;
  readonly ignoreMapping: NativeIgnoreMapping | undefined;
  readonly additionalReadwritePaths?: readonly string[];
  readonly disableTmpWrite?: boolean;
}

function looksGitBackedSync(startDirectory: string): boolean {
  let visitedDirectory = path.resolve(startDirectory);
  for (;;) {
    try {
      const gitMarker = path.join(visitedDirectory, ".git");
      if (existsSync(gitMarker)) {
        return true;
      }
    } catch {
      // Probe failures are treated as not git-backed.
    }
    const parent = path.dirname(visitedDirectory);
    if (parent === visitedDirectory) {
      return false;
    }
    visitedDirectory = parent;
  }
}

function fileUriPathOf(uri: string): string {
  let product = uri.replace(/^file:\/\//, "");
  product = decodeURIComponent(product);
  if (product.length > 1 && product.endsWith("/")) {
    product = product.slice(0, -1);
  }
  return product;
}

function realPathOrSelf(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

function canonicalIgnoreMapping(ignoreMapping: NativeIgnoreMapping): NativeIgnoreMapping {
  const product: Record<string, readonly string[]> = {};
  for (const [rawKey, rules] of Object.entries(ignoreMapping)) {
    const filesystemPath = rawKey.startsWith("file://") ? fileUriPathOf(rawKey) : rawKey;
    product[filesystemPath] = rules;
    const resolvedPath = realPathOrSelf(filesystemPath);
    if (resolvedPath !== filesystemPath) {
      product[resolvedPath] = rules;
    }
  }
  return product;
}

function ignoreMappingFor(ignoreMapping: NativeIgnoreMapping): NativeIgnoreMapping {
  return canonicalIgnoreMapping(ignoreMapping);
}

function readRootsOf(entries: readonly string[]): string[] {
  const rootList: string[] = [];
  const visited = new Set<string>();
  for (const candidateEntry of entries) {
    let candidate = candidateEntry.trim();
    if (!candidate) {
      continue;
    }
    if (candidate === "~") {
      candidate = os.homedir();
    } else if (candidate.startsWith("~/") || candidate.startsWith("~\\")) {
      candidate = path.join(os.homedir(), candidate.slice(2));
    }
    candidate = candidate.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
    candidate = candidate.replace(/\\\*\*$/, "").replace(/\\\*$/, "");
    const leaf = path.basename(candidate);
    if (leaf.includes("*") || leaf.includes("?")) {
      candidate = path.dirname(candidate);
    }
    if (!candidate || candidate === ".") {
      continue;
    }
    const canonical = path.normalize(candidate);
    if (visited.has(canonical)) {
      continue;
    }
    visited.add(canonical);
    rootList.push(canonical);
  }
  return rootList;
}

function readonlyMappingOf(
  additionalReadonlyPaths: readonly string[] | undefined,
  writeProtectionMapping: NativeIgnoreMapping | undefined,
  cwd: string,
): NativeIgnoreMapping | undefined {
  const fromReadonlyPaths = additionalReadonlyPaths !== undefined && additionalReadonlyPaths.length > 0
    ? convertPathsToIgnoreMapping(...additionalReadonlyPaths)
    : {};
  const workspaceInRepository = looksGitBackedSync(cwd);
  const fromWorkspaceProtections = process.platform !== "linux" || workspaceInRepository
    ? writeProtectionMapping ?? {}
    : {};
  const combined: Record<string, readonly string[]> = { ...fromReadonlyPaths };
  for (const [startDirectory, rules] of Object.entries(fromWorkspaceProtections)) {
    if (combined[startDirectory] !== undefined) {
      combined[startDirectory] = [...combined[startDirectory], ...rules];
    } else {
      combined[startDirectory] = rules;
    }
  }
  if (Object.keys(combined).length === 0) {
    return undefined;
  }
  return canonicalIgnoreMapping(combined);
}

function trustedReadPathsOf(hostPlatform = process.platform): string[] {
  const resolved: string[] = [];
  const visited = new Set<string>();
  const bundledBinaries: Record<string, string> = {};
  try {
    bundledBinaries.ripgrep = getRipgrepBinaryPath();
  } catch {
    // Ripgrep is optional for the trusted-read allowlist.
  }
  const trustedPaths = hostPlatform === "linux" || hostPlatform === "darwin"
    ? getHardcodedAllowedReadPaths(hostPlatform, os.homedir(), bundledBinaries)
    : [];
  for (const candidate of trustedPaths) {
    let usablePath = candidate;
    try {
      if (existsSync(candidate)) {
        usablePath = realpathSync(candidate);
      }
    } catch {
      // Individual trusted entries are best-effort.
    }
    if (visited.has(usablePath)) {
      continue;
    }
    visited.add(usablePath);
    resolved.push(usablePath);
  }
  return resolved;
}

export function buildNativeSandboxPolicy(
  sandboxPolicy: NativeSandboxPolicyInput,
  cwd: string,
): NativeSandboxPolicy {
  let ignoreMapping: NativeIgnoreMapping | undefined;
  if (sandboxPolicy.ignoreMapping) {
    ignoreMapping = ignoreMappingFor(sandboxPolicy.ignoreMapping);
  }
  const additionalReadonlyPaths = readonlyMappingOf(
    sandboxPolicy.additionalReadonlyPaths,
    sandboxPolicy.writeProtectionMapping,
    cwd,
  );
  const readBoundary = sandboxPolicy.readBoundary ?? "system";
  const trustedSystemPaths = trustedReadPathsOf();
  const workspaceRoots = readBoundary === "workspace"
    ? readRootsOf(sandboxPolicy.additionalReadPaths ?? [])
    : [];
  const systemReadPaths = [...trustedSystemPaths];
  const visited = new Set(trustedSystemPaths);
  for (const root of workspaceRoots) {
    if (visited.has(root)) {
      continue;
    }
    visited.add(root);
    systemReadPaths.push(root);
  }
  const common = {
    cwd,
    readBoundary,
    hardcodedReadPaths: systemReadPaths,
    additionalReadonlyPaths,
    networkAccess: isNetworkEnabledByPolicy(sandboxPolicy.networkPolicy),
    ignoreMapping,
  };
  if (sandboxPolicy.type === "workspace_readonly") {
    return {
      type: sandboxPolicy.type,
      ...common,
    };
  }
  return {
    type: sandboxPolicy.type,
    ...common,
    additionalReadwritePaths: sandboxPolicy.additionalReadwritePaths || [],
    disableTmpWrite: sandboxPolicy.disableTmpWrite || false,
  };
}
