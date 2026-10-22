/**
 * Whether this build can sign a WebAuthn assertion through the platform's proxy.
 *
 * The signer ships with the desktop on the platforms it is built for, so the proxy is only mirrored as enabled where
 * the signer exists; anywhere else the browser's own WebAuthn is what a user gets.
 */

/** The platforms the desktop's signer is built for. */
export const SLATE_WEBAUTHN_SIGNER_PLATFORMS = ["darwin", "win32"] as const;

/** The same platforms as a set, for the question below. */
const SIGNER_PLATFORMS: ReadonlySet<string> = new Set(SLATE_WEBAUTHN_SIGNER_PLATFORMS);

/** Whether the signer ships with the desktop on this platform. */
export const slateWebauthnSignerShips = (platform: NodeJS.Platform): boolean => SIGNER_PLATFORMS.has(platform);

/** The enablement the browser is told about: it is only mirrored where the signer exists. */
export const slateWebauthnProxyMirroredEnablement = (enabled: boolean, platform: NodeJS.Platform): boolean =>
  enabled && slateWebauthnSignerShips(platform);
