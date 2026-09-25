/** Whether a URL is one an attachment may be read from: a file on this machine, or an https address. */
export function isValidAttachmentUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "file:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
