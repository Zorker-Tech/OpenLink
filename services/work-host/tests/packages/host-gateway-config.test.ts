import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SlateGatewayConfigError,
  gatewayScheme,
  isLoopbackHost,
  resolveGatewayServerConfig,
} from "../../source/gateway/gateway-config.ts";

/** The configuration for this environment, minting a token we can recognise. */
const configure = (env: Record<string, string | undefined>) => resolveGatewayServerConfig(env as never, () => "minted-token");

describe("the configuration a gateway starts with", () => {
  it("binds to this machine and asks for no token unless something says otherwise", () => {
    assert.deepEqual(configure({}), { host: "127.0.0.1" });
    assert.deepEqual(configure({ SLATE_GATEWAY_BIND_HOST: " localhost " }), { host: "localhost" });
  });

  it("asks for a token when it is reachable from somewhere other than this machine", () => {
    assert.deepEqual(configure({ SLATE_GATEWAY_BIND_HOST: "0.0.0.0" }), { host: "0.0.0.0", authToken: "minted-token" });
    assert.deepEqual(configure({ SLATE_GATEWAY_BIND_HOST: "example.com" }).authToken, "minted-token");
  });

  it("asks for one when the environment asks, and uses the token it was given rather than minting another", () => {
    assert.equal(configure({ SLATE_GATEWAY_REQUIRE_AUTH: " TRUE " }).authToken, "minted-token");
    assert.equal(configure({ SLATE_GATEWAY_TOKEN: " pinned " }).authToken, "pinned");
    assert.equal(configure({ SLATE_GATEWAY_TOKEN: "pinned", SLATE_GATEWAY_REQUIRE_AUTH: "1" }).authToken, "pinned");
    assert.equal(configure({ SLATE_GATEWAY_REQUIRE_AUTH: "nah" }).authToken, undefined, "a value that is not yes is not yes");
  });

  it("takes a port only when it is a positive whole number", () => {
    assert.equal(configure({ SLATE_HOST_PORT: "8080" }).port, 8080);
    for (const raw of ["0", "abc", ""]) assert.equal(configure({ SLATE_HOST_PORT: raw }).port, undefined, raw);
    // A port is read as its leading digits: "127.0.0" is the number 127, not a refusal.
    assert.equal(configure({ SLATE_HOST_PORT: "127.0.0" }).port, 127);
  });

  it("refuses a TLS configuration that names one of the two files, and one it cannot read", () => {
    assert.throws(() => configure({ SLATE_GATEWAY_TLS_CERT: "/nope/cert" }), { name: "SlateGatewayConfigError", message: /needs both SLATE_GATEWAY_TLS_CERT and SLATE_GATEWAY_TLS_KEY/ });
    assert.throws(() => configure({ SLATE_GATEWAY_TLS_KEY: "/nope/key" }), { name: "SlateGatewayConfigError", message: /needs both/ });
    assert.throws(() => configure({ SLATE_GATEWAY_TLS_CERT: "/nope/cert", SLATE_GATEWAY_TLS_KEY: "/nope/key" }), /Failed to read gateway TLS cert\/key/);
    assert.equal(configure({ SLATE_GATEWAY_TLS_CERT: "   " }).tls, undefined, "a path of spaces is no path");
  });

  it("serves https only when it was given a certificate", () => {
    assert.equal(gatewayScheme({ host: "h" }), "http");
    assert.equal(gatewayScheme({ host: "h", tls: { cert: Buffer.from("c"), key: Buffer.from("k") } }), "https");
  });

  it("calls this machine loopback whatever the padding or case", () => {
    for (const host of ["127.0.0.1", "localhost", "  LOCALHOST ", "::1", "[::1]"]) assert.equal(isLoopbackHost(host), true, host);
    for (const host of ["0.0.0.0", "example.com", "localhost.example.com"]) assert.equal(isLoopbackHost(host), false, host);
  });
});
