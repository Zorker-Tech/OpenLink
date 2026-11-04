import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MACOS_POLICY_DOMAINS,
  MDM_SIGN_IN_POLICY_HEADER_NAME,
  POLICY_CACHE_TTL_MS,
  SIGN_IN_POLICY_VIOLATION_ERROR,
  SIGN_IN_POLICY_VIOLATION_MESSAGE,
  SignInPolicyViolationError,
  SLATE_MDM_SIGN_IN_POLICY_ENV,
  WINDOWS_POLICY_REGISTRY_KEYS,
  buildMdmSignInPolicyHeaderValue,
} from "../../source/packages/config/auth/mdm-sign-in-policy.ts";
import { createMdmSignInPolicyReader } from "../../source/packages/config/auth/mdm-sign-in-policy-cache.ts";
import type { MdmPolicySourceContext } from "../../source/packages/config/auth/mdm-sign-in-policy-contracts.ts";
import { readMdmPolicyValues } from "../../source/packages/config/auth/mdm-sign-in-policy-sources.ts";

function payloadOf(header: string | undefined): Record<string, unknown> {
  if (header === undefined || !header.startsWith("v1.")) throw new Error("sign-in policy header is missing its version prefix");
  return JSON.parse(Buffer.from(header.slice(3), "base64url").toString("utf8")) as Record<string, unknown>;
}

function sourceContext(overrides: Partial<MdmPolicySourceContext> = {}): MdmPolicySourceContext {
  return {
    platform: "linux",
    environment: {},
    homeDirectory: "/home/slate-user",
    username: "slate-user",
    io: {
      fileExists: async () => false,
      readFile: async () => { throw new Error("no policy file"); },
      run: async () => { throw new Error("no platform command"); },
    },
    ...overrides,
  };
}

test("Slate sign-in policy constants name only Slate-owned configuration", () => {
  assert.deepEqual([
    MDM_SIGN_IN_POLICY_HEADER_NAME,
    POLICY_CACHE_TTL_MS,
    SLATE_MDM_SIGN_IN_POLICY_ENV,
  ], ["x-slate-mdm-signin-policy", 30_000, "SLATE_MDM_SIGN_IN_POLICY_JSON"]);
  assert.deepEqual(MACOS_POLICY_DOMAINS, ["co.slate.dev", "co.slate.desktop"]);
  assert.deepEqual(WINDOWS_POLICY_REGISTRY_KEYS, [
    "HKLM\\SOFTWARE\\Policies\\Slate\\Slate",
    "HKLM\\SOFTWARE\\Policies\\Slate\\Desktop",
    "HKLM\\SOFTWARE\\Policies\\Slate\\Slate Dev",
  ]);
  assert.equal(JSON.stringify([SLATE_MDM_SIGN_IN_POLICY_ENV, MACOS_POLICY_DOMAINS, WINDOWS_POLICY_REGISTRY_KEYS]).toLowerCase().includes("cursor"), false);
});

test("no enforcement or restrictions produces no policy header", () => {
  assert.equal(buildMdmSignInPolicyHeaderValue({}), undefined);
  assert.equal(buildMdmSignInPolicyHeaderValue({ SignInEnforcement: false, AllowedOrganizationIds: "0", AllowedTeamIds: "x" }), undefined);
});

test("sign-in enforcement accepts booleans, one and the documented text switches", () => {
  for (const value of [true, 1, "1", " true ", "YES", "On"]) {
    assert.equal(payloadOf(buildMdmSignInPolicyHeaderValue({ SignInEnforcement: value })).enforced, true, String(value));
  }
  for (const value of [false, 0, 2, "2", "no", "off", null]) {
    assert.equal(payloadOf(buildMdmSignInPolicyHeaderValue({ SignInEnforcement: value, AllowedTeamIds: "7" })).enforced, false, String(value));
  }
});

test("organization ids are decimal, canonicalized, positive and unique", () => {
  assert.deepEqual(payloadOf(buildMdmSignInPolicyHeaderValue({
    AllowedOrganizationIds: "00042,42,0,-7,not-an-id,18446744073709551615",
  })).allowedOrganizationIds, ["42", "18446744073709551615"]);
});

test("team ids merge singular and plural settings, discard invalid values and stay within safe integers", () => {
  assert.deepEqual(payloadOf(buildMdmSignInPolicyHeaderValue({
    AllowedTeamIds: "007,7,0,1.5,9007199254740992",
    AllowedTeamId: "8,7,-4",
  })).allowedTeamIds, ["7", "8"]);
});

