/** What is raised when a message could not be persisted, so a caller does not report it as sent. */
export class SlateSendNotPersistedError extends Error {
  constructor() {
    super(
      "Slate send could not persist to the addressed agent's store (db locked or closed); rejecting so the client retry is not swallowed.",
    );
    this.name = "SlateSendNotPersistedError";
  }
}
