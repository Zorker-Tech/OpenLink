import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import type { OAuthTokenSet } from "@vtslx/platform-sdk/auth";
import type {
  CloudConnectionRecord,
  CloudCredentialCipher,
  CloudCredentialEnvelope,
  CloudRevocationReceipt,
} from "./platform-cloud-vault";
import type {
  CloudLoginCipher,
  CloudLoginRecord,
} from "./platform-cloud-login";

function aad(record: CloudConnectionRecord, keyId: string) {
  return Buffer.from(
    JSON.stringify([
      "openlink/cloud-oauth/v1",
      keyId,
      record.user_id,
      record.id,
      record.issuer,
      record.subject,
      record.client_id,
      record.revision,
    ]),
  );
}
function ownedRing(keys: ReadonlyMap<string, Uint8Array>, activeKeyId: string) {
  const ring = new Map<string, Buffer>();
  for (const [id, key] of keys) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || key.byteLength !== 32)
      throw new Error("Invalid Cloud encryption key configuration");
    ring.set(id, Buffer.from(key));
  }
  if (!ring.has(activeKeyId) || ring.size > 16)
    throw new Error("Active Cloud encryption key missing or keyring too large");
  return ring;
}

export function createCloudLoginCipher(
  keys: ReadonlyMap<string, Uint8Array>,
  activeKeyId: string,
): CloudLoginCipher {
  const ring = ownedRing(keys, activeKeyId);
  const binding = (record: CloudLoginRecord, keyId: string) =>
    Buffer.from(
      JSON.stringify([
        "openlink/cloud-login/v1",
        keyId,
        record.user_id,
        record.id,
        record.connection_id,
        record.client_id,
        record.redirect_uri,
      ]),
    );
  return {
    seal(value, record) {
      const body = Buffer.from(JSON.stringify(value));
      if (body.length > 8192)
        throw new Error("Cloud login transaction too large");
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", ring.get(activeKeyId)!, iv);
      cipher.setAAD(binding(record, activeKeyId));
      const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
      return {
        version: 1,
        keyId: activeKeyId,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
    },
    open(envelope, record) {
      try {
        if (
          envelope.version !== 1 ||
          !ring.has(envelope.keyId) ||
          typeof envelope.ciphertext !== "string" ||
          envelope.ciphertext.length > 11000
        )
          throw new Error("invalid envelope");
        const iv = Buffer.from(envelope.iv, "base64"),
          tag = Buffer.from(envelope.tag, "base64");
        if (iv.length !== 12 || tag.length !== 16)
          throw new Error("invalid envelope");
        const decipher = createDecipheriv(
          "aes-256-gcm",
          ring.get(envelope.keyId)!,
          iv,
        );
        decipher.setAAD(binding(record, envelope.keyId));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext, "base64")),
          decipher.final(),
        ]);
        if (plaintext.length > 8192) throw new Error("invalid size");
        return JSON.parse(plaintext.toString("utf8"));
      } catch {
        throw new Error("Cloud login transaction could not be authenticated");
      }
    },
  };
}

/** Invoke only after the trusted host has confirmed remote revocation. */
export function createCloudRevocationSigner(keyId: string, key: Uint8Array) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId) || key.byteLength !== 32)
    throw new Error("Invalid revocation signing configuration");
  const ownedKey = Buffer.from(key);
  return (record: CloudConnectionRecord): CloudRevocationReceipt => {
    if (
      record.state !== "revoking" ||
      !Number.isSafeInteger(record.revision) ||
      record.revision < 1
    )
      throw new Error("Invalid pending revocation identity");
    const message = [
      "openlink/cloud-revocation/v1",
      keyId,
      record.user_id.toLowerCase(),
      record.id.toLowerCase(),
      String(record.revision),
    ].join("\n");
    return {
      key_id: keyId,
      signature: createHmac("sha256", ownedKey).update(message).digest("hex"),
    };
  };
}
function tokens(value: unknown): OAuthTokenSet {
  const data = value as OAuthTokenSet | null;
  if (
    !data ||
    data.tokenType !== "Bearer" ||
    typeof data.accessToken !== "string" ||
    !data.accessToken ||
    !Number.isSafeInteger(data.expiresAt) ||
    data.expiresAt <= 0 ||
    !Array.isArray(data.scope) ||
    data.scope.length > 64 ||
    data.scope.some(
      (scope) =>
        typeof scope !== "string" ||
        !scope ||
        scope.length > 128 ||
        /\s/.test(scope),
    ) ||
    (data.refreshToken !== undefined &&
      (typeof data.refreshToken !== "string" || !data.refreshToken)) ||
    (data.idToken !== undefined && typeof data.idToken !== "string")
  )
    throw new Error("Invalid Cloud OAuth credential bundle");
  return {
    accessToken: data.accessToken,
    ...(data.refreshToken !== undefined
      ? { refreshToken: data.refreshToken }
      : {}),
    ...(data.idToken !== undefined ? { idToken: data.idToken } : {}),
    tokenType: "Bearer",
    expiresAt: data.expiresAt,
    scope: [...data.scope],
  };
}

/** Host/server-only keys, supplied by its secret manager. No Local-key fallback. */
export function createCloudCredentialCipher(
  keys: ReadonlyMap<string, Uint8Array>,
  activeKeyId: string,
): CloudCredentialCipher {
  const ring = ownedRing(keys, activeKeyId);
  return {
    seal(value, record): CloudCredentialEnvelope {
      const plaintext = Buffer.from(JSON.stringify(tokens(value)));
      if (plaintext.byteLength > 32768)
        throw new Error("Cloud OAuth credential bundle too large");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", ring.get(activeKeyId)!, iv);
      cipher.setAAD(aad(record, activeKeyId));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      return {
        version: 1,
        keyId: activeKeyId,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
    },
    open(envelope, record): OAuthTokenSet {
      try {
        if (
          envelope.version !== 1 ||
          !ring.has(envelope.keyId) ||
          typeof envelope.ciphertext !== "string" ||
          envelope.ciphertext.length > 44000
        )
          throw new Error("invalid envelope");
        const iv = Buffer.from(envelope.iv, "base64"),
          tag = Buffer.from(envelope.tag, "base64");
        if (iv.byteLength !== 12 || tag.byteLength !== 16)
          throw new Error("invalid nonce or tag");
        const decipher = createDecipheriv(
          "aes-256-gcm",
          ring.get(envelope.keyId)!,
          iv,
        );
        decipher.setAAD(aad(record, envelope.keyId));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext, "base64")),
          decipher.final(),
        ]);
        if (plaintext.byteLength > 32768) throw new Error("invalid size");
        return tokens(JSON.parse(plaintext.toString("utf8")));
      } catch {
        throw new Error("Cloud OAuth credentials could not be authenticated");
      }
    },
  };
}