test("allowed email addresses are lowercased, trimmed and deduplicated by exact value", () => {
  assert.deepEqual(payloadOf(buildMdmSignInPolicyHeaderValue({
    AllowedLoginEmails: " Alice@Example.COM, invalid, alice@example.com, @org ",
  })).allowedLoginEmails, ["alice@example.com", "@org"]);
});

test("allowed domains remove one leading at-sign and reject malformed values", () => {
  assert.deepEqual(payloadOf(buildMdmSignInPolicyHeaderValue({
    AllowedLoginDomains: " @EXAMPLE.COM,@,bad name,corp@evil.com,corp.io ",
  })).allowedLoginDomains, ["example.com", "corp.io"]);
});

test("a non-enforcing policy still carries allowed identities in a versioned base64url header", () => {
  const header = buildMdmSignInPolicyHeaderValue({ SignInEnforcement: false, AllowedTeamIds: "9" });
  assert.match(header?.slice(3) ?? "", /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(payloadOf(header), {
    enforced: false,
    allowedOrganizationIds: [],
    allowedTeamIds: ["9"],
    allowedLoginEmails: [],
    allowedLoginDomains: [],
  });
});

test("policy source selection prefers the Slate JSON override and projects only known fields", async () => {
  let touchedPlatform = false;
  const context = sourceContext({
    environment: { [SLATE_MDM_SIGN_IN_POLICY_ENV]: JSON.stringify({ SignInEnforcement: true, Unexpected: "discard" }) },
    io: {
      fileExists: async () => { touchedPlatform = true; return true; },
      readFile: async () => { touchedPlatform = true; return "{}"; },
      run: async () => { touchedPlatform = true; return { stdout: "{}" }; },
    },
  });
  assert.deepEqual(await readMdmPolicyValues(context), { SignInEnforcement: true });
  assert.equal(touchedPlatform, false);
});

test("an invalid explicit override fails closed instead of reading platform policy", async () => {
  let platformReads = 0;
  const context = sourceContext({
    environment: { [SLATE_MDM_SIGN_IN_POLICY_ENV]: "{" },
    io: {
      fileExists: async () => { platformReads += 1; return true; },
      readFile: async () => { platformReads += 1; return "{}"; },
      run: async () => { platformReads += 1; return { stdout: "{}" }; },
    },
  });
  assert.equal(await readMdmPolicyValues(context), undefined);
  assert.equal(platformReads, 0);
});

test("an override with no recognized policy fields stays absent", async () => {
  const context = sourceContext({ environment: { [SLATE_MDM_SIGN_IN_POLICY_ENV]: JSON.stringify({ UnknownSetting: true }) } });
  assert.equal(await readMdmPolicyValues(context), undefined);
});

test("an empty override falls through to the platform reader", async () => {
  const requested: string[] = [];
  const context = sourceContext({
    environment: { [SLATE_MDM_SIGN_IN_POLICY_ENV]: "" },
    io: {
      fileExists: async () => false,
      readFile: async (path) => { requested.push(path); return JSON.stringify({ AllowedTeamIds: "12", Extra: true }); },
      run: async () => ({ stdout: "{}" }),
    },
  });
  assert.deepEqual(await readMdmPolicyValues(context), { AllowedTeamIds: "12" });
  assert.deepEqual(requested, ["/home/slate-user/.slate/policy.json"]);
});

test("macOS checks per-user and system preferences in order and prefers an enforcing result", async () => {
  const attempted: string[] = [];
  const commands: Array<[string, string[]]> = [];
  const paths = MACOS_POLICY_DOMAINS.flatMap((domain) => [
    `/Library/Managed Preferences/slate-user/${domain}.plist`,
    `/Library/Managed Preferences/${domain}.plist`,
  ]);
  const context = sourceContext({
    platform: "darwin",
    io: {
      fileExists: async () => true,
      readFile: async () => "",
      run: async (command, args) => {
        const path = args.at(-1) ?? "";
        attempted.push(path);
        commands.push([command, [...args]]);
        if (path === paths[0]) return { stdout: JSON.stringify({ SignInEnforcement: false, AllowedTeamIds: "0" }) };
        if (path === paths[1]) return { stdout: JSON.stringify({ Unexpected: "ignore" }) };
        if (path === paths[2]) return { stdout: JSON.stringify({ SignInEnforcement: true, AllowedOrganizationIds: "0042" }) };
        return { stdout: JSON.stringify({ SignInEnforcement: false, AllowedTeamIds: "00" }) };
      },
    },
  });
  assert.deepEqual(await readMdmPolicyValues(context), { SignInEnforcement: true, AllowedOrganizationIds: "0042" });
  assert.deepEqual(attempted, paths.slice(0, 3));
  assert.deepEqual(commands.map(([command, args]) => [command, args.slice(0, 4)]), Array.from({ length: 3 }, () => ["plutil", ["-convert", "json", "-o", "-"]]));
});

test("macOS returns the first recognized fallback when no preference enforces sign-in", async () => {
  const attempted: string[] = [];
  const paths = MACOS_POLICY_DOMAINS.flatMap((domain) => [
    `/Library/Managed Preferences/slate-user/${domain}.plist`,
    `/Library/Managed Preferences/${domain}.plist`,
  ]);
  const context = sourceContext({
    platform: "darwin",
    io: {
      fileExists: async () => true,
      readFile: async () => "",
      run: async (_command, args) => {
        const path = args.at(-1) ?? "";
        attempted.push(path);
        return { stdout: JSON.stringify({ SignInEnforcement: false, AllowedTeamIds: path === paths[0] ? "0" : "00" }) };
      },
    },
  });
  assert.deepEqual(await readMdmPolicyValues(context), { SignInEnforcement: false, AllowedTeamIds: "0" });
  assert.deepEqual(attempted, paths);
});

test("macOS skips missing preference files and conversion failures", async () => {
  const attempted: string[] = [];
  const presentPath = `/Library/Managed Preferences/slate-user/${MACOS_POLICY_DOMAINS[1]}.plist`;
  const context = sourceContext({
    platform: "darwin",
    io: {
      fileExists: async (path) => path === presentPath,
      readFile: async () => "",
      run: async (_command, args) => {
        const path = args.at(-1) ?? "";
        attempted.push(path);
        if (path === presentPath) throw new Error("plutil failed");
        return { stdout: JSON.stringify({ SignInEnforcement: true }) };
      },
    },
  });
  assert.equal(await readMdmPolicyValues(context), undefined);
  assert.deepEqual(attempted, [presentPath]);
});

test("Windows reads registry keys in order and parses DWORD and string values", async () => {
  const queried: string[] = [];
  const context = sourceContext({
    platform: "win32",
    io: {
      fileExists: async () => false,
      readFile: async () => "",
      run: async (command, args) => {
        assert.equal(command, "reg.exe");
        const key = args.at(-1) ?? "";
        queried.push(key);
        if (key === WINDOWS_POLICY_REGISTRY_KEYS[0]) throw new Error("not configured");
        if (key === WINDOWS_POLICY_REGISTRY_KEYS[1]) return { stdout: "    AllowedTeamIds    REG_SZ    7, 8\r\n    SignInEnforcement    REG_DWORD    0x00000001\r\n" };
        return { stdout: "" };
      },
    },
  });
  assert.deepEqual(await readMdmPolicyValues(context), { SignInEnforcement: 1, AllowedTeamIds: "7, 8" });
  assert.deepEqual(queried, WINDOWS_POLICY_REGISTRY_KEYS.slice(0, 2));
});

test("Windows prefers a later enforcing key over an earlier non-enforcing fallback", async () => {
  const queried: string[] = [];
  const context = sourceContext({
    platform: "win32",
    io: {
      fileExists: async () => false,
      readFile: async () => "",
      run: async (_command, args) => {
        const key = args.at(-1) ?? "";
        queried.push(key);
        return { stdout: key === WINDOWS_POLICY_REGISTRY_KEYS[0]
          ? "    SignInEnforcement    REG_DWORD    0x00000000\r\n"
          : "    SignInEnforcement    REG_DWORD    0x00000001\r\n    AllowedTeamIds    REG_SZ    9\r\n" };
      },
    },
  });
  assert.deepEqual(await readMdmPolicyValues(context), { SignInEnforcement: 1, AllowedTeamIds: "9" });
  assert.deepEqual(queried, WINDOWS_POLICY_REGISTRY_KEYS.slice(0, 2));
});

test("Windows keeps the first recognized fallback when no registry key enforces sign-in", async () => {
  const context = sourceContext({
    platform: "win32",
    io: {
      fileExists: async () => false,
      readFile: async () => "",
      run: async (_command, args) => ({ stdout: args.at(-1) === WINDOWS_POLICY_REGISTRY_KEYS[0]
        ? "    SignInEnforcement    REG_DWORD    0x00000000\r\n    AllowedTeamIds    REG_SZ    0\r\n"
        : "    SignInEnforcement    REG_DWORD    0x00000000\r\n    AllowedTeamIds    REG_SZ    00\r\n" }),
    },
  });
  assert.deepEqual(await readMdmPolicyValues(context), { SignInEnforcement: 0, AllowedTeamIds: "0" });
});

test("Linux reads only the Slate policy file and returns known settings", async () => {
  const requested: string[] = [];
  const context = sourceContext({
    io: {
      fileExists: async () => false,
      readFile: async (path) => { requested.push(path); return JSON.stringify({ AllowedLoginEmails: "a@slate.dev", Extra: "ignore" }); },
      run: async () => ({ stdout: "" }),
    },
  });
  assert.deepEqual(await readMdmPolicyValues(context), { AllowedLoginEmails: "a@slate.dev" });
  assert.deepEqual(requested, ["/home/slate-user/.slate/policy.json"]);
});

test("unsupported platforms and unreadable Linux policy files have no policy", async () => {
  let commandCalls = 0;
  assert.equal(await readMdmPolicyValues(sourceContext({ platform: "freebsd", io: { fileExists: async () => false, readFile: async () => "{}", run: async () => { commandCalls += 1; return { stdout: "{}" }; } } })), undefined);
  assert.equal(await readMdmPolicyValues(sourceContext({ platform: "linux", io: { fileExists: async () => false, readFile: async () => { throw new Error("missing"); }, run: async () => ({ stdout: "{}" }) } })), undefined);
  assert.equal(commandCalls, 0);
});

test("policy value selection ignores unrelated fields and copies only recognized values", async () => {
  const context = sourceContext({
    environment: { [SLATE_MDM_SIGN_IN_POLICY_ENV]: JSON.stringify({ AllowedTeamId: "5", Unknown: "discard" }) },
  });
  const selected = await readMdmPolicyValues(context);
  assert.deepEqual(selected, { AllowedTeamId: "5" });
});

test("the cached reader reuses a result inside its lifetime and refreshes at the boundary", async () => {
  let nowMs = 100_000;
  let reads = 0;
  let current: Record<string, unknown> | undefined = { SignInEnforcement: true };
  const reader = createMdmSignInPolicyReader(async () => { reads += 1; return current; }, { now: () => nowMs });
  const initial = await reader.readMdmSignInPolicyHeaderValue();
  assert.equal(await reader.readMdmSignInPolicyHeaderValue(), initial);
  assert.equal(reads, 1);
  nowMs += POLICY_CACHE_TTL_MS;
  current = { AllowedTeamIds: "11" };
  assert.deepEqual(payloadOf(await reader.readMdmSignInPolicyHeaderValue()), {
    enforced: false,
    allowedOrganizationIds: [],
    allowedTeamIds: ["11"],
    allowedLoginEmails: [],
    allowedLoginDomains: [],
  });
  assert.equal(reads, 2);
});

test("the cached reader holds an absent or failed result until its TTL expires", async () => {
  let nowMs = 50_000;
  let reads = 0;
  const reader = createMdmSignInPolicyReader(async () => {
    reads += 1;
    if (reads === 1) throw new Error("policy service unavailable");
    return { SignInEnforcement: true };
  }, { now: () => nowMs });
  assert.equal(await reader.readMdmSignInPolicyHeaderValue(), undefined);
  assert.equal(await reader.readMdmSignInPolicyHeaderValue(), undefined);
  assert.equal(reads, 1);
  nowMs += POLICY_CACHE_TTL_MS;
  assert.equal(payloadOf(await reader.readMdmSignInPolicyHeaderValue()).enforced, true);
  assert.equal(reads, 2);
});

test("policy headers are empty when unconstrained and use the owned header key when constrained", async () => {
  const absent = createMdmSignInPolicyReader(async () => undefined, { now: () => 40_000 });
  assert.deepEqual(await absent.mdmSignInPolicyHeaders(), {});
  const present = createMdmSignInPolicyReader(async () => ({ SignInEnforcement: true }), { now: () => 40_000 });
  const headers = await present.mdmSignInPolicyHeaders();
  assert.deepEqual(Object.keys(headers), [MDM_SIGN_IN_POLICY_HEADER_NAME]);
  assert.equal(payloadOf(headers[MDM_SIGN_IN_POLICY_HEADER_NAME]).enforced, true);
});

test("policy violations keep the declared error identity and message", () => {
  const error = new SignInPolicyViolationError();
  assert.deepEqual([error.name, error.message], ["SignInPolicyViolationError", SIGN_IN_POLICY_VIOLATION_MESSAGE]);
  assert.equal(SIGN_IN_POLICY_VIOLATION_ERROR, "sign_in_policy_violation");
  assert.equal(SIGN_IN_POLICY_VIOLATION_MESSAGE, "Sign-in on this device is restricted by your organization's device policy. Sign in with an allowed account to continue.");
});
