/**
 * Fetching through the proxy the machine is configured with.
 *
 * The proxy comes from the environment, and one agent is kept for the whole process; a proxy that cannot be set up is
 * left out and the request goes out without one rather than failing here.
 */
import { ProxyAgent, fetch as undiciFetch } from "undici";

/** The proxy URL the machine names, if it names a usable one. */
function configuredProxyUrl(): string | undefined {
  return process.env.HTTPS_PROXY || process.env.https_proxy || undefined;
}

/** The agent every request goes through, or undefined when the machine names no usable proxy. */
function createProxyAgent(url: string | undefined): ProxyAgent | undefined {
  if (url === undefined || url.length === 0) return undefined;
  try {
    return new ProxyAgent(url);
  } catch {
    return undefined;
  }
}

const proxyAgent = createProxyAgent(configuredProxyUrl());

/** The options a request is made with: the caller's, plus the proxy agent when there is one. */
function requestOptions(options: RequestInit | undefined): Parameters<typeof undiciFetch>[1] {
  if (proxyAgent === undefined) return options as Parameters<typeof undiciFetch>[1];
  return { ...options, dispatcher: proxyAgent } as unknown as Parameters<typeof undiciFetch>[1];
}

/** Fetch as undici does, but through the machine's proxy when it has one. */
export function proxyFetch(url: string | URL, options?: RequestInit): Promise<Response> {
  return undiciFetch(url, requestOptions(options)) as unknown as Promise<Response>;
}
