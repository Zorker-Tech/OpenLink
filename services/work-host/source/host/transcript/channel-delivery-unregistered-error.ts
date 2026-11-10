/** What a channel delivery attempt says when no mechanism was registered. */
const UNREGISTERED_MESSAGE = "No channel delivery mechanism is registered.";

/** Raised when something wants to deliver to a channel and no delivery mechanism was registered. */
export class SlateChannelDeliveryUnregisteredError extends Error {
  constructor() {
    super(UNREGISTERED_MESSAGE);
    this.name = SlateChannelDeliveryUnregisteredError.name;
  }
}
