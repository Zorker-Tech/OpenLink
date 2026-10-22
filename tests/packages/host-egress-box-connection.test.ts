import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TUNNEL_WS_PORT,
  tunnelConfigFor,
  tunnelWsUrlFor,
} from "../../source/shared/node/egress-tunnel/box-connection.ts";

describe("the address a box's tunnel listens on", () => {
  it("is the tunnel's own port on a box reached directly, and a socket either way", () => {
    assert.equal(TUNNEL_WS_PORT, 8790);
    assert.equal(tunnelWsUrlFor("https://box.example.com", false), `wss://box.example.com:${TUNNEL_WS_PORT}/`);
    assert.equal(tunnelWsUrlFor("http://box.example.com", false), `ws://box.example.com:${TUNNEL_WS_PORT}/`);
    assert.equal(tunnelWsUrlFor("wss://box.example.com", false), `wss://box.example.com:${TUNNEL_WS_PORT}/`);
    assert.equal(tunnelWsUrlFor("ftp://box.example.com", false), `ws://box.example.com:${TUNNEL_WS_PORT}/`);
  });

  it("takes the pod's own port slot when the box is proxied through one", () => {
    assert.equal(tunnelWsUrlFor("https://box-8080.example.com", true), `wss://box-${TUNNEL_WS_PORT}.example.com/`);
    assert.equal(tunnelWsUrlFor("https://box-1-2.example.com", true), `wss://box-1-${TUNNEL_WS_PORT}.example.com/`);
    assert.equal(tunnelWsUrlFor("https://-123.example.com", true), `wss://-${TUNNEL_WS_PORT}.example.com/`);
  });

  it("is nothing for a hostname with no port to take, or an address that is not one", () => {
    assert.equal(tunnelWsUrlFor("https://box.example.com", true), null, "no port in the first label");
    assert.equal(tunnelWsUrlFor("not a url", false), null);
    assert.equal(tunnelWsUrlFor("", false), null);
  });

  it("drops the path and the query the box was reached with", () => {
    assert.equal(tunnelWsUrlFor("http://localhost:9000/x?y=1", false), `ws://localhost:${TUNNEL_WS_PORT}/`);
    // Pinned as it is: the fragment is not cleared, so an address that carried one keeps it.
    assert.equal(tunnelWsUrlFor("http://localhost:9000/x?y=1#z", false), `ws://localhost:${TUNNEL_WS_PORT}/#z`);
  });
});

describe("the configuration a box's tunnel is given", () => {
  it("carries the socket, the token and the headers it was handed", () => {
    assert.deepEqual(tunnelConfigFor({ baseUrl: "https://box.example.com", token: "t", headers: { a: "b" } }), {
      url: `wss://box.example.com:${TUNNEL_WS_PORT}/`,
      bearer: "t",
      headers: { a: "b" },
      allowPrivateTargets: false,
    });
  });

  it("leaves the headers out when there were none", () => {
    assert.equal("headers" in (tunnelConfigFor({ baseUrl: "https://box.example.com", token: "t" }) ?? {}), false);
  });

  it("is nothing for a box with no token, or one whose address is not a URL", () => {
    assert.equal(tunnelConfigFor({ baseUrl: "https://box.example.com" }), null);
    assert.equal(tunnelConfigFor({ baseUrl: "https://box.example.com", token: "" }), null);
    assert.equal(tunnelConfigFor({ baseUrl: "not a url", token: "t" }), null);
    assert.equal(tunnelConfigFor({ baseUrl: "https://box.example.com", token: "t", vncProxy: 0 }), null, "a proxied box whose hostname has no port");
  });

  it("reads the presence of a remote desktop as the box being proxied", () => {
    assert.equal(tunnelConfigFor({ baseUrl: "https://box-8080.example.com", token: "t", vncProxy: {} })?.url, `wss://box-${TUNNEL_WS_PORT}.example.com/`);
    assert.equal(tunnelConfigFor({ baseUrl: "https://box-8080.example.com", token: "t", vncProxy: null })?.url, `wss://box-8080.example.com:${TUNNEL_WS_PORT}/`);
  });
});
