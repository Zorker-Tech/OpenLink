export type GatewayReachabilityOutcome =
  | "no_storage"
  | "box_blocked"
  | "access_denied"
  | "refused"
  | "dns"
  | "timeout"
  | "network"
  | "http_5xx";

export interface GatewayFailureClassification {
  outcome: GatewayReachabilityOutcome;
  causeSummary?: string;
}

export interface GatewayFetchFailureClassification extends GatewayFailureClassification {
  causeSummary: string;
}

export class SlateGatewayUnreachableError extends Error {
  readonly httpStatus?: number;
  readonly causeSummary?: string;
  readonly attemptedBaseUrl?: string;
  readonly isPreDispatch?: boolean;

  constructor(
    readonly kind: GatewayReachabilityOutcome,
    message: string,
    options?: {
      cause?: unknown;
      httpStatus?: number;
      causeSummary?: string;
      attemptedBaseUrl?: string;
      isPreDispatch?: boolean;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SlateGatewayUnreachableError";
    if (options?.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options?.causeSummary !== undefined) this.causeSummary = options.causeSummary;
    if (options?.attemptedBaseUrl !== undefined) this.attemptedBaseUrl = options.attemptedBaseUrl;
    if (options?.isPreDispatch !== undefined) this.isPreDispatch = options.isPreDispatch;
  }
}
