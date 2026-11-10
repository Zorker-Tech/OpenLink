/** Slate-owned boundary labels shared by conversation policy and interop adapters. */
export const ProjectConversationBoundary = {
  ROOT: "project-root",
  RELATED: "related-work",
} as const

export type ProjectConversationBoundary = typeof ProjectConversationBoundary[keyof typeof ProjectConversationBoundary]
