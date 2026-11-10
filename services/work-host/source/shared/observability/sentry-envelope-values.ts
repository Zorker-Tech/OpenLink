/** Check the plain object shapes accepted at the envelope boundary. */
export function isEnvelopeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
