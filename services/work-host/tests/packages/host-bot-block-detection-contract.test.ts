import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BOT_BLOCK_SIGNATURES,
  MAX_BLOCKED_HOST_LENGTH,
  MAX_BLOCKED_URL_LENGTH,
  classifyBotBlockPage,
  matchesHost,
  matchesPath,
  matchesTitle,
  withBotBlockDetection,
  type BotBlockSignature,
} from "../../source/host/runner/bot-block-detection.ts";
import type { ActionAuditor, AuditRecord } from "../../source/host/runner/site-visit-tracking.ts";

describe("bot-block page detection behavior contract", () => {
  it("keeps the host/url bounds and the local signature catalog", () => {
    assert.equal(MAX_BLOCKED_HOST_LENGTH, 100);
    assert.equal(MAX_BLOCKED_URL_LENGTH, 1_024);
    assert.equal(BOT_BLOCK_SIGNATURES.length >= 15, true);
  });

  it("matches host equality and suffix rules without silently folding direct matcher input", () => {
    const condition = { equals: ["example.com"], suffix: [".captcha.test"] };
    assert.equal(matchesHost(condition, "example.com"), true);
    assert.equal(matchesHost(condition, "login.captcha.test"), true);
    assert.equal(matchesHost(condition, "notcaptcha.test"), false);
    assert.equal(matchesHost(condition, "EXAMPLE.COM"), false);
  });

  it("matches path equality, prefix and substring rules", () => {
    const condition = { equals: ["/exact"], prefix: ["/challenge/"], includes: ["/captcha/"] };
    assert.equal(matchesPath(condition, "/exact"), true);
    assert.equal(matchesPath(condition, "/challenge/start"), true);
    assert.equal(matchesPath(condition, "/cdn/captcha/flow"), true);
    assert.equal(matchesPath(condition, "/ordinary"), false);
  });

  it("matches title equality and prefix rules with the supplied casing", () => {
    const condition = { equals: ["Access Denied"], startsWith: ["Security Checkpoint"] };
    assert.equal(matchesTitle(condition, "Access Denied"), true);
    assert.equal(matchesTitle(condition, "Security Checkpoint — wait"), true);
    assert.equal(matchesTitle(condition, "access denied"), false);
  });

  it("classifies representative host, path and title signatures with their confidence", () => {
    assert.deepEqual(classifyBotBlockPage({ url: "https://www.google.com/sorry/index", title: "" }), {
      family: "google_sorry", confidence: "high", blockedHost: "google.com", blockedUrl: "https://www.google.com/sorry/index",
    });
    assert.equal(classifyBotBlockPage({ url: "https://accounts.google.com/signin/rejected", title: "" })?.family, "google_signin_rejected");
    assert.equal(classifyBotBlockPage({ url: "https://example.test/recaptcha/api2/anchor", title: "" })?.confidence, "low");
    assert.equal(classifyBotBlockPage({ url: "https://example.test/", title: "Just a moment — please wait" })?.family, "cloudflare_challenge");
    assert.deepEqual(classifyBotBlockPage({ url: "https://example.test/", title: "Access Denied" })?.confidence, "low");
  });

  it("uses the first matching signature when several families match one page", () => {
    const match = classifyBotBlockPage({
      url: "https://google.com/sorry/index",
      title: "Vercel Security Checkpoint",
    });
    assert.equal(match?.family, "google_sorry");
  });

  it("normalizes the URL hostname but does not treat lookalike suffixes as a match", () => {
    assert.equal(classifyBotBlockPage({ url: "https://WWW.GOOGLE.COM/sorry", title: "" })?.blockedHost, "google.com");
    assert.equal(classifyBotBlockPage({ url: "https://notgoogle.com/sorry", title: "" }), undefined);
  });

  it("omits query and fragment data and bounds the reported URL", () => {
    const page = classifyBotBlockPage({
      url: "https://challenge.test/cdn-cgi/challenge-platform/flow?secret=hidden#fragment",
      title: "",
    });
    assert.equal(page?.blockedUrl, "https://challenge.test/cdn-cgi/challenge-platform/flow");

    const longPath = `/cdn-cgi/challenge-platform/${"x".repeat(MAX_BLOCKED_URL_LENGTH + 100)}`;
    const bounded = classifyBotBlockPage({ url: `https://challenge.test${longPath}`, title: "" });
    assert.equal(bounded?.blockedUrl.length, MAX_BLOCKED_URL_LENGTH);
  });

  it("bounds the host value reported for an unusually long URL hostname", () => {
    const hostname = `${"a".repeat(55)}.${"b".repeat(55)}.arkoselabs.com`;
    const hit = classifyBotBlockPage({ url: `https://${hostname}/flow`, title: "" });
    assert.equal(hit?.family, "arkose");
    assert.equal(hit?.blockedHost.length, MAX_BLOCKED_HOST_LENGTH);
  });

  it("records every action first and reports only recognized browser navigations", () => {
    const order: string[] = [];
    const record: AuditRecord = { action: { kind: "browserNavigation", url: "https://google.com/sorry", pageTitle: "" } };
    const received: AuditRecord[] = [];
    const auditor: ActionAuditor = { record: (entry) => { received.push(entry); order.push("record"); } };
    const wrapped = withBotBlockDetection(auditor, (hit, received) => {
      assert.equal(received, record);
      order.push(`hit:${hit.family}`);
    });
    wrapped.record(record);
    wrapped.record({ action: { kind: "browserNavigation", url: "not a URL" } });
    wrapped.record({ action: { kind: "browserNavigation", url: 7 } } as unknown as AuditRecord);
    wrapped.record({ action: { kind: "shellCommand" } });
    assert.deepEqual(order, ["record", "hit:google_sorry", "record", "record", "record"]);
    assert.equal(received[0], record);
  });

  it("does not report a block if the underlying audit write fails", () => {
    let hits = 0;
    const wrapped = withBotBlockDetection(
      { record: () => { throw new Error("audit unavailable"); } },
      () => { hits += 1; },
    );
    assert.throws(() => wrapped.record({ action: { kind: "browserNavigation", url: "https://google.com/sorry" } }), /audit unavailable/);
    assert.equal(hits, 0);
  });

  it("keeps compound signatures inspectable as matcher data", () => {
    const signatures: readonly BotBlockSignature[] = BOT_BLOCK_SIGNATURES;
    assert.equal(signatures.some((signature) => signature.host !== undefined && signature.path !== undefined), true);
    assert.equal(signatures.some((signature) => signature.title?.startsWith !== undefined), true);
  });
});
