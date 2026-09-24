/**
 * Whether a conversation may send messages to its project.
 *
 * Only the root conversation owns the project's channel: a subagent or a side chat reports back
 * through its parent, and letting it write to the project directly would interleave two narrators.
 */

export function isProjectSendMessageEnabled(state: { readonly isRootProjectConversation?: boolean }): boolean {
  return state.isRootProjectConversation === true
}
