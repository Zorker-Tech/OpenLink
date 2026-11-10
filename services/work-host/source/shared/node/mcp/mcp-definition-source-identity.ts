export function backendEntryBelongsToRow(
  entry: { readonly rowServerIdentifier?: string },
  rowIdentifier: string,
): boolean {
  return entry.rowServerIdentifier === rowIdentifier;
}

export function displayRowOwnsIdentifier(
  identifier: string,
  rowIdentifier: string,
  slots?: readonly { readonly serverIdentifier?: string }[],
): boolean {
  return identifier === rowIdentifier || (slots?.some((slot) => slot.serverIdentifier === identifier) ?? false);
}
