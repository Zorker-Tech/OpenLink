/**
 * A marketplace plugin's logo, as a picture the platform can draw.
 *
 * A logo is fetched once and kept — either the picture as a data URL or nothing at all — and only for a logo the
 * platform has actually seen on a marketplace listing: a url it has never seen, one that is not a url, and one that
 * is not https are all answered as nothing without asking anyone. What was fetched is remembered, including a failure,
 * so a logo that could not be had is not fetched again on every render. Fetches are bounded: a handful run at once,
 * each under the marketplace's own deadline, and the rest wait their turn.
 */

import { createDeadlinePolicy, realClock, type DeadlinePolicy } from "../../../host/extensions/scheduling.ts";
import { responseToImageDataUrl } from "../http-image.ts";
import { CURSOR_MARKETPLACE_REQUEST_TIMEOUT_MS } from "../marketplace/cursor-marketplace-client.ts";
import { isKnownPluginLogoUrl } from "../marketplace/cursor-marketplace-logo-registry.ts";

export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_FETCH_CONCURRENCY = 6;

/** What has already been answered for a logo: the picture, or nothing when there is none to show. */
const logoCache = new Map<string, string | null>();
let activeFetches = 0;
const waiting: Array<() => void> = [];

const defaultDeadline = createDeadlinePolicy(realClock, { name: "mcp-marketplace-logo-fetch", timeoutMs: CURSOR_MARKETPLACE_REQUEST_TIMEOUT_MS });

export interface PluginLogoDependencies {
  isKnownPluginLogoUrl(url: string): boolean;
  fetch(url: string, signal: AbortSignal): Promise<Response>;
  responseToImageDataUrl(response: Response, maxBytes: number): Promise<string | null>;
  timeoutMs: number;
  deadline?: DeadlinePolicy;
}

const defaultLogoDependencies: PluginLogoDependencies = {
  isKnownPluginLogoUrl,
  fetch: (url, signal) => fetch(url, { signal }),
  responseToImageDataUrl,
  timeoutMs: CURSOR_MARKETPLACE_REQUEST_TIMEOUT_MS,
  deadline: defaultDeadline,
};

/** Runs one fetch within the bound: a fetch over it waits for a slot, and every fetch gives its slot back. */
export async function withLogoFetchSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeFetches >= LOGO_FETCH_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
  activeFetches += 1;
  try {
    return await run();
  } finally {
    activeFetches -= 1;
    waiting.shift()?.();
  }
}

/** The picture for a logo url, or nothing — asked for once per url, however often a render asks. */
export async function resolvePluginLogo(url: string, deps: PluginLogoDependencies = defaultLogoDependencies): Promise<string | null> {
  if (logoCache.has(url)) return logoCache.get(url) ?? null;
  // A logo nobody has shown us is not one to go and fetch.
  if (!deps.isKnownPluginLogoUrl(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    logoCache.set(url, null);
    return null;
  }
  if (parsed.protocol !== "https:") {
    logoCache.set(url, null);
    return null;
  }
  try {
    const deadline = deps.deadline ?? createDeadlinePolicy(realClock, { name: "mcp-marketplace-logo-fetch", timeoutMs: deps.timeoutMs });
    const picture = await withLogoFetchSlot(async () =>
      deadline.run(async (signal) => deps.responseToImageDataUrl(await deps.fetch(parsed.toString(), signal), LOGO_MAX_BYTES)),
    );
    logoCache.set(url, picture);
    return picture;
  } catch {
    // A logo that could not be fetched is a logo this platform does not have — said once, not on every render.
    logoCache.set(url, null);
    return null;
  }
}
