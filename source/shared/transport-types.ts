/** The protocols an attachment may be read from: a file on this machine, and the web. */
const ATTACHMENT_PROTOCOLS: ReadonlySet<string> = new Set(["file:", "https:"]);

/** Whether a URL names a place an attachment may be read from. */
export function isValidAttachmentUrl(rawUrl: string): boolean {
  try {
    return ATTACHMENT_PROTOCOLS.has(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}
