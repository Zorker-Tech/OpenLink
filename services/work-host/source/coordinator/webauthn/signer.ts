/**
 * Signing a WebAuthn assertion with the platform's own signer.
 *
 * A security key is a physical thing, and the signer is a small program the platform ships to talk to it: the request
 * is handed over, the answer is read back, and a signer that is not there is reported as unavailable rather than as a
 * failure of the key.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { WebAuthnCeremony } from "../../shared/webauthn-gateway.ts";

export const SIGNER_EVENT_PREFIX = "[signer-event] ";

export type SignerEvent =
  | { readonly kind: "presence-required" }
  | { readonly kind: "select-device" }
  | { readonly kind: "pin-not-set" }
  | { readonly kind: "pin-blocked" }
  | { readonly kind: "uv-blocked" }
  | { readonly kind: "uv-invalid" }
  | { readonly kind: "pin-required" }
  | { readonly kind: "pin-invalid"; readonly retries?: number };

export function describeSignerEventAsStatus(signerEvent: SignerEvent): string | undefined {
  switch (signerEvent.kind) {
    case "presence-required": return "Touch your security key now";
    case "select-device": return "Touch the security key you want to use";
    case "pin-not-set": return "This security key has no PIN set, but the site asked for one";
    case "pin-blocked": return "Your security key is locked";
    case "uv-blocked": return "Your security key's fingerprint check is locked";
    case "uv-invalid": return "That didn't match — try again on the key";
    case "pin-required":
    case "pin-invalid": return undefined;
  }
}

export interface WebAuthnSignerError {
  readonly name: string;
  readonly code?: string;
  readonly message: string;
}

export type WebAuthnSignerResult =
  | { readonly ok: true; readonly credentialJson: unknown }
  | { readonly ok: false; readonly error: WebAuthnSignerError };

function signerFailure(error: WebAuthnSignerError): WebAuthnSignerResult {
  return { ok: false, error };
}

export const SIGNER_BINARY = process.platform === "win32" ? "slate-webauthn-signer.exe" : "slate-webauthn-signer";
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export function devRepoRoot(envOverride?: string): string {
  if (envOverride !== undefined) return envOverride;
  return join(moduleDirectory, "..", "..", "..");
}

export function resolveWebAuthnSignerPath(signerOptions: { readonly isPackaged: boolean; readonly repoRoot?: string }): string | undefined {
  const envOverride = process.env.SLATE_WEBAUTHN_SIGNER_PATH;
  if (envOverride !== undefined && envOverride.length > 0) return existsSync(envOverride) ? envOverride : undefined;
  const packagedResources = (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath ?? "";
  const binaryCandidates = signerOptions.isPackaged
    ? [join(packagedResources, "app.asar.unpacked", "dist", "native", SIGNER_BINARY)]
    : [
        join(devRepoRoot(signerOptions.repoRoot), "target", "release", SIGNER_BINARY),
        join(devRepoRoot(signerOptions.repoRoot), "target", "debug", SIGNER_BINARY)
      ];
  return binaryCandidates.find((binaryCandidate) => existsSync(binaryCandidate));
}

export function parseSignerEvent(body: string, log: (message: string) => void): SignerEvent | undefined {
  try {
    return JSON.parse(body) as SignerEvent;
  } catch (error) {
    log(`unreadable signer event ${body}: ${String(error)}`);
    return undefined;
  }
}

export interface ApprovedWebAuthnConsent {
  readonly approved: true;
  readonly promptId?: string;
  readonly windowHandle?: string;
}

export interface SpawnedWebAuthnSignerOptions {
  readonly binaryPath: string;
  readonly log?: (message: string) => void;
  readonly onStatus?: (statusText: string) => void;
  readonly onPinRequest?: (request: { readonly invalid: boolean; readonly retries?: number }, consentPromptId: string) => Promise<string | undefined>;
}

export interface WebAuthnSigner {
  sign(ceremony: WebAuthnCeremony, signal: AbortSignal, consent?: ApprovedWebAuthnConsent): Promise<WebAuthnSignerResult>;
}

export function createSpawnedWebAuthnSigner(signerOptions: SpawnedWebAuthnSignerOptions): WebAuthnSigner {
  const log = signerOptions.log ?? (() => {});
  return {
    sign(ceremony, signal, consent) {
      return new Promise((resolve) => {
        const signerProcess = spawn(signerOptions.binaryPath, [], { stdio: ["pipe", "pipe", "pipe"] });
        let stdoutText = "";
        let stderr = "";
        let isSettled = false;
        const finish = (result: WebAuthnSignerResult) => {
          if (isSettled) return;
          isSettled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        };
        function onAbort() {
          signerProcess.kill("SIGTERM");
          finish(signerFailure({ name: "NotAllowedError", code: "cancelled_or_timeout", message: "the security key request was cancelled" }));
        }
        signal.addEventListener("abort", onAbort, { once: true });
        signerProcess.stdin.on("error", (error) => log(`signer stdin: ${error.message}`));
        const writeReply = (reply: { readonly kind: "cancel" } | { readonly kind: "pin"; readonly pin: string }) => {
          if (isSettled || signerProcess.stdin.destroyed) return;
          signerProcess.stdin.write(`${JSON.stringify(reply)}\n`);
        };
        let promptQueue = Promise.resolve();
        const consentPromptId = consent?.promptId;
        const answerPinRequest = (request: { readonly invalid: boolean; readonly retries?: number }) => {
          promptQueue = promptQueue.then(async () => {
            const pin = consentPromptId === undefined ? undefined : await signerOptions.onPinRequest?.(request, consentPromptId);
            writeReply(pin === undefined || pin === "" ? { kind: "cancel" } : { kind: "pin", pin });
          }).catch((error: unknown) => {
            log(`pin prompt failed: ${String(error)}`);
            writeReply({ kind: "cancel" });
          });
        };
        const handleSignerEvent = (signerEvent: SignerEvent) => {
          if (signerEvent.kind === "pin-required") return answerPinRequest({ invalid: false });
          if (signerEvent.kind === "pin-invalid") {
            answerPinRequest({ invalid: true, ...(signerEvent.retries == null ? {} : { retries: signerEvent.retries }) });
            return;
          }
          const statusText = describeSignerEventAsStatus(signerEvent);
          if (statusText !== undefined) signerOptions.onStatus?.(statusText);
        };
        signerProcess.stdout.on("data", (chunk) => { stdoutText += String(chunk); });
        let lineBuffer = "";
        signerProcess.stderr.on("data", (chunk) => {
          const stderrChunk = String(chunk);
          stderr += stderrChunk;
          lineBuffer += stderrChunk;
          let lineBreak = lineBuffer.indexOf("\n");
          while (lineBreak >= 0) {
            const line = lineBuffer.slice(0, lineBreak).trim();
            lineBuffer = lineBuffer.slice(lineBreak + 1);
            lineBreak = lineBuffer.indexOf("\n");
            if (!line.startsWith(SIGNER_EVENT_PREFIX)) continue;
            const signerEvent = parseSignerEvent(line.slice(SIGNER_EVENT_PREFIX.length), log);
            if (signerEvent !== undefined) handleSignerEvent(signerEvent);
          }
        });
        signerProcess.on("error", (error) => {
          finish(signerFailure({ name: "NotAllowedError", code: "helper_spawn_failed", message: `could not start the security key helper: ${error.message}` }));
        });
        signerProcess.on("close", (code) => {
          if (stderr.length > 0) log(`signer stderr: ${stderr.trim()}`);
          if (stdoutText.length === 0) {
            finish(signerFailure({ name: "NotAllowedError", code: "helper_no_result", message: `the security key helper exited with code ${code} and no result` }));
            return;
          }
          try {
            finish(JSON.parse(stdoutText) as WebAuthnSignerResult);
          } catch (error) {
            finish(signerFailure({ name: "NotAllowedError", code: "helper_no_result", message: `unreadable result from the security key helper: ${String(error)}` }));
          }
        });
        const windowHandle = consent?.windowHandle;
        signerProcess.stdin.write(`${JSON.stringify(windowHandle === undefined ? ceremony : { ...ceremony, windowHandle })}\n`);
      });
    }
  };
}
