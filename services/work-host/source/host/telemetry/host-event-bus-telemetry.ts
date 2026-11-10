/** Values carried when reporting a host event-delivery failure. */
import { HOST_EVENT_BUS_EVENT } from "../../shared/observability/telemetry-events.ts";

export interface HostEventBusFailureInput {
  readonly kind: string;
  readonly topic: string;
  readonly errorClass: string;
}

export function mapHostEventBusFailure(failure: HostEventBusFailureInput) {
  const metadata = {
    kind: failure.kind,
    topic: failure.topic,
    error_class: failure.errorClass,
  };
  return {
    level: "error",
    event: HOST_EVENT_BUS_EVENT,
    metadata,
  };
}
