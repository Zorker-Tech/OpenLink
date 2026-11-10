import { clampBlock, clampLine } from "../../../shared/slate-text.ts";

export const SECRET_REQUEST_MAX_LABEL_LENGTH = 120;
export const SECRET_REQUEST_MAX_DESCRIPTION_LENGTH = 400;

export function clampSecretLabel(label: string): string {
  return clampLine(label, SECRET_REQUEST_MAX_LABEL_LENGTH);
}

export function clampSecretDescription(description: string): string {
  return clampBlock(description, SECRET_REQUEST_MAX_DESCRIPTION_LENGTH);
}

export function summarizeSecretRequest(request: { label: string }): string {
  return `Secure secret input requested: ${request.label}`;
}

function secretDeliveryNotice(label: string, destination: string): string {
  return `[${label} was supplied through the secure input and saved directly to ${destination}; the value is not available here and was not added to the conversation.]`;
}

function continuationNotice(): string {
  return "Tell the user it is set and continue. For connector credentials, wait briefly for the connection to appear, then check its status.";
}

export function buildSecretProvidedAck(request: {
  label: string
  target: { kind: string }
}): string {
  return [
    secretDeliveryNotice(request.label, request.target.kind),
    continuationNotice(),
  ].join("\n");
}
