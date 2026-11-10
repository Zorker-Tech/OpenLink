import type { SlateSentryEnvelope } from "./sentry-contracts.ts";
import type { SlateSentryPrivacyGate } from "./sentry-envelope-policy.ts";

type SendResult = Promise<unknown>;
type EnvelopeSend = (envelope: SlateSentryEnvelope) => SendResult;
type AcceptedEnvelope = (envelope: SlateSentryEnvelope) => void;

/** Keep the send path behind one privacy projection and account-ownership decision. */
export function gateEnvelopeSend(
  gate: SlateSentryPrivacyGate,
  send: EnvelopeSend,
  onAccepted?: AcceptedEnvelope,
): EnvelopeSend {
  return (envelope) => {
    const projected = gate.handle(envelope);
    if (projected === undefined) return Promise.resolve({});
    if (onAccepted !== undefined && gate.belongsToCurrentAccount(envelope)) onAccepted(projected);
    return send(projected);
  };
}

/** Preserve a transport's other properties while replacing only its envelope sender. */
export function gateTransport<T extends { send(envelope: SlateSentryEnvelope): SendResult }>(
  gate: SlateSentryPrivacyGate,
  transport: T,
  onAccepted?: AcceptedEnvelope,
): T {
  const send = gateEnvelopeSend(gate, (envelope) => transport.send(envelope), onAccepted);
  return { ...transport, send };
}
