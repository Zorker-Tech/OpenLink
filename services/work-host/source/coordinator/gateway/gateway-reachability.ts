export {
  SlateGatewayUnreachableError,
  type GatewayFetchFailureClassification,
  type GatewayFailureClassification,
  type GatewayReachabilityOutcome,
} from "./gateway-reachability-contracts.ts";
export { outcomeForHttpStatus } from "./gateway-http-outcome.ts";
export { classifyGatewayError, classifyGatewayFetchFailure } from "./gateway-fetch-classifier.ts";
export { classifyStreamDown } from "./gateway-stream-classifier.ts";
export { classifyBaseUrlKind } from "./gateway-base-url-kind.ts";
