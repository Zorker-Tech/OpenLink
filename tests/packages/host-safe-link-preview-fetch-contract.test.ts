import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { after, before, mock, test } from "node:test";
import type { IncomingHttpHeaders } from "node:http";

interface ResponseFixture {
  readonly statusCode?: number;
  readonly headers?: IncomingHttpHeaders;
  readonly chunks?: readonly (Buffer | string)[];
  readonly error?: Error;
}

class FakeResponse extends EventEmitter {
  destroyed = false;
  constructor(readonly statusCode: number, readonly headers: IncomingHttpHeaders) { super(); }
  destroy(): void { this.destroyed = true; }
}

class FakeRequest extends EventEmitter {
  destroyed = false;
  constructor(
    private readonly respond: (response: FakeResponse) => void,
    private readonly fixture: ResponseFixture,
  ) { super(); }

  end(): void {
    if (this.fixture.error !== undefined) {
      this.emit("error", this.fixture.error);
      return;
    }
    const response = new FakeResponse(this.fixture.statusCode ?? 200, this.fixture.headers ?? {});
    this.respond(response);
    for (const chunk of this.fixture.chunks ?? []) response.emit("data", chunk);
    response.emit("end");
  }

  destroy(): void { this.destroyed = true; }
}

let api: typeof import("../../source/host/attachments/safe-link-preview-fetch.ts");
const responses: ResponseFixture[] = [];
const requestOptions: Array<Record<string, unknown>> = [];

function fakeRequest(options: unknown, callback: (response: FakeResponse) => void): FakeRequest {
  requestOptions.push(options as Record<string, unknown>);
  return new FakeRequest(callback, responses.shift() ?? {});
}

function serveWith(...fixtures: ResponseFixture[]): void {
  responses.length = 0;
  requestOptions.length = 0;
  responses.push(...fixtures);
}

before(async () => {
  mock.method(https, "request", fakeRequest as never);
  syncBuiltinESMExports();
  api = await import("../../source/host/attachments/safe-link-preview-fetch.ts");
});

after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

test("normalizes host casing, trailing dots, and IPv6 brackets", () => {
  assert.equal(api.normalizeHostname("Example.COM."), "example.com");
  assert.equal(api.normalizeHostname("[2001:4860:4860::8888]"), "2001:4860:4860::8888");
  assert.equal(api.isBlockedHostname("localhost"), true);
  assert.equal(api.isBlockedHostname("oneword"), true);
  assert.equal(api.isBlockedHostname("preview.local"), true);
  assert.equal(api.isBlockedHostname("preview.internal"), true);
  assert.equal(api.isBlockedHostname("example.com"), false);
});

test("blocks private, reserved, and malformed IP addresses before connection", () => {
  for (const address of [
    "0.1.2.3", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1",
    "192.168.1.1", "198.18.0.1", "203.0.113.1", "224.0.0.1", "240.0.0.1",
    "::", "::1", "fc00::1", "fe80::1", "ff02::1", "not-an-ip",
  ]) assert.equal(api.isBlockedLinkPreviewIp(address), true, address);
  assert.equal(api.isBlockedLinkPreviewIp("93.184.216.34"), false);
  assert.equal(api.isBlockedLinkPreviewIp("2606:4700:4700::1111"), false);
});

test("accepts an HTTPS URL at the length limit and rejects one character beyond it", () => {
  const prefix = "https://example.com/";
  const exact = prefix + "x".repeat(api.MAX_URL_LENGTH - prefix.length);
  assert.equal(exact.length, api.MAX_URL_LENGTH);
  assert.equal(api.parseSafeLinkPreviewUrl(exact).protocol, "https:");
  assert.throws(() => api.parseSafeLinkPreviewUrl(exact + "x"), /too long/);
});

