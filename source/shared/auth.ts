/**
 * Which account a status belongs to.
 *
 * The account's own id is preferred, and an account that is not signed in has no slot at all: the slot is what other
 * state is filed under, so an empty one would file it under nothing.
 */
export interface AccountStatus {
  readonly kind: string;
  readonly authId?: string;
  readonly email?: string;
  readonly [key: string]: unknown;
}

export function accountSlot(status: AccountStatus): string | null {
  if (status.kind !== "logged-in") return null;
  const slot = status.authId ?? status.email;
  return slot == null || slot.length === 0 ? null : slot;
}
