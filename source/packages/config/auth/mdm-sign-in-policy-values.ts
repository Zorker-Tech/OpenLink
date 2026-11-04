import type { RawPolicy } from "./mdm-sign-in-policy-contracts.ts";

function commaValues(raw: unknown): string[] {
  return (raw == null ? "" : String(raw))
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function positiveSafeIds(raw: unknown): number[] {
  const values = commaValues(raw).map(Number);
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))];
}

function canonicalOrganizationIds(raw: unknown): string[] {
  const decimalValues = commaValues(raw).filter((value) => /^\d+$/.test(value));
  return [...new Set(decimalValues.map((value) => BigInt(value).toString()).filter((value) => value !== "0"))];
}

function allowedDomain(raw: string): string | undefined {
  let domain = raw.trim().toLowerCase();
  if (domain.startsWith("@")) domain = domain.slice(1);
  if (domain.length === 0 || domain.includes("@") || /\s/.test(domain)) return undefined;
  return domain;
}

function enforcementIsActive(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw === 1;
  return typeof raw === "string" && ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Build the bounded header payload from the policy's scalar and list values. */
export function buildMdmSignInPolicyHeaderValue(raw: RawPolicy): string | undefined {
  const enforced = enforcementIsActive(raw.SignInEnforcement);
  const allowedOrganizationIds = canonicalOrganizationIds(raw.AllowedOrganizationIds);
  const allowedTeamIds = [
    ...new Set([...positiveSafeIds(raw.AllowedTeamIds), ...positiveSafeIds(raw.AllowedTeamId)]),
  ];
  const allowedLoginEmails = [
    ...new Set(commaValues(raw.AllowedLoginEmails).map((email) => email.toLowerCase()).filter((email) => email.includes("@"))),
  ];
  const allowedLoginDomains = [
    ...new Set(commaValues(raw.AllowedLoginDomains).map(allowedDomain).filter((domain): domain is string => domain !== undefined)),
  ];
  const hasRestrictions = allowedOrganizationIds.length > 0
    || allowedTeamIds.length > 0
    || allowedLoginEmails.length > 0
    || allowedLoginDomains.length > 0;
  if (!enforced && !hasRestrictions) return undefined;

  const payload = {
    enforced,
    allowedOrganizationIds,
    allowedTeamIds: allowedTeamIds.map(String),
    allowedLoginEmails,
    allowedLoginDomains,
  };
  return `v1.${Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url")}`;
}

/** Keep only the policy fields the Slate sign-in contract understands. */
export function pickMdmPolicyValues(source: RawPolicy): RawPolicy | undefined {
  const knownFields = [
    "SignInEnforcement",
    "AllowedOrganizationIds",
    "AllowedTeamIds",
    "AllowedTeamId",
    "AllowedLoginEmails",
    "AllowedLoginDomains",
  ] as const;
  const selected: RawPolicy = {};
  let hasValue = false;
  for (const field of knownFields) {
    if (source[field] === undefined) continue;
    selected[field] = source[field];
    hasValue = true;
  }
  return hasValue ? selected : undefined;
}
