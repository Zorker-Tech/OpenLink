/**
 * Talking to the store's own service.
 *
 * A token that is not authorized, a listing that cannot be made and a body that is not what it said it was are each
 * raised as their own error, so a caller can tell what to do about them. Each error declares the name it reports
 * itself under, because that name is what a caller switches on.
 */

/** The name an unauthorized token reports itself under. */
const UNAUTHORIZED_ERROR_NAME = "AgentStoreUnauthorizedError";

/** The name a listing that cannot be made reports itself under. */
const DIRECTORY_LISTING_ERROR_NAME = "AgentStoreDirectoryListingError";

/** The name a body that is not what it said it was reports itself under. */
const PROTOCOL_ERROR_NAME = "AgentStoreProtocolError";

/** What an unauthorized token is reported as when the store says nothing more. */
const UNAUTHORIZED_ERROR_MESSAGE = "Agent store token is unauthorized";

/** The error a store raises for a token it will not accept. */
export class AgentStoreUnauthorizedError extends Error {
  override name = UNAUTHORIZED_ERROR_NAME;
  constructor(message = UNAUTHORIZED_ERROR_MESSAGE) {
    super(message);
  }
}

/** The error a store raises for a directory listing that cannot be made. */
export class AgentStoreDirectoryListingError extends Error {
  override name = DIRECTORY_LISTING_ERROR_NAME;
  constructor(message: string) {
    super(message);
  }
}

/** The error a store raises for a body that is not the shape the protocol promised. */
export class AgentStoreProtocolError extends Error {
  override name = PROTOCOL_ERROR_NAME;
  constructor(message: string) {
    super(message);
  }
}