test("requires absolute HTTPS URLs without credentials or custom ports", () => {
  assert.throws(() => api.parseSafeLinkPreviewUrl("not a URL"), /absolute HTTPS/);
  assert.throws(() => api.parseSafeLinkPreviewUrl("http://example.com/"), /require HTTPS/);
  assert.throws(() => api.parseSafeLinkPreviewUrl("https://user:secret@example.com/"), /cannot contain credentials/);
  assert.throws(() => api.parseSafeLinkPreviewUrl("https://example.com:8443/"), /custom port/);
  assert.equal(api.parseSafeLinkPreviewUrl("https://example.com:443/").hostname, "example.com");
});

test("rejects non-public hostnames and IP literals", () => {
  for (const url of [
    "https://localhost/", "https://host.local/", "https://single-label/", "https://127.0.0.1/",
    "https://192.168.1.2/", "https://[fe80::1]/", "https://[fc00::1]/",
  ]) assert.throws(() => api.parseSafeLinkPreviewUrl(url), /non-public/);
  assert.equal(api.parseSafeLinkPreviewUrl("https://93.184.216.34/").hostname, "93.184.216.34");
});

test("pins DNS to a public answer, preferring IPv4 and preserving the TLS server name", async () => {
  let seenHostname = "";
  let seenOptions: unknown;
  const target = await api.getSafeLinkPreviewConnectionTarget(
    new URL("https://Preview.Example.com./path"),
    (async (hostname: string, options: unknown) => {
      seenHostname = hostname;
      seenOptions = options;
      return [
        { address: "2606:4700:4700::1111", family: 6 },
        { address: "93.184.216.34", family: 4 },
      ];
    }) as never,
  );

  assert.equal(seenHostname, "preview.example.com");
  assert.deepEqual(seenOptions, { all: true, verbatim: true });
  assert.deepEqual(target, { connectHost: "93.184.216.34", hostHeader: "preview.example.com", servername: "preview.example.com" });
});

test("rejects a DNS set if any answer is non-public and refuses an empty answer set", async () => {
  await assert.rejects(
    () => api.getSafeLinkPreviewConnectionTarget(new URL("https://preview.example.com/"), (async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]) as never),
    /resolves to a non-public address/,
  );
  await assert.rejects(
    () => api.getSafeLinkPreviewConnectionTarget(new URL("https://preview.example.com/"), (async () => []) as never),
    /did not resolve/,
  );
});

test("formats a pinned IPv6 address in the Host header and leaves the IP out of SNI", async () => {
  const target = await api.getSafeLinkPreviewConnectionTarget(
    new URL("https://[2606:4700:4700::1111]/"),
    async () => { throw new Error("IP literals must not use DNS"); },
  );
  assert.deepEqual(target, { connectHost: "2606:4700:4700::1111", hostHeader: "[2606:4700:4700::1111]" });
});

test("resolves relative redirects through the same HTTPS and hostname policy", () => {
  const current = new URL("https://example.com/a/b");
  assert.equal(api.resolveSafeLinkPreviewRedirect(current, "../next?x=1").toString(), "https://example.com/next?x=1");
  assert.throws(() => api.resolveSafeLinkPreviewRedirect(current, "http://example.com/"), /require HTTPS/);
  assert.throws(() => api.resolveSafeLinkPreviewRedirect(current, "https://127.0.0.1/"), /non-public/);
});

