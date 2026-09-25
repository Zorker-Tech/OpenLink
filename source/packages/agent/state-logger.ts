/**
 * The logger the conversation state writes under.
 *
 * State changes are replayed and compared, so what the state says about itself has to be attributable:
 * every entry carries the scope below, which is what makes a state problem findable in a log that also
 * carries the turn's own output.
 */

import { createLogger } from "../context/logging.ts"

export const stateLogger = createLogger("agent/state")
