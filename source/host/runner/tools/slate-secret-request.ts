/**
 * Asking the user for a secret, and acknowledging one that was provided.
 *
 * What the user is asked for is bounded — a label on one line, a description as a block — and the acknowledgement says
 * that the value went straight to its destination and is not in the conversation, so the agent neither repeats it nor
 * waits for it.
 */
import{clampBlock,clampLine}from"../../../shared/slate-text.ts";export const SECRET_REQUEST_MAX_LABEL_LENGTH=120,SECRET_REQUEST_MAX_DESCRIPTION_LENGTH=400;
export const clampSecretLabel=(v:string):string=>clampLine(v,120);export const clampSecretDescription=(v:string):string=>clampBlock(v,400);
export const summarizeSecretRequest=(r:{label:string}):string=>`Requested a secret from the user securely: ${r.label}`;
export function buildSecretProvidedAck(r:{label:string;target:{kind:string}}):string{return[`[The user securely provided the requested secret: "${r.label}". It was written straight to its destination (${r.target.kind}); you never see the value and it is not in this conversation.]`,"Confirm to the user that it is set, then continue. For a connector credential, the connection links within a few seconds, so you can check and report its status."].join("\n")}

