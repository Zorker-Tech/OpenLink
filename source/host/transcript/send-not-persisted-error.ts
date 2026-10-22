/** What is raised when a message could not be persisted, so a caller does not report it as sent. */
const NOT_PERSISTED_ERROR_NAME = "SlateSendNotPersistedError";

/** What the error says: the store would not take the message, and the client's retry must not be swallowed. */
const NOT_PERSISTED_ERROR_MESSAGE =
  "Slate send could not persist to the addressed agent's store (db locked or closed); rejecting so the client retry is not swallowed.";

/** The error a send raises when the store would not take the message. */
export class SlateSendNotPersistedError extends Error {
  override name = NOT_PERSISTED_ERROR_NAME;
  constructor() {
    super(NOT_PERSISTED_ERROR_MESSAGE);
  }
}
