import { createLocalCliModeHeaders } from "../request.ts";
import {
  mdmSignInPolicyHeaders,
  SignInPolicyViolationError,
  SIGN_IN_POLICY_VIOLATION_ERROR,
} from "./mdm-sign-in-policy.ts";
import { proxyFetch } from "./proxy-fetch.ts";
import { AuthNetworkError, resolveApiBaseUrl, type SlateTokens, type ExchangeApiKeyOptions } from "./login-contracts.ts";

function tokenPair(value: unknown): value is SlateTokens {
  return typeof value === "object"
    && value !== null
    && "accessToken" in value
    && typeof value.accessToken === "string"
    && "refreshToken" in value
    && typeof value.refreshToken === "string";
}

/** Exchange a user-supplied API key for the session token pair. */
export async function exchangeApiKeyForTokens(
  apiKey: string,
  options?: ExchangeApiKeyOptions,
): Promise<SlateTokens | null> {
  const exchangeUrl = `${resolveApiBaseUrl(options?.endpoint)}/auth/exchange_user_api_key`;
  const organizationHeaders = await mdmSignInPolicyHeaders();
  try {
    const requestHeaders = createLocalCliModeHeaders({
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...organizationHeaders,
    });
    const reply = await proxyFetch(exchangeUrl, { method: "POST", headers: requestHeaders, body: JSON.stringify({}) });
    if (reply.status === 403) {
      const policyReply = await reply.json().catch(() => undefined) as { error?: unknown } | undefined;
      if (policyReply?.error === SIGN_IN_POLICY_VIOLATION_ERROR) throw new SignInPolicyViolationError();
      return null;
    }
    if (reply.status >= 500) throw new AuthNetworkError(new Error(`exchange_user_api_key returned HTTP ${reply.status}`));
    if (!reply.ok) return null;
    const tokenResult: unknown = await reply.json();
    return tokenPair(tokenResult) ? tokenResult : null;
  } catch (cause) {
    if (cause instanceof SignInPolicyViolationError || cause instanceof AuthNetworkError) throw cause;
    throw new AuthNetworkError(cause);
  }
}
