/**
 * How to reach a box's desktop.
 *
 * A box exposes a browser view over noVNC, and the URL carries everything the viewer needs: the
 * network token that authorizes the connection and a websockify path with the resume window, so a
 * viewer that reconnects after an idle pause is resumed rather than restarted.
 */

export const BOX_IMAGE_TAG_PREFIX = "slate-box-"
export const BOX_IMAGE_TAG_LATEST = `${BOX_IMAGE_TAG_PREFIX}latest`
export const SHORT_GIT_SHA_REGEX = /^[0-9a-f]{7,40}$/

export const BOX_PRIMARY_NOVNC_PORT = 6080
export const BOX_FORK_NOVNC_PORT = 6081
export const BOX_SPECIAL_TREATMENT_NOVNC_PATH = "slate-special-treatment-v1/vnc.html"

/** The resume window a viewer advertises: reconnect quickly and cheaply, or resume a long pause. */
const RESUME_WINDOW = "resume_lower_s=900&resume_upper_s=18000"

export function buildBoxNoVncUrl(
  proxyBaseUrl: string,
  networkToken: string,
  token?: string,
  specialTreatment = false,
): string {
  const tokenParam = token === undefined ? "" : `token=${token}&`
  const websockifyPath = `websockify?${tokenParam}network_token=${networkToken}&${RESUME_WINDOW}`
  const viewerPath = specialTreatment ? BOX_SPECIAL_TREATMENT_NOVNC_PATH : "vnc.html"
  return `${proxyBaseUrl}/${viewerPath}?network_token=${networkToken}&${RESUME_WINDOW}&path=${encodeURIComponent(websockifyPath)}`
}

export function isBoxSpecialTreatmentNoVncUrl(value: string): boolean {
  try {
    return new URL(value).pathname.endsWith(`/${BOX_SPECIAL_TREATMENT_NOVNC_PATH}`)
  } catch {
    return false
  }
}
