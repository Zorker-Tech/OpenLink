import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { describe, it } from "node:test";

/**
 * The proxy is read from the environment when the module loads, so every case loads the module fresh (with a
 * cache-busting query) under the environment it needs, and talks to a local target and a local proxy. The proxy
 * carries undici's CONNECT tunnel through to the target, so "went through the proxy" is visible on both sides.
 */

interface LoadedProxyFetch {
  proxyFetch: (url: string | URL, options?: RequestInit) => Promise<Response>;
}

interface Hit {
  readonly kind: "request" | "connect";
  readonly url: string;
  readonly header: string | null;
}

interface Server {
  readonly url: string;
  readonly port: string;
  readonly hits: Hit[];
  close(): Promise<void>;
}

const moduleUrl = new URL("../../source/packages/config/auth/proxy-fetch.ts", import.meta.url).href;
let loads = 0;
const loadFresh = async (): Promise<LoadedProxyFetch> => (await import(`${moduleUrl}?case=${(loads += 1)}`)) as LoadedProxyFetch;

const startServer = async (kind: "target" | "proxy"): Promise<Server> => {
  const hits: Hit[] = [];
  const server = http.createServer((request, response) => {
    hits.push({ kind: "request", url: request.url ?? "", header: request.headers["x-probe"] as string ?? null });
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.setHeader("x-served-by", kind);
      response.end(kind === "proxy" ? `proxy:${request.url}` : `target:${request.method}:${Buffer.concat(chunks).toString("utf8")}`);
    });
  });
  if (kind === "proxy") {
    server.on("connect", (request, clientSocket, head) => {
      hits.push({ kind: "connect", url: request.url ?? "", header: null });
      const [host, port] = String(request.url ?? "").split(":");
      const upstream = net.connect(Number(port), host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstream.destroy());
    });
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = String(typeof address === "object" && address !== null ? address.port : "");
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hits,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const savedEnvironment = { upper: process.env.HTTPS_PROXY, lower: process.env.https_proxy };
const restoreEnvironment = (): void => {
  if (savedEnvironment.upper === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = savedEnvironment.upper;
  if (savedEnvironment.lower === undefined) delete process.env.https_proxy;
  else process.env.https_proxy = savedEnvironment.lower;
};

describe("fetching through the machine's proxy", () => {
  it("is one function with the caller's two arguments", async () => {
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    try {
      const module = await loadFresh();
      assert.deepEqual(Object.keys(module), ["proxyFetch"]);
      assert.equal(module.proxyFetch.name, "proxyFetch");
      assert.equal(module.proxyFetch.length, 2);
    } finally {
      restoreEnvironment();
    }
  });

  it("goes straight to the network when no proxy is configured, and keeps the caller's options", async () => {
    const target = await startServer("target");
    const proxy = await startServer("proxy");
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    try {
      const module = await loadFresh();
      const response = await module.proxyFetch(`${target.url}/hello`, { headers: { "x-probe": "direct" }, signal: AbortSignal.timeout(3_000) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-served-by"), "target");
      assert.equal(await response.text(), "target:GET:");
      assert.deepEqual(target.hits.map((hit) => hit.header), ["direct"]);
      assert.deepEqual(proxy.hits, [], "no proxy was opened");
    } finally {
      restoreEnvironment();
      await target.close();
      await proxy.close();
    }
  });

  it("carries the request through the proxy named by the upper-case variable", async () => {
    const target = await startServer("target");
    const proxy = await startServer("proxy");
    process.env.HTTPS_PROXY = proxy.url;
    delete process.env.https_proxy;
    try {
      const module = await loadFresh();
      const response = await module.proxyFetch(`${target.url}/tunnelled`, { headers: { "x-probe": "through" }, signal: AbortSignal.timeout(3_000) });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "target:GET:");
      assert.deepEqual(proxy.hits.map((hit) => `${hit.kind}:${hit.url}`), [`connect:127.0.0.1:${target.port}`], "the proxy was the way in");
      assert.deepEqual(target.hits.map((hit) => hit.header), ["through"], "and the request still reached the target");
    } finally {
      restoreEnvironment();
      await target.close();
      await proxy.close();
    }
  });

  it("falls back to the lower-case variable, and skips an empty upper-case one", async () => {
    const target = await startServer("target");
    const proxy = await startServer("proxy");
    process.env.HTTPS_PROXY = "";
    process.env.https_proxy = proxy.url;
    try {
      const module = await loadFresh();
      const response = await module.proxyFetch(target.url, { signal: AbortSignal.timeout(3_000) });
      assert.equal(response.status, 200);
      assert.deepEqual(proxy.hits.map((hit) => hit.kind), ["connect"]);
    } finally {
      restoreEnvironment();
      await target.close();
      await proxy.close();
    }
  });

  it("ignores a proxy it cannot set up, and goes straight to the network", async () => {
    const target = await startServer("target");
    process.env.HTTPS_PROXY = "not a url";
    delete process.env.https_proxy;
    try {
      const module = await loadFresh();
      const response = await module.proxyFetch(target.url, { signal: AbortSignal.timeout(3_000) });
      assert.equal(response.headers.get("x-served-by"), "target");
    } finally {
      restoreEnvironment();
      await target.close();
    }
  });

  it("reads the proxy once, when the module loads", async () => {
    const target = await startServer("target");
    const proxy = await startServer("proxy");
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    try {
      const module = await loadFresh();
      process.env.HTTPS_PROXY = proxy.url;
      const response = await module.proxyFetch(target.url, { signal: AbortSignal.timeout(3_000) });
      assert.equal(response.headers.get("x-served-by"), "target", "the proxy set after the load does not change this process");
      assert.deepEqual(proxy.hits, []);
    } finally {
      restoreEnvironment();
      await target.close();
      await proxy.close();
    }
  });

  it("fails as a request to an unreachable proxy, and does not reach the target", async () => {
    const target = await startServer("target");
    process.env.HTTPS_PROXY = "http://127.0.0.1:1";
    delete process.env.https_proxy;
    try {
      const module = await loadFresh();
      await assert.rejects(
        () => module.proxyFetch(target.url, { signal: AbortSignal.timeout(3_000) }),
        (error: Error & { cause?: { code?: string } }) => {
          assert.equal(error.cause?.code ?? error.name, "ECONNREFUSED");
          return true;
        },
      );
      assert.deepEqual(target.hits, []);
    } finally {
      restoreEnvironment();
      await target.close();
    }
  });

  it("hands the caller's url object, method and body to the request", async () => {
    const target = await startServer("target");
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    try {
      const module = await loadFresh();
      const posted = await module.proxyFetch(new URL(`${target.url}/posted`), { method: "POST", headers: { "content-type": "text/plain" }, body: "the body", signal: AbortSignal.timeout(3_000) });
      assert.equal(posted.headers.get("x-served-by"), "target");
      assert.equal(await posted.text(), "target:POST:the body");
      assert.deepEqual(target.hits.map((hit) => hit.url), ["/posted"]);
    } finally {
      restoreEnvironment();
      await target.close();
    }
  });
});
