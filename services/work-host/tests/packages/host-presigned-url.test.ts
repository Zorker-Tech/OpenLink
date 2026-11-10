/**
 * The presigned address a store read or write is given: what it must be, and what it must never be.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertAddressSafe, validatorForBackend } from "../../source/packages/agent-store-sync/presigned-url.ts";

const BCS = "https://agent-stores.s3.us-east-1.amazonaws.com/objects/a?signature=secret";
const accepted = (validate: (url: URL) => void, url: string) => {
  validate(new URL(url));
};
const refusalCode = (validate: (url: URL) => void, url: string): string | undefined => {
  try {
    validate(new URL(url));
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

describe("the default policy", () => {
  const validate = (url: URL) => validatorForBackend("https://api.slate.invalid")(url);

  it("accepts an https address on one of the store's own hosts, and refuses the others", () => {
    accepted(validate, BCS);
    accepted(validate, "https://agent-stores.s3.amazonaws.com/objects/a");
    // An S3 endpoint the backend did not name is refused by the allowlist, however S3 it looks.
    assert.equal(refusalCode(validate, "https://agent-stores.s3-accelerate.amazonaws.com/a"), "host_not_allowed");
    assert.equal(refusalCode(validate, "https://agent-stores.s3-fips.us-east-1.amazonaws.com/a"), "host_not_allowed");
  });

  it("refuses credentials in the address, and shows what it refused without the signature", () => {
    assert.equal(refusalCode(validate, "https://user:pass@agent-stores.s3.us-east-1.amazonaws.com/a?signature=secret"), "userinfo_not_allowed");
    // The refusal's own copy of the address never carries the query: it is the signature.
    try {
      validate(new URL("https://agent-stores.s3.us-east-1.amazonaws.com/a?signature=secret&other=1"));
      validate(new URL("http://agent-stores.s3.us-east-1.amazonaws.com/a?signature=secret"));
    } catch (error) {
      assert.equal((error as { url?: string }).url, "http://agent-stores.s3.us-east-1.amazonaws.com/a");
    }
  });

  it("refuses anything that is not https, and any address on the host or a private network", () => {
    assert.equal(refusalCode(validate, "http://agent-stores.s3.us-east-1.amazonaws.com/a"), "scheme_not_allowed");
    assert.equal(refusalCode(validate, "ftp://agent-stores.s3.us-east-1.amazonaws.com/a"), "scheme_not_allowed");
    for (const host of [
      "localhost",
      "127.0.0.1",
      "0.0.0.0",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.1.1",
      "100.64.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "ff02::1",
      "::ffff:10.0.0.1",
      "::ffff:a00:1",
    ]) {
      assert.equal(refusalCode(validate, `https://${host.includes(":") ? `[${host}]` : host}/a`), "private_host_not_allowed", host);
    }
  });

  it("accepts a public address that is not private, and refuses a host that is not an S3 endpoint", () => {
    // A public IPv4 and a public IPv6 name are not private: they fail the *host* check instead, which is the point.
    assert.equal(refusalCode(validate, "https://8.8.8.8/a"), "host_not_allowed");
    assert.equal(refusalCode(validate, "https://[2606:4700::1111]/a"), "host_not_allowed");
    assert.equal(refusalCode(validate, "https://evil.invalid/a"), "host_not_allowed");
    // An amazonaws.com name without an S3 label is not an S3 endpoint, and the refusal says exactly that (rather than
    // "not in the allowlist", which is the other reason a host can be refused).
    const notS3 = (url: string) => {
      try {
        validate(new URL(url));
        return "";
      } catch (error) {
        return String((error as Error).message);
      }
    };
    assert.match(notS3("https://ec2.us-east-1.amazonaws.com/a"), /not an AWS S3 endpoint/);
    assert.match(notS3("https://amazonaws.com/a"), /not an AWS S3 endpoint/);
    // (`https:///a` is not an empty host: the URL parser collapses the slashes and the host becomes `a`.)
  });
});

describe("a backend that names its own hosts", () => {
  it("accepts only the hosts it named, and the S3 labels still have to be there", () => {
    const playground = validatorForBackend("https://api.playground.cursor.sh");
    accepted(playground, "https://agent-stores-928182716709-us-west-2-an.s3.us-west-2.amazonaws.com/a");
    assert.equal(refusalCode(playground, BCS), "host_not_allowed");
    assert.equal(refusalCode(playground, "https://api.playground.cursor.sh/a"), "host_not_allowed");
  });

  it("lets a backend on this machine use loopback http, and nothing else", () => {
    const local = validatorForBackend("http://localhost:8787");
    accepted(local, "http://127.0.0.1:9000/objects/a");
    accepted(local, "http://localhost:9000/objects/a");
    accepted(local, "http://[::1]:9000/objects/a");
    // Loopback https is still loopback, and the default policy refuses it.
    assert.equal(refusalCode(local, "https://127.0.0.1:9000/a"), "private_host_not_allowed");
    // A non-loopback address falls back to the store's own policy, where plain http is not allowed at all.
    assert.equal(refusalCode(local, "http://10.0.0.1/a"), "scheme_not_allowed");
    // And an https address on a private host is refused as private.
    assert.equal(refusalCode(local, "https://10.0.0.1/a"), "private_host_not_allowed");
    accepted(local, BCS);
    // The empty backend URL is not a local one.
    assert.equal(refusalCode(validatorForBackend("  "), "http://127.0.0.1:1/a"), "scheme_not_allowed");
  });
});

describe("the check a store call makes", () => {
  const validate = validatorForBackend("https://api.slate.invalid");

  it("names the file when the address cannot be parsed, and wraps a refusal with it", () => {
    assert.throws(() => assertAddressSafe({ rawUrl: "not a url", relPath: "notes/a.txt", validatePresignedUrl: validate }), /Refusing unparseable presigned URL for notes\/a.txt/);
    assert.throws(
      () => assertAddressSafe({ rawUrl: "http://evil.invalid/a", relPath: "notes/a.txt", validatePresignedUrl: validate }),
      (error: unknown) => error instanceof Error && error.message === "Refusing presigned URL for notes/a.txt: Refused presigned URL with non-https scheme: http:" && error.cause instanceof Error,
    );
    // An accepted address is silent.
    assert.equal(assertAddressSafe({ rawUrl: BCS, relPath: "notes/a.txt", validatePresignedUrl: validate }), undefined);
  });
});
