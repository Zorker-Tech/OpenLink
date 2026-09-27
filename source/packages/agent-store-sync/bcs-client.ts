/**
 * Talking to the store's own service.
 *
 * A token that is not authorized, a listing that cannot be made and a body that is not what it said it was are each
 * raised as their own error, so a caller can tell what to do about them.
 */
export class AgentStoreUnauthorizedError extends Error {
  constructor(message = "Agent store token is unauthorized") { super(message); this.name = "AgentStoreUnauthorizedError"; }
}
export class AgentStoreDirectoryListingError extends Error {
  constructor(message: string) { super(message); this.name = "AgentStoreDirectoryListingError"; }
}
export class AgentStoreProtocolError extends Error {
  constructor(message: string) { super(message); this.name = "AgentStoreProtocolError"; }
}
