/**
 * A module of the reference runtime with no surface of its own.
 *
 * The runtime this was taken from kept this module only for its strict-mode initializer, and the only edge
 * it preserved was the lifecycle state machine it imports — nothing names this module, so nothing else was
 * kept. It is kept as an empty module so the layout matches, with the import that edge represents.
 */

import "./subagent-lifecycle-state-machine.ts"

export {}
