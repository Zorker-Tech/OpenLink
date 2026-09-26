/** What is raised when something wants to deliver to a channel and no delivery mechanism was registered. */
export class SlateChannelDeliveryUnregisteredError extends Error {
  constructor() {
    super("No channel delivery mechanism is registered.");
    this.name = "SlateChannelDeliveryUnregisteredError";
  }
}
