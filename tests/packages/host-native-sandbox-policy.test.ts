/**
 * The policy a sandboxed command really runs under: the read boundary, additional read paths (globs, home, duplicates),
 * the canonicalized ignore mappings, read-only/write protections and the network decision.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildNativeSandboxPolicy, type NativeSandboxPolicyInput } from "../../source/packages/shell-exec/sandbox/native-policy.ts";

const input = (fields: Partial<NativeSandboxPolicyInput> = {}): NativeSandboxPolicyInput => ({
  type: "insecure_none",
  ...fields,
});

test("a trusted-read policy keeps the system read paths and defaults to the system boundary", () => {
  const policy = buildNativeSandboxPolicy(input(), "/work");
  assert.equal(policy.type, "insecure_none");
  assert.equal(policy.cwd, "/work");
  assert.equal(policy.readBoundary, "system");
  assert.equal(policy.networkAccess, false);
  assert.equal(policy.ignoreMapping, undefined);
  assert.equal(policy.additionalReadonlyPaths, undefined);
  assert.deepEqual(policy.additionalReadwritePaths, []);
  assert.equal(policy.disableTmpWrite, false);
  assert.equal(Array.isArray(policy.hardcodedReadPaths), true);
  assert.equal(new Set(policy.hardcodedReadPaths).size, policy.hardcodedReadPaths.length);
  for (const entry of policy.hardcodedReadPaths) assert.equal(path.isAbsolute(entry), true);
});

test("a workspace boundary trusts the caller's roots on top of the system paths", () => {
  const policy = buildNativeSandboxPolicy(input({ readBoundary: "workspace", additionalReadPaths: ["/work/one", "/work/two/**", "  /work/one/  ", ""] }), "/work");
  const system = buildNativeSandboxPolicy(input(), "/work").hardcodedReadPaths;
  for (const entry of system) assert.equal(policy.hardcodedReadPaths.includes(entry), true);
  assert.equal(policy.hardcodedReadPaths.includes("/work/one"), true);
  assert.equal(policy.hardcodedReadPaths.includes("/work/two"), true);
  const roots = policy.hardcodedReadPaths.filter((entry) => entry.startsWith("/work"));
  assert.deepEqual(roots, ["/work/one", "/work/two", "/work/one/"]);
});

test("home and glob read paths are reduced to roots", () => {
  const policy = buildNativeSandboxPolicy(input({ readBoundary: "workspace", additionalReadPaths: ["~", "~/projects/**", "/work/logs/*.txt", "/work/*.md", "/work/plain"] }), "/work");
  const roots = policy.hardcodedReadPaths.filter((entry) => entry !== os.homedir() && !entry.startsWith("/work"));
  assert.equal(roots.some((entry) => entry.includes("*")), false);
  assert.equal(policy.hardcodedReadPaths.includes(os.homedir()), true);
  assert.equal(policy.hardcodedReadPaths.includes(path.join(os.homedir(), "projects")), true);
  assert.equal(policy.hardcodedReadPaths.includes("/work/logs"), true);
  assert.equal(policy.hardcodedReadPaths.includes("/work"), true);
  assert.equal(policy.hardcodedReadPaths.includes("/work/plain"), true);
});

test("an ignore mapping is canonicalized, keeps file uris and lists symlink targets too", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "native-policy-"));
  const target = path.join(dir, "target");
  await mkdir(target);
  await writeFile(path.join(target, "kept.txt"), "x");
  const link = path.join(dir, "link");
  await symlink(target, link);
  const policy = buildNativeSandboxPolicy(input({
    ignoreMapping: {
      [target]: ["a"],
      ["file://" + target + "/"]: ["b"],
      [link]: ["c"],
    },
    type: "workspace_readwrite",
  }), dir);
  const mapping = policy.ignoreMapping ?? {};
  // The file-uri form names the same directory a second time, and the later entry is the one kept.
  assert.deepEqual(mapping[target], ["b"]);
  assert.deepEqual(mapping[link], ["c"]);
  assert.deepEqual(mapping[await (await import("node:fs/promises")).realpath(link)], ["c"]);
});

test("read-only paths and the workspace's own write protections merge under one mapping", () => {
  const policy = buildNativeSandboxPolicy(input({
    type: "workspace_readonly",
    additionalReadonlyPaths: ["/work/secret.txt"],
    writeProtectionMapping: { "/work/secret.txt": ["extra"] , "/work/protected": ["**"] },
  }), "/work");
  const mapping = policy.additionalReadonlyPaths ?? {};
  assert.deepEqual(mapping["/work"], ["secret.txt", "secret.txt/**"]);
  assert.deepEqual(mapping["/work/secret.txt"], ["extra"]);
  assert.deepEqual(mapping["/work/protected"], ["**"]);
  assert.equal(policy.additionalReadwritePaths, undefined);
  assert.equal(policy.disableTmpWrite, undefined);
});

test("read-write extras are passed through and readonly requests omit them", () => {
  const readwrite = buildNativeSandboxPolicy(input({ type: "workspace_readwrite", additionalReadwritePaths: ["/tmp/out"], disableTmpWrite: true }), "/work");
  assert.deepEqual(readwrite.additionalReadwritePaths, ["/tmp/out"]);
  assert.equal(readwrite.disableTmpWrite, true);
  const readonly = buildNativeSandboxPolicy(input({ type: "workspace_readonly", additionalReadwritePaths: ["/tmp/out"], disableTmpWrite: true }), "/work");
  assert.equal(readonly.additionalReadwritePaths, undefined);
  assert.equal(readonly.disableTmpWrite, undefined);
});

test("the network decision follows the declared policy", () => {
  const allow = buildNativeSandboxPolicy(input({ networkPolicy: { version: 1, default: "allow" } }), "/work");
  assert.equal(allow.networkAccess, true);
  const deny = buildNativeSandboxPolicy(input({ networkPolicy: { version: 1, default: "deny" } }), "/work");
  assert.equal(deny.networkAccess, false);
  const allowlisted = buildNativeSandboxPolicy(input({ networkPolicy: { version: 1, default: "deny", allow: ["example.com"] } }), "/work");
  assert.equal(typeof allowlisted.networkAccess, "boolean");
});

test("a read-only policy can be built without any protections", () => {
  const policy = buildNativeSandboxPolicy({ type: "workspace_readonly", additionalReadonlyPaths: [] }, "/work");
  assert.equal(policy.type, "workspace_readonly");
  assert.equal(policy.additionalReadonlyPaths, undefined);
});

test("a mapping path that cannot be resolved is kept as written, with no undefined key", () => {
  const policy = buildNativeSandboxPolicy(input({ type: "workspace_readwrite", ignoreMapping: { "file:///nonexistent/path/": ["z"] } }), "/work");
  const mapping = policy.ignoreMapping ?? {};
  assert.deepEqual(Object.keys(mapping), ["/nonexistent/path"]);
  assert.deepEqual(mapping["/nonexistent/path"], ["z"]);
  assert.equal(Object.keys(mapping).includes("undefined"), false);
});
