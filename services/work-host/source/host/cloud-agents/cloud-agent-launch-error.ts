/**
 * The failure of launching a cloud agent.
 *
 * The launch crosses a service boundary, so a failure can come from the request, from the service, or from
 * the box that was meant to be created. The message is what the caller shows and what it retries on.
 */

const CloudAgentLaunchErrorType = class SlateCloudAgentLaunchError extends Error {};

export const SlateCloudAgentLaunchError = CloudAgentLaunchErrorType;
export type SlateCloudAgentLaunchError = InstanceType<typeof CloudAgentLaunchErrorType>;
