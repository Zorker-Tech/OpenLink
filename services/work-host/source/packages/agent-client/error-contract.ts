export type AgentErrorCode =
  | "authentication"
  | "usage-limit"
  | "payment-required"
  | "configuration-required"
  | "cancelled"
  | "custom-message"
  | "other";

export interface AgentErrorDetails {
  readonly code: AgentErrorCode;
  readonly title?: string | undefined;
  readonly detail?: string | undefined;
  readonly isRetryable?: boolean | undefined;
  readonly actionRequired?: string | undefined;
  readonly expected?: boolean | undefined;
}
