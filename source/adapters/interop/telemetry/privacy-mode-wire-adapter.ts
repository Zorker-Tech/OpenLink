import { PrivacyMode as CounterpartPrivacyMode } from "../proto/generated/aiserver/v1/privacy_mode_pb.ts";
import { PrivacyMode as SlatePrivacyMode, type PrivacyMode } from "../../../packages/redaction/privacy-mode.ts";

const FROM_COUNTERPART = new Map<number, PrivacyMode>([
  [CounterpartPrivacyMode.UNSPECIFIED, SlatePrivacyMode.UNSPECIFIED],
  [CounterpartPrivacyMode.NO_STORAGE, SlatePrivacyMode.NO_STORAGE],
  [CounterpartPrivacyMode.NO_TRAINING, SlatePrivacyMode.NO_TRAINING],
  [CounterpartPrivacyMode.USAGE_DATA_TRAINING_ALLOWED, SlatePrivacyMode.USAGE_DATA_TRAINING_ALLOWED],
  [CounterpartPrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED, SlatePrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED],
]);

const TO_COUNTERPART = new Map<PrivacyMode, CounterpartPrivacyMode>([
  [SlatePrivacyMode.UNSPECIFIED, CounterpartPrivacyMode.UNSPECIFIED],
  [SlatePrivacyMode.NO_STORAGE, CounterpartPrivacyMode.NO_STORAGE],
  [SlatePrivacyMode.NO_TRAINING, CounterpartPrivacyMode.NO_TRAINING],
  [SlatePrivacyMode.USAGE_DATA_TRAINING_ALLOWED, CounterpartPrivacyMode.USAGE_DATA_TRAINING_ALLOWED],
  [SlatePrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED, CounterpartPrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED],
]);

export function privacyModeFromWire(value: number): PrivacyMode {
  return FROM_COUNTERPART.get(value) ?? SlatePrivacyMode.UNSPECIFIED;
}

export function privacyModeToWire(value: PrivacyMode): CounterpartPrivacyMode {
  return TO_COUNTERPART.get(value) ?? CounterpartPrivacyMode.UNSPECIFIED;
}
