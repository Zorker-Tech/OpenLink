/** Only the root project conversation owns the project's outbound message channel. */
export function canRootConversationSendToProject(state: { readonly isRootProjectConversation?: boolean }): boolean {
  return state.isRootProjectConversation === true
}
