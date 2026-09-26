/** The context key that says work was started quietly rather than by the user. */
import { createKey } from "../packages/context/context.ts";

export const slateQuietWorkOriginKey = createKey(Symbol("slate.quiet-work-origin"), undefined);
