/**
 * The capabilities a plugin may declare.
 *
 * A plugin asks for what it needs by name; the names are the ones the platform understands, and a list that names the
 * same capability twice is one capability rather than two.
 */
import { z } from "zod";
export const CapabilitySchema = z.enum(["canvas"]);
export const CapabilitiesSchema = z.array(CapabilitySchema).transform((capabilities) => [...new Set(capabilities)].sort());
export type Capability = z.infer<typeof CapabilitySchema>;
