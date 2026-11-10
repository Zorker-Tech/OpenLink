export function humanEntryIdentity(entryId: string, authorAuthId: string): Record<string, unknown> {
  return { entryId, authorAuthId, authorName: "Host" };
}

export function humanEntryContent(text: string, images: unknown[]): Record<string, unknown> {
  return { text, images };
}

export function agentEntryIdentity(
  entryId: string,
  agentOwnerAuthId: string,
  agentId: string,
  authorName: string,
): Record<string, unknown> {
  return { entryId, agentOwnerAuthId, agentId, authorName };
}

export function agentEntryContent(text: string, images: unknown[]): Record<string, unknown> {
  return { text, images };
}

export function clientNonceField(clientNonce: unknown): Record<string, unknown> {
  return clientNonce == null ? {} : { clientNonce };
}

export function roomTimestampField(timestampMs: number | undefined, now: () => number): Record<string, unknown> {
  return { timestampMs: timestampMs ?? now() };
}
