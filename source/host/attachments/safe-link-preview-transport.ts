import { request } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { createDeadlinePolicy, realClock } from "../extensions/scheduling.ts";
import { LINK_PREVIEW_USER_AGENT, type LinkPreviewFetchOptions, type RawLinkPreviewResponse } from "./safe-link-preview-contracts.ts";
import { getSafeLinkPreviewConnectionTarget } from "./safe-link-preview-target.ts";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const LINK_PREVIEW_REQUEST_DEADLINE = createDeadlinePolicy(realClock, { name: "link-preview-request", timeoutMs: 8_000 });

export function isLinkPreviewRedirect(statusCode: number): boolean {
  return REDIRECT_STATUSES.has(statusCode);
}

export function firstLinkPreviewHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Perform one bounded GET after resolving and pinning a public address. */
export async function fetchLinkPreviewOnce(url: URL, options: LinkPreviewFetchOptions): Promise<RawLinkPreviewResponse> {
  const target = await getSafeLinkPreviewConnectionTarget(url);
  const truncateAtByteLimit = options.truncateAtByteLimit ?? false;
  return await LINK_PREVIEW_REQUEST_DEADLINE.run((signal) => new Promise<RawLinkPreviewResponse>((resolve, reject) => {
    let settled = false;
    let removeAbortListener = () => {};
    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      complete();
    };
    const succeed = (result: RawLinkPreviewResponse): void => settle(() => resolve(result));
    const fail = (error: unknown): void => settle(() => reject(error));

    const req = request({
      method: "GET",
      host: target.connectHost,
      path: `${url.pathname}${url.search}`,
      port: 443,
      servername: target.servername,
      headers: {
        accept: options.accept,
        "accept-encoding": "identity",
        connection: "close",
        host: target.hostHeader,
        "user-agent": LINK_PREVIEW_USER_AGENT,
      },
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      const rawResult = (body: Buffer): RawLinkPreviewResponse => ({ statusCode, headers: response.headers, body });
      if (isLinkPreviewRedirect(statusCode)) {
        response.destroy();
        succeed(rawResult(Buffer.alloc(0)));
        return;
      }

      const declaredBytes = Number.parseInt(firstLinkPreviewHeaderValue(response.headers["content-length"]) ?? "", 10);
      const declaredBodyTooLarge = Number.isFinite(declaredBytes) && declaredBytes > options.maxBytes;
      if (!truncateAtByteLimit && declaredBodyTooLarge) {
        response.destroy();
        fail(new Error("Link preview response exceeded its byte limit."));
        return;
      }

      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      const stop = (): void => { response.destroy(); req.destroy(); };
      const succeedWithBody = (): void => succeed(rawResult(Buffer.concat(chunks)));
      response.on("data", (chunk: Buffer | string) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        const remainingBytes = options.maxBytes - receivedBytes;
        const exceedsLimit = bytes.byteLength > remainingBytes;
        if (exceedsLimit) {
          if (!truncateAtByteLimit) {
            stop();
            fail(new Error("Link preview response exceeded its byte limit."));
            return;
          }
          if (remainingBytes > 0) chunks.push(bytes.subarray(0, remainingBytes));
          stop();
          succeedWithBody();
          return;
        }

        chunks.push(bytes);
        receivedBytes += bytes.byteLength;
        if (truncateAtByteLimit && receivedBytes === options.maxBytes) {
          stop();
          succeedWithBody();
        }
      });
      response.on("end", succeedWithBody);
      response.on("error", fail);
    });

    const abort = (): void => { req.destroy(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", abort);
    req.on("error", fail);
    req.end();
  }));
}
