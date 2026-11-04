import type { Context } from "../../../packages/context/context.ts";
import type { DeadlinePolicy, RetryPolicy } from "../scheduling.ts";

export const BOX_SECRETS_FILENAME = "box-secrets.json";
export const SECRETS_APPLY_WAIT_MS = 5_000;
export const SECRETS_RETRY_INITIAL_MS = 1_000;
export const SECRETS_RETRY_MAX_MS = 30_000;

export class BoxSecretsValidationError extends Error {}

export interface BoxSecretsApplyRequest {
  readonly env: Record<string, string>;
  readonly replace: true;
}

export interface BoxSecretsApplierOptions {
  readonly applyToBox: (context: Context, update: BoxSecretsApplyRequest) => Promise<void>;
  readonly validateSecrets?: (secrets: Readonly<Record<string, string>>) => string | null;
  readonly encodeEnvironment?: (secrets: Readonly<Record<string, string>>) => Record<string, string>;
  readonly retryPolicy: RetryPolicy;
  readonly applyDeadline: DeadlinePolicy;
  readonly storePath?: string;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
}

export interface BoxSecretsStatus {
  readonly keys: string[];
  readonly isApplied: boolean;
  readonly lastAppliedAtMs: number | null;
}
