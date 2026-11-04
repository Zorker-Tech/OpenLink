/** Streams Slate-native box execution responses over NDJSON. */
import type { Context } from "../../../packages/context/context.ts";
import {
  SLATE_BOX_EXEC_PATH,
  SLATE_BOX_EXEC_PROTOCOL_HEADER,
  SLATE_BOX_EXEC_PROTOCOL_VERSION,
  parseBoxExecResponse,
  type BoxExecRequest,
  type BoxExecResponse,
} from "../../../shared/box-exec-protocol.ts";
import {
  applySlateBoxInterceptors,
  type SlateBoxControlTarget,
  type SlateBoxRequestWithHeaders,
} from "./slate-box-control-client.ts";

export class SlateBoxExecClient<Request extends SlateBoxRequestWithHeaders> {
  constructor(
    private readonly target: SlateBoxControlTarget<Request>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async *exec(context: Context, request: BoxExecRequest): AsyncIterable<BoxExecResponse> {
    const headers = await applySlateBoxInterceptors(this.target);
    const response = await this.fetcher(new URL(SLATE_BOX_EXEC_PATH, this.target.baseUrl), {
      method: "POST",
      headers: {
        accept: "application/x-ndjson",
        "content-type": "application/json",
        [SLATE_BOX_EXEC_PROTOCOL_HEADER]: String(SLATE_BOX_EXEC_PROTOCOL_VERSION),
        ...headers,
      },
      body: JSON.stringify(request),
      signal: context.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      const failure = new Error(`box exec failed with HTTP ${response.status}${text.length === 0 ? "" : `: ${text}`}`) as Error & { code: string };
      failure.code = `http_${response.status}`;
      throw failure;
    }
    if (response.headers.get(SLATE_BOX_EXEC_PROTOCOL_HEADER) !== String(SLATE_BOX_EXEC_PROTOCOL_VERSION)) {
      throw new TypeError("box exec returned an unsupported protocol version");
    }
    if (response.body === null) throw new TypeError("box exec returned no response stream");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim().length > 0) yield parseBoxExecResponse(JSON.parse(line));
        newline = buffered.indexOf("\n");
      }
      if (done) break;
    }
    if (buffered.trim().length > 0) yield parseBoxExecResponse(JSON.parse(buffered));
  }
}

export function createSlateBoxExecClient<Request extends SlateBoxRequestWithHeaders>(
  target: SlateBoxControlTarget<Request>,
  fetcher: typeof fetch = fetch,
): SlateBoxExecClient<Request> {
  return new SlateBoxExecClient(target, fetcher);
}
