/**
 * The failure a gateway command reports when the gateway itself refuses it.
 *
 * The command's own outcome is carried by the reply, so this error exists for the cases where there is no
 * reply: the command was not recognised, the caller was not authorised, or the gateway could not be
 * reached. It carries nothing beyond the message, since the reason is what the caller acts on.
 */

const GatewayCommandErrorType = class SlateGatewayCommandError extends Error {};

export const SlateGatewayCommandError = GatewayCommandErrorType;
export type SlateGatewayCommandError = InstanceType<typeof GatewayCommandErrorType>;
