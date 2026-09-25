/**
 * A module of the reference runtime with no surface of its own.
 *
 * The runtime this was taken from kept this module only for its strict-mode initializer: everything it once
 * held was either inlined into a caller or dropped, and nothing names it. It is kept as an empty module so
 * the layout matches the runtime it was taken from, and so a later addition has an obvious place to go.
 */

export {}
