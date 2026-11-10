import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "./privacy-mode.ts";
import type { DataClassification } from "./classification.ts";

export interface PrivacyContext {
  readonly privacyMode: PrivacyModeValue;
  readonly enforceRedaction?: boolean | undefined;
}

/** Installed by the process that owns the redaction policy. */
let readProcessPolicy: (() => boolean | undefined) | undefined;

export function setRedactionEnforcementGate(gate: () => boolean | undefined): void {
  readProcessPolicy = gate;
}

function processDecision(context: PrivacyContext): boolean {
  if (context.privacyMode === PrivacyMode.UNSPECIFIED) return false;
  return readProcessPolicy?.() === true;
}

/** Explicit context choices win; otherwise a specified mode can consult the process policy. */
export function resolveEnforceRedaction(
  context: PrivacyContext,
  _classification: DataClassification,
): boolean {
  if (context.enforceRedaction !== undefined) return context.enforceRedaction;
  return processDecision(context);
}

export function privacyContextFromMode(
  privacyMode: PrivacyModeValue,
  enforceRedaction?: boolean,
): PrivacyContext {
  const context: PrivacyContext = { privacyMode };
  return enforceRedaction === undefined ? context : { ...context, enforceRedaction };
}

function isPrivacyContext(value: unknown): value is PrivacyContext {
  return typeof value === "object" && value !== null && "privacyMode" in value;
}

/** Accept either the bare mode or the context carrying its explicit enforcement choice. */
export function toPrivacyContext(modeOrContext: PrivacyModeValue | PrivacyContext): PrivacyContext {
  if (isPrivacyContext(modeOrContext)) return modeOrContext;
  return privacyContextFromMode(modeOrContext);
}
