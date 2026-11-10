/**
 * A plugin's logo as the platform resolves it: what it refuses to fetch, what it fetches once, and how many fetches
 * it lets run at the same time.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LOGO_FETCH_CONCURRENCY, LOGO_MAX_BYTES, resolvePluginLogo, withLogoFetchSlot, type PluginLogoDependencies } from "../../source/shared/node/mcp/mcp-marketplace-logo.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function logoWorld(options: { known?: boolean; fetchFails?: boolean; picture?: string | null; fetchDelay?: () => Promise<void> } = {}) {
  const fetched: string[] = [];
  const converted: number[] = [];
  const signals: AbortSignal[] = [];
  const deps: PluginLogoDependencies = {
    isKnownPluginLogoUrl: () => options.known ?? true,
    fetch: async (url, signal) => {
      fetched.push(url);
      signals.push(signal);
      await options.fetchDelay?.();
      if (options.fetchFails === true) throw new Error("the logo host is down");
      return {} as Response;
    },
    responseToImageDataUrl: async (_response, maxBytes) => {
      converted.push(maxBytes);
      return options.picture === undefined ? "data:image/png;base64,AAAA" : options.picture;
    },
    timeoutMs: 12_345,
  };
  return { deps, fetched, converted, signals };
}

describe("resolving a plugin's logo", () => {
  it("fetches a known https logo once, under the marketplace's own limits, and remembers it", async () => {
    const world = logoWorld();
    const url = "https://logo.test/once.png";
    const first = await resolvePluginLogo(url, world.deps);
    assert.equal(first, "data:image/png;base64,AAAA");
    assert.deepEqual(world.fetched, [url]);
    assert.equal(world.signals[0]!.aborted, false);
    // The picture is remembered: a second render does not ask the host again.
    assert.equal(await resolvePluginLogo(url, world.deps), first);
    assert.deepEqual(world.fetched, [url]);
    assert.deepEqual(world.converted, [LOGO_MAX_BYTES]);
  });

  it("answers nothing without fetching for a url nobody showed us, for a url that is not one, and for plain http", async () => {
    const unknown = logoWorld({ known: false });
    assert.equal(await resolvePluginLogo("https://logo.test/unknown.png", unknown.deps), null);
    const notAUrl = logoWorld();
    assert.equal(await resolvePluginLogo("not a url", notAUrl.deps), null);
    const insecure = logoWorld();
    assert.equal(await resolvePluginLogo("http://logo.test/plain.png", insecure.deps), null);
    assert.deepEqual([unknown.fetched.length, notAUrl.fetched.length, insecure.fetched.length], [0, 0, 0]);
    // A logo that was not known is not remembered as missing: once it is known, it is fetched.
    const later = logoWorld({ known: false });
    assert.equal(await resolvePluginLogo("https://logo.test/later.png", later.deps), null);
    assert.equal(await resolvePluginLogo("https://logo.test/later.png", { ...later.deps, isKnownPluginLogoUrl: () => true }), "data:image/png;base64,AAAA");
    assert.deepEqual(later.fetched, ["https://logo.test/later.png"]);
  });

  it("answers nothing for a fetch that failed or a picture that could not be read, and does not ask again", async () => {
    const failing = logoWorld({ fetchFails: true });
    assert.equal(await resolvePluginLogo("https://logo.test/failing.png", failing.deps), null);
    assert.equal(await resolvePluginLogo("https://logo.test/failing.png", failing.deps), null);
    assert.equal(failing.fetched.length, 1);
    const unreadable = logoWorld({ picture: null });
    assert.equal(await resolvePluginLogo("https://logo.test/unreadable.png", unreadable.deps), null);
    assert.equal(unreadable.fetched.length, 1);
  });

  it("runs no more fetches at once than the bound allows", async () => {
    const gates: (() => void)[] = [];
    const started: number[] = [];
    const hold = () => new Promise<void>((resolve) => gates.push(resolve));
    const runs = Array.from({ length: LOGO_FETCH_CONCURRENCY + 1 }, (_unused, index) =>
      withLogoFetchSlot(async () => {
        started.push(index);
        if (index < LOGO_FETCH_CONCURRENCY) await hold();
        return index;
      }),
    );
    await tick();
    // The first slots start; the one over the bound waits, even though six are already running.
    assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
    gates.shift()?.();
    await tick();
    assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6]);
    while (gates.length > 0) gates.shift()?.();
    assert.deepEqual((await Promise.all(runs)).length, LOGO_FETCH_CONCURRENCY + 1);
    // A slot is given back even when what ran threw.
    const failing = withLogoFetchSlot(async () => {
      throw new Error("no");
    });
    await failing.catch(() => "refused");
    await Promise.all(Array.from({ length: LOGO_FETCH_CONCURRENCY }, () => withLogoFetchSlot(async () => "ok")));
  });
});
