import { VIDEO_MIME_FROM_EXTENSION, extensionOf } from "./media-extensions.ts";

export const ATTACHMENT_BYTE_LIMIT = 25 * 1024 * 1024;
export const VIDEO_BYTE_LIMIT = 200 * 1024 * 1024;
export const BYTES_PER_MB = 1024 * 1024;

interface AttachmentPolicy {
  readonly byteLimit: number;
  readonly description: "" | " for video";
}

const STANDARD_POLICY: AttachmentPolicy = {
  byteLimit: ATTACHMENT_BYTE_LIMIT,
  description: "",
};

const VIDEO_POLICY: AttachmentPolicy = {
  byteLimit: VIDEO_BYTE_LIMIT,
  description: " for video",
};

function policyForName(name: string): AttachmentPolicy {
  return nameLooksLikeVideo(name) ? VIDEO_POLICY : STANDARD_POLICY;
}

export function nameLooksLikeVideo(name: string): boolean {
  const extension = extensionOf(name);
  return VIDEO_MIME_FROM_EXTENSION[extension] !== undefined;
}

export function attachmentByteLimitForName(name: string): number {
  return policyForName(name).byteLimit;
}

export function formatMegabytes(bytes: number): string {
  const wholeMegabytes = Math.round(bytes / BYTES_PER_MB);
  return `${wholeMegabytes} MB`;
}

export function formatAttachmentTooLargeNotice(filename: string): string {
  const policy = policyForName(filename);
  const sizeLimit = formatMegabytes(policy.byteLimit);
  return `"${filename}" is too large to attach (max ${sizeLimit}${policy.description}).`;
}

export class AttachmentTooLargeError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`Attachment exceeds ${limitBytes} bytes.`);
    this.name = "AttachmentTooLargeError";
    this.limitBytes = limitBytes;
  }
}
