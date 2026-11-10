/**
 * The capabilities a plugin may declare.
 *
 * A plugin asks for what it needs by name; the names are the ones the platform understands, and a list that names the
 * same capability twice is one capability rather than two.
 */
import { z } from "zod";

/** The capability names the platform understands. */
export const CapabilitySchema = z.enum(["canvas"]);

export type Capability = z.infer<typeof CapabilitySchema>;

/** A declared list as one entry per capability, in name order. */
function onceEach(declared: Capability[]): Capability[] {
  return [...new Set(declared)].sort();
}

/** A list of capabilities, with a name declared twice counted once and the list in name order. */
const CapabilityListSchema = z.array(CapabilitySchema);

/** A list of capabilities, with a name declared twice counted once and the list in name order. */
export const CapabilitiesSchema = CapabilityListSchema.transform(onceEach);