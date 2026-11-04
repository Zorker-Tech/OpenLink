import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolveWebsiteUrl } from "./login-contracts.ts";

function toWebSafeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function challengeFor(verifier: string): Buffer {
  return createHash("sha256").update(verifier).digest();
}

/** Make the verifier pair and browser URL used for one sign-in attempt. */
export function generateAuthParams(
  redirectTarget = "cli",
  websiteUrl = resolveWebsiteUrl(),
): { uuid: string; challenge: string; verifier: string; loginUrl: string } {
  const proof = toWebSafeBase64(randomBytes(32));
  const digest = toWebSafeBase64(challengeFor(proof));
  const requestId = randomUUID();
  const browserUrl = `${websiteUrl}/loginDeepControl?challenge=${digest}&uuid=${requestId}&mode=login&redirectTarget=${redirectTarget}`;
  return { uuid: requestId, challenge: digest, verifier: proof, loginUrl: browserUrl };
}
