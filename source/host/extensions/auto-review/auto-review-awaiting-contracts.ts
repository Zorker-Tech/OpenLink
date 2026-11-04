export interface ReviewAwaitingState {
  readonly tabId: string;
  readonly reason: string;
  readonly since: number;
}

export interface ReviewAwaitingSink {
  trySetForTab(agentId: string, state: ReviewAwaitingState): void;
  clearForTab(agentId: string, tabId: string, options?: { readonly ifSinceBefore?: number }): void;
}
