/**
 * Whether this build can sign a WebAuthn assertion through the platform's proxy.
 *
 * The signer ships with the desktop on the platforms it is built for, so the proxy is only mirrored as enabled where
 * the signer exists; anywhere else the browser's own WebAuthn is what a user gets.
 */
export const SLATE_WEBAUTHN_SIGNER_PLATFORMS = ["darwin", "win32"] as const;

export function slateWebauthnSignerShips(platform: NodeJS.Platform): boolean {
  return (SLATE_WEBAUTHN_SIGNER_PLATFORMS as readonly string[]).includes(platform);
}

export function slateWebauthnProxyMirroredEnablement(enabled: boolean, platform: NodeJS.Platform): boolean {
  return enabled && slateWebauthnSignerShips(platform);
}

