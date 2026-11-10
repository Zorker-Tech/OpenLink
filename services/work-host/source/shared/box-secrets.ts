/** Public Slate box-secret policy surface. Runtime encoding stays behind the interop adapter. */

export {
  SLATE_BOX_SECRET_NAMES_ENV,
  MAX_BOX_SECRET_COUNT,
  MAX_BOX_SECRET_VALUE_LENGTH,
  MAX_BOX_SECRETS_TOTAL_LENGTH,
  RESERVED_BOX_SECRET_PREFIXES,
  RESERVED_EXACT_BOX_SECRET_NAMES,
  buildSlateBoxSecretsEnv,
} from "./box-secret-policy.ts"
export { validateBoxSecretKey, validateBoxSecrets } from "./box-secret-validation.ts"
