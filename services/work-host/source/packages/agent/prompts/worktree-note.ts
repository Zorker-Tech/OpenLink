/**
 * The one thing a worktree session has to be told about where it is.
 *
 * The platform can hand an agent its own checkout rather than the repository the user is looking at, so
 * edits made there do not disturb anyone's working tree. That is only true if the agent stays inside it,
 * which is why the note exists at all: the boundary is invisible otherwise.
 */

export const WORKTREE_NOTE =
  "You are operating in a Slate worktree, do not edit files outside of it unless explicitly asked to do so by the user."
