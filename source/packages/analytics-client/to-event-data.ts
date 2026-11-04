/**
 * Normalizing a Slate analytics event's properties.
 *
 * The host keeps only primitive properties in its own event contract. The interop adapter encodes those values for
 * the external wire message.
 */
import type { AnalyticsEventProperties, AnalyticsEventProperty } from "./events.ts"

export function toAnalyticsEventProperties(props: AnalyticsEventProperties | null | undefined): Readonly<Record<string, AnalyticsEventProperty>> {
  const out: Record<string, AnalyticsEventProperty> = {}
  if (!props) return out
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      out[key] = value
    }
  }
  return out
}
