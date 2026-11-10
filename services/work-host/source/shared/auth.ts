/** Identity fields exposed by an account status. */
export interface AuthenticatedAccountStatus {
  readonly kind: string;
  readonly authId?: string;
  readonly email?: string;
  readonly [key: string]: unknown;
}

export function authenticatedAccountKey(status: AuthenticatedAccountStatus): string | null {
  if (status.kind !== "logged-in") return null;
  const identifier = status.authId ?? status.email;
  if (identifier == null || identifier.length === 0) return null;
  return identifier;
}
