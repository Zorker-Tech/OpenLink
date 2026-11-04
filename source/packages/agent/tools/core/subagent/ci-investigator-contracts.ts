export interface PromptToolSetHandle {
  getAllTools(): readonly Record<string, unknown>[];
  getStaticTools(): readonly Record<string, unknown>[];
  getDescriptionProps(): { allTools: Record<string, unknown> };
  hasTool(identifier: string): boolean;
}
