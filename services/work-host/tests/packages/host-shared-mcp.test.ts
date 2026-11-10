import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_MCP_ACCOUNT_KEY,
  MAX_CONNECTOR_ERROR_LENGTH,
  MAX_RENDERED_MCP_ACCOUNT_LABEL_LENGTH,
  MAX_UNTRUSTED_MARKUP_SCAN_LENGTH,
  decodeMcpAccountLabelArgument,
  encodeMcpAccountLabelForListing,
  formatMcpAccountDisplayName,
  formatMcpAccountLabelForPrompt,
  isEffectivePluginInstalled,
  normalizeMcpAccountLabel,
  provisionalMcpAccountServerIdentifier,
  stripMarkupAndBoundConnectorError,
  uninstallClearedInstallRecord,
} from "../../source/shared/mcp.ts";

describe("what an account label is compared under", () => {
  it("is the label without its padding or its case", () => {
    assert.equal(normalizeMcpAccountLabel("  Work Account \n"), "work account");
    assert.equal(normalizeMcpAccountLabel("WORK"), normalizeMcpAccountLabel("work"));
    assert.equal(normalizeMcpAccountLabel(""), "");
  });

  it("stands alone for the default account, and joins the identifier for any other", () => {
    assert.equal(DEFAULT_MCP_ACCOUNT_KEY, "default");
    assert.equal(provisionalMcpAccountServerIdentifier("row-1", "default"), "row-1");
    assert.equal(provisionalMcpAccountServerIdentifier("row-1", "work"), "row-1--work");
    assert.equal(provisionalMcpAccountServerIdentifier("row-1", "work-2"), "row-1--work-2");
  });
});

describe("a label inside a listing", () => {
  it("is quoted, with everything that could end the quoting written as an escape", () => {
    assert.equal(encodeMcpAccountLabelForListing("work"), '"work"');
    assert.equal(encodeMcpAccountLabelForListing('a"b'), '"a\\u0022b"');
    assert.equal(encodeMcpAccountLabelForListing("a\\b"), '"a\\u005cb"');
    assert.equal(encodeMcpAccountLabelForListing("a\nb"), '"a\\u000ab"');
    assert.equal(encodeMcpAccountLabelForListing("a\u2028b"), '"a\\u2028b"', "a line separator is as hostile as a newline");
  });

  it("comes back out of a quoted argument, and an argument that is not one comes back as it was given", () => {
    assert.equal(decodeMcpAccountLabelArgument('"work"'), "work");
    assert.equal(decodeMcpAccountLabelArgument('  "work"  '), "work");
    assert.equal(decodeMcpAccountLabelArgument('"a\\"b"'), 'a"b');
    assert.equal(decodeMcpAccountLabelArgument('"unterminated'), '"unterminated');
    assert.equal(decodeMcpAccountLabelArgument("plain"), "plain");
    assert.equal(decodeMcpAccountLabelArgument("  plain  "), "  plain  ", "an argument that is not a quoted string keeps its own padding");
    assert.equal(decodeMcpAccountLabelArgument('""'), "");
  });

  it("is shown in a prompt without the shapes that would be read as structure", () => {
    assert.equal(formatMcpAccountLabelForPrompt("  work   account  "), "work account");
    assert.equal(formatMcpAccountLabelForPrompt('a"b<c>(d)[e]{f}g`h\\i'), "abcdefghi");
    assert.equal(formatMcpAccountLabelForPrompt("x".repeat(100)).length, MAX_RENDERED_MCP_ACCOUNT_LABEL_LENGTH);
    assert.equal(formatMcpAccountLabelForPrompt("tab\there"), "tab here");
  });

  it("names the server with its account unless the account is the default one", () => {
    assert.equal(formatMcpAccountDisplayName("slate", "work"), "slate (work)");
    assert.equal(formatMcpAccountDisplayName("slate", DEFAULT_MCP_ACCOUNT_KEY), "slate");
    assert.equal(formatMcpAccountDisplayName("slate", null), "slate");
    assert.equal(formatMcpAccountDisplayName("slate", undefined), "slate");
    assert.equal(formatMcpAccountDisplayName("slate", "  work  "), "slate (work)");
  });
});

describe("what a plugin's own state says", () => {
  it("counts a plugin as installed when it is switched on", () => {
    assert.equal(isEffectivePluginInstalled({ isEnabled: true }), true);
    assert.equal(isEffectivePluginInstalled({ isEnabled: false }), false);
  });

  it("counts an uninstall as having cleared the record when it was removed or was the team's", () => {
    assert.equal(uninstallClearedInstallRecord({ removed: true }), true);
    assert.equal(uninstallClearedInstallRecord({ removed: false }), false);
    assert.equal(uninstallClearedInstallRecord({ removed: false, reason: "team-server" }), true);
    assert.equal(uninstallClearedInstallRecord({ removed: false, reason: "other" }), false);
  });
});

describe("a connector's error, as it may be shown", () => {
  it("keeps the words and drops the markup", () => {
    assert.equal(stripMarkupAndBoundConnectorError("<b>bold</b> claim"), "bold claim");
    assert.equal(stripMarkupAndBoundConnectorError("<div><span>nested</span></div>"), "nested");
    assert.equal(stripMarkupAndBoundConnectorError("a\n\n\nb"), "a b");
  });

  it("drops everything a page says in a script or a style", () => {
    assert.equal(stripMarkupAndBoundConnectorError("<script>alert(1)</script>after"), "after");
    assert.equal(stripMarkupAndBoundConnectorError("<SCRIPT>upper</SCRIPT>"), "");
    assert.equal(stripMarkupAndBoundConnectorError("<style>body{}</style>text"), "text");
    assert.equal(stripMarkupAndBoundConnectorError("before <script>never closed"), "before", "an unterminated script takes the rest with it");
  });

  it("answers nothing for nothing, and nothing for markup alone", () => {
    assert.equal(stripMarkupAndBoundConnectorError(""), "");
    assert.equal(stripMarkupAndBoundConnectorError("   "), "");
    assert.equal(stripMarkupAndBoundConnectorError("<div></div>"), "");
  });

  it("leaves a short error whole and marks a long one as cut", () => {
    const short = "x".repeat(MAX_CONNECTOR_ERROR_LENGTH);
    assert.equal(stripMarkupAndBoundConnectorError(short), short, "exactly the bound is not cut");
    const long = "x".repeat(MAX_CONNECTOR_ERROR_LENGTH + 1);
    const cut = stripMarkupAndBoundConnectorError(long);
    assert.equal(cut.length, MAX_CONNECTOR_ERROR_LENGTH);
    assert.equal(cut.endsWith("…"), true);
    assert.equal(cut.slice(0, -1), "x".repeat(MAX_CONNECTOR_ERROR_LENGTH - 1));
  });

  it("does not read a page beyond the scan length at all", () => {
    const beyond = `${"a".repeat(MAX_UNTRUSTED_MARKUP_SCAN_LENGTH)}beyond`;
    assert.equal(stripMarkupAndBoundConnectorError(beyond).includes("beyond"), false);
  });
});
