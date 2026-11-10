import { MDM_SIGN_IN_POLICY_HEADER_NAME, POLICY_CACHE_TTL_MS, type RawPolicy } from "./mdm-sign-in-policy-contracts.ts";
import { buildMdmSignInPolicyHeaderValue } from "./mdm-sign-in-policy-values.ts";

/** Cache the resolved policy header for a short window and isolate source errors. */
export function createMdmSignInPolicyReader(
  readRawPolicy: () => Promise<RawPolicy | undefined>,
  options: { readonly now?: () => number; readonly cacheTtlMs?: number } = {},
) {
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? POLICY_CACHE_TTL_MS;
  let cachedHeader: string | undefined;
  let readAtMs = 0;

  async function readMdmSignInPolicyHeaderValue(): Promise<string | undefined> {
    const currentTime = now();
    if (currentTime - readAtMs < cacheTtlMs) return cachedHeader;
    try {
      const raw = await readRawPolicy();
      cachedHeader = raw === undefined ? undefined : buildMdmSignInPolicyHeaderValue(raw);
    } catch {
      cachedHeader = undefined;
    }
    readAtMs = currentTime;
    return cachedHeader;
  }

  async function mdmSignInPolicyHeaders(): Promise<Record<string, string>> {
    const header = await readMdmSignInPolicyHeaderValue();
    return header === undefined ? {} : { [MDM_SIGN_IN_POLICY_HEADER_NAME]: header };
  }

  return { readMdmSignInPolicyHeaderValue, mdmSignInPolicyHeaders };
}
