import { createLocalCliModeHeaders } from "../request.ts";
import {
  mdmSignInPolicyHeaders,
  SignInPolicyViolationError,
  SIGN_IN_POLICY_VIOLATION_ERROR,
} from "./mdm-sign-in-policy.ts";
import { proxyFetch } from "./proxy-fetch.ts";
import { resolveApiBaseUrl, type SlateTokens } from "./login-contracts.ts";

function cancellationRequested(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function retryInterval(round: number): number {
  return Math.min(1_000 * 1.2 ** round, 10_000);
}

function pauseUntilRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (cancellationRequested(signal)) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function hasTokenPair(value: unknown): value is SlateTokens {
  if (typeof value !== "object" || value === null) return false;
  return "accessToken" in value
    && typeof value.accessToken === "string"
    && "refreshToken" in value
    && typeof value.refreshToken === "string";
}

/** Poll the sign-in endpoint until a token pair arrives, the request is aborted, or the service keeps failing. */
export async function pollAuthenticationStatus(args: {
  readonly uuid: string;
  readonly verifier: string;
  readonly apiBaseUrl?: string;
  readonly signal?: AbortSignal;
}): Promise<SlateTokens | null> {
  const {
    uuid: sessionId,
    verifier: proofValue,
    apiBaseUrl,
    signal: cancellationSignal,
  } = args;
  const pollEndpoint = `${resolveApiBaseUrl(apiBaseUrl)}/auth/poll`;
  const devicePolicyHeaders = await mdmSignInPolicyHeaders();
  let failureStreak = 0;

  for (let round = 0; round < 150; round += 1) {
    if (cancellationRequested(cancellationSignal)) return null;
    try {
      const init: RequestInit = {
        headers: createLocalCliModeHeaders({ "Content-Type": "application/json", ...devicePolicyHeaders }),
      };
      if (cancellationSignal !== undefined) init.signal = cancellationSignal;
      const reply = await proxyFetch(`${pollEndpoint}?uuid=${sessionId}&verifier=${proofValue}`, init);

      if (reply.status === 403) {
        const policyReply = await reply.json().catch(() => undefined) as { error?: unknown } | undefined;
        if (policyReply?.error === SIGN_IN_POLICY_VIOLATION_ERROR) throw new SignInPolicyViolationError();
      }
      if (reply.status === 404) {
        failureStreak = 0;
        await pauseUntilRetry(retryInterval(round), cancellationSignal);
        continue;
      }
      if (!reply.ok) {
        failureStreak += 1;
        if (failureStreak >= 3) return null;
        await pauseUntilRetry(retryInterval(round), cancellationSignal);
        continue;
      }

      failureStreak = 0;
      const tokenPayload: unknown = await reply.json();
      return hasTokenPair(tokenPayload) ? tokenPayload : null;
    } catch (cause) {
      if (cause instanceof SignInPolicyViolationError) throw cause;
      if (cancellationRequested(cancellationSignal)) return null;
      failureStreak += 1;
      if (failureStreak >= 3) return null;
      await pauseUntilRetry(retryInterval(round), cancellationSignal);
    }
  }
  return null;
}