test("fetches through the pinned address with bounded headers and returns the final URL", async () => {
  serveWith({ statusCode: 200, headers: { "content-type": "text/html", "content-length": "4" }, chunks: [Buffer.from("page")] });
  const response = await api.fetchSafeLinkPreviewResource("https://93.184.216.34/article?q=1", {
    maxBytes: 20, accept: "text/html",
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.toString(), "page");
  assert.equal(response.finalUrl, "https://93.184.216.34/article?q=1");
  assert.deepEqual(response.redirectUrls, []);
  const options = requestOptions[0]!;
  assert.equal(options.host, "93.184.216.34");
  assert.equal(options.path, "/article?q=1");
  assert.equal(options.port, 443);
  assert.equal((options.headers as Record<string, string>)["user-agent"], "Slate-LinkPreview/1.0");
  assert.deepEqual(options.headers, {
    accept: "text/html", "accept-encoding": "identity", connection: "close",
    host: "93.184.216.34", "user-agent": api.LINK_PREVIEW_USER_AGENT,
  });
});

test("follows bounded relative redirects and stops at the redirect limit", async () => {
  serveWith(
    { statusCode: 302, headers: { location: "/next" } },
    { statusCode: 200, headers: {}, chunks: ["ok"] },
  );
  const result = await api.fetchSafeLinkPreviewResource("https://93.184.216.34/start", { maxBytes: 20, accept: "text/html" });
  assert.equal(result.finalUrl, "https://93.184.216.34/next");
  assert.deepEqual(result.redirectUrls, ["https://93.184.216.34/next"]);
  assert.equal(result.body.toString(), "ok");

  serveWith(...Array.from({ length: api.MAX_REDIRECTS + 1 }, (_, index) => ({
    statusCode: 302,
    headers: { location: `/step-${index + 1}` },
  })));
  await assert.rejects(
    () => api.fetchSafeLinkPreviewResource("https://93.184.216.34/start", { maxBytes: 20, accept: "text/html" }),
    /Too many redirects/,
  );
  assert.equal(requestOptions.length, api.MAX_REDIRECTS + 1);
});

test("refuses an unsafe redirect before making another request", async () => {
  serveWith({ statusCode: 302, headers: { location: "http://93.184.216.34/private" } });
  await assert.rejects(
    () => api.fetchSafeLinkPreviewResource("https://93.184.216.34/start", { maxBytes: 20, accept: "text/html" }),
    /require HTTPS/,
  );
  assert.equal(requestOptions.length, 1);
});

test("truncates only when requested and stops at the byte boundary", async () => {
  serveWith({ statusCode: 200, headers: { "content-length": "6" }, chunks: [Buffer.from("ab"), Buffer.from("cdef")] });
  const truncated = await api.fetchSafeLinkPreviewResource("https://93.184.216.34/large", {
    maxBytes: 3, accept: "text/html", truncateAtByteLimit: true,
  });
  assert.equal(truncated.body.toString(), "abc");

  serveWith({ statusCode: 200, headers: { "content-length": "3" }, chunks: [Buffer.from("abc")] });
  const exact = await api.fetchSafeLinkPreviewResource("https://93.184.216.34/exact", {
    maxBytes: 3, accept: "text/html", truncateAtByteLimit: true,
  });
  assert.equal(exact.body.toString(), "abc");

  serveWith({ statusCode: 200, headers: {}, chunks: [Buffer.from("abc")] });
  const exactUntruncated = await api.fetchSafeLinkPreviewResource("https://93.184.216.34/exact", {
    maxBytes: 3, accept: "text/html",
  });
  assert.equal(exactUntruncated.body.toString(), "abc");
});

test("rejects declared or streamed bodies over the byte limit when truncation is off", async () => {
  serveWith({ statusCode: 200, headers: { "content-length": "4" }, chunks: [] });
  await assert.rejects(
    () => api.fetchSafeLinkPreviewResource("https://93.184.216.34/large", { maxBytes: 3, accept: "text/html" }),
    /exceeded its byte limit/,
  );

  serveWith({ statusCode: 200, headers: {}, chunks: [Buffer.from("ab"), Buffer.from("cd")] });
  await assert.rejects(
    () => api.fetchSafeLinkPreviewResource("https://93.184.216.34/large", { maxBytes: 3, accept: "text/html" }),
    /exceeded its byte limit/,
  );
});

test("passes request errors through without constructing a partial response", async () => {
  serveWith({ error: new Error("socket failed") });
  await assert.rejects(
    () => api.fetchSafeLinkPreviewResource("https://93.184.216.34/fail", { maxBytes: 20, accept: "text/html" }),
    /socket failed/,
  );
});
