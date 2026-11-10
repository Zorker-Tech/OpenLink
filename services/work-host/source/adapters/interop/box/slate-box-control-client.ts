/** Calls the box daemon's Slate-native control endpoints. */
import type { Context } from "../../../packages/context/context.ts";
import {
  SLATE_BOX_CONTROL_PATHS,
  SLATE_BOX_CONTROL_PROTOCOL_HEADER,
  SLATE_BOX_CONTROL_PROTOCOL_VERSION,
  parseBoxEnvironmentUpdateResult,
  parseBoxMcpLoadResult,
  parseBoxPingResult,
  type BoxMcpLoadResult,
} from "../../../shared/box-control-protocol.ts";

export interface SlateBoxHeaderWriter {
  set(name: string, value: string): void;
}

export interface SlateBoxRequestWithHeaders {
  readonly header: SlateBoxHeaderWriter;
}

export interface SlateBoxControlTarget<Request extends SlateBoxRequestWithHeaders> {
  readonly baseUrl: string;
  readonly interceptors: readonly (<Reply>(step: (request: Request) => Promise<Reply>) => (request: Request) => Promise<Reply>)[];
}

export async function applySlateBoxInterceptors<Request extends SlateBoxRequestWithHeaders>(
  target: SlateBoxControlTarget<Request>,
): Promise<Record<string, string>> {
  const values = new Map<string, string>();
  const request = {
    header: {
      set(name: string, value: string) { values.set(name.toLowerCase(), value); },
    },
  } as Request;
  let step = async (incoming: Request): Promise<Request> => incoming;
  for (const interceptor of [...target.interceptors].reverse()) step = interceptor(step);
  await step(request);
  return Object.fromEntries(values);
}

async function postJson(
  target: { readonly baseUrl: string },
  path: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<unknown> {
  const response = await fetcher(new URL(path, target.baseUrl), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      [SLATE_BOX_CONTROL_PROTOCOL_HEADER]: String(SLATE_BOX_CONTROL_PROTOCOL_VERSION),
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    const failure = new Error(`box control ${path} failed with HTTP ${response.status}${text.length === 0 ? "" : `: ${text}`}`) as Error & { code: string };
    failure.code = `http_${response.status}`;
    throw failure;
  }
  if (response.headers.get(SLATE_BOX_CONTROL_PROTOCOL_HEADER) !== String(SLATE_BOX_CONTROL_PROTOCOL_VERSION)) {
    throw new TypeError(`box control ${path} returned an unsupported protocol version`);
  }
  return await response.json();
}

function requestSignal(context: Context, timeoutMs: number): AbortSignal {
  return AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]);
}

export class SlateBoxControlClient<Request extends SlateBoxRequestWithHeaders> {
  constructor(
    private readonly target: SlateBoxControlTarget<Request>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async ping(context: Context, _request: Readonly<Record<string, never>>, options: { readonly timeoutMs: number }): Promise<unknown> {
    const headers = await applySlateBoxInterceptors(this.target);
    const response = await postJson(
      this.target,
      SLATE_BOX_CONTROL_PATHS.ping,
      headers,
      {},
      requestSignal(context, options.timeoutMs),
      this.fetcher,
    );
    return parseBoxPingResult(response);
  }

  async updateEnvironmentVariables(
    context: Context,
    request: { readonly env: Readonly<Record<string, string>>; readonly replace: boolean },
  ): Promise<unknown> {
    const headers = await applySlateBoxInterceptors(this.target);
    const response = await postJson(
      this.target,
      SLATE_BOX_CONTROL_PATHS.environment,
      headers,
      { env: request.env, replace: request.replace },
      requestSignal(context, 10_000),
      this.fetcher,
    );
    return parseBoxEnvironmentUpdateResult(response);
  }

  async loadMcpServers(
    context: Context,
    request: { readonly mcpConfigJson?: string },
  ): Promise<BoxMcpLoadResult> {
    const headers = await applySlateBoxInterceptors(this.target);
    const response = await postJson(
      this.target,
      SLATE_BOX_CONTROL_PATHS.mcp,
      headers,
      { configurationJson: request.mcpConfigJson ?? "{}" },
      requestSignal(context, 10_000),
      this.fetcher,
    );
    return parseBoxMcpLoadResult(response);
  }
}

/** Replace the global fetch only in tests while retaining the environment interceptor contract. */
export function createSlateBoxControlClient<Request extends SlateBoxRequestWithHeaders>(
  target: SlateBoxControlTarget<Request>,
  fetcher: typeof fetch = fetch,
): SlateBoxControlClient<Request> {
  return new SlateBoxControlClient(target, fetcher);
}
