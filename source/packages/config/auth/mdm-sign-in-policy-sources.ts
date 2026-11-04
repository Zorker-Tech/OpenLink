import { join } from "node:path";
import {
  MACOS_POLICY_DOMAINS,
  SLATE_MDM_SIGN_IN_POLICY_ENV,
  WINDOWS_POLICY_REGISTRY_KEYS,
  type MdmPolicySourceContext,
  type RawPolicy,
} from "./mdm-sign-in-policy-contracts.ts";
import { buildMdmSignInPolicyHeaderValue, pickMdmPolicyValues } from "./mdm-sign-in-policy-values.ts";

async function readMacManagedPreferences(context: MdmPolicySourceContext): Promise<RawPolicy | undefined> {
  const locations = MACOS_POLICY_DOMAINS.flatMap((domain) => [
    join("/Library/Managed Preferences", context.username, `${domain}.plist`),
    join("/Library/Managed Preferences", `${domain}.plist`),
  ]);
  let firstRecognized: RawPolicy | undefined;

  for (const location of locations) {
    try {
      if (!await context.io.fileExists(location)) continue;
    } catch {
      continue;
    }

    try {
      const converted = await context.io.run("plutil", ["-convert", "json", "-o", "-", location]);
      const values = pickMdmPolicyValues(JSON.parse(converted.stdout) as RawPolicy);
      if (values === undefined) continue;
      if (buildMdmSignInPolicyHeaderValue(values) !== undefined) return values;
      firstRecognized ??= values;
    } catch {
      // Managed preference files are optional and may be unreadable or malformed.
    }
  }
  return firstRecognized;
}

async function readWindowsRegistry(context: MdmPolicySourceContext): Promise<RawPolicy | undefined> {
  let firstRecognized: RawPolicy | undefined;
  for (const key of WINDOWS_POLICY_REGISTRY_KEYS) {
    let stdout: string;
    try {
      ({ stdout } = await context.io.run("reg.exe", ["query", key]));
    } catch {
      continue;
    }

    const values: RawPolicy = {};
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^\s{4}(\S+)\s+(REG_\w+)\s+(.*)$/.exec(line);
      if (match == null) continue;
      const [, name, type, value] = match;
      values[name!] = type === "REG_DWORD" ? Number.parseInt(value!.trim(), 16) : value!.trim();
    }

    const selected = pickMdmPolicyValues(values);
    if (selected === undefined) continue;
    if (buildMdmSignInPolicyHeaderValue(selected) !== undefined) return selected;
    firstRecognized ??= selected;
  }
  return firstRecognized;
}

async function readLinuxPolicyFile(context: MdmPolicySourceContext): Promise<RawPolicy | undefined> {
  try {
    const parsed = JSON.parse(await context.io.readFile(join(context.homeDirectory, ".slate", "policy.json"))) as RawPolicy;
    return pickMdmPolicyValues(parsed);
  } catch {
    return undefined;
  }
}

/** Read a supplied override first, then the current platform's managed policy source. */
export async function readMdmPolicyValues(context: MdmPolicySourceContext): Promise<RawPolicy | undefined> {
  const override = context.environment[SLATE_MDM_SIGN_IN_POLICY_ENV];
  if (override !== undefined && override.length > 0) {
    try {
      return pickMdmPolicyValues(JSON.parse(override) as RawPolicy);
    } catch {
      return undefined;
    }
  }

  switch (context.platform) {
    case "darwin":
      return await readMacManagedPreferences(context);
    case "win32":
      return await readWindowsRegistry(context);
    case "linux":
      return await readLinuxPolicyFile(context);
    default:
      return undefined;
  }
}
