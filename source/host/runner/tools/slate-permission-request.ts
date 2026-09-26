/** What a permission request from an older version is summarized as, now that it can no longer be acted on. */
export function summarizePermissionRequest(request: {
  readonly title: string;
  readonly reason: string;
}): string {
  return `Legacy permission request (no longer actionable): ${request.title} \u2014 ${request.reason}`;
}
