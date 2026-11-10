/** Names shared across send acceptance, gateway handoff, and coordinator receipt tracking. */
const SEND_ACCEPTANCE_IDENTIFIERS = {
  digestConflict: "send/nonce-digest-mismatch",
  hostSlot: "host",
  compatibilitySwitch: "SLATE_DISABLE_SEND_ACCEPT_RETURN",
} as const;

export const NONCE_DIGEST_MISMATCH = SEND_ACCEPTANCE_IDENTIFIERS.digestConflict;
export const HOST_ACCOUNT_SLOT = SEND_ACCEPTANCE_IDENTIFIERS.hostSlot;
export const DISABLE_SEND_ACCEPT_RETURN_ENV = SEND_ACCEPTANCE_IDENTIFIERS.compatibilitySwitch;
