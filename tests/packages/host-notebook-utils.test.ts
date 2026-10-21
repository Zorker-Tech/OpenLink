import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extractCellSource,
  isJupyterNotebook,
  parseNotebook,
  tryParseNotebook,
  type NotebookCell,
} from "../../source/packages/agent/tools/core/notebook-utils.ts";

/** A notebook as a file would hold it. */
const notebookText = (cells: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5, ...extra });

describe("a notebook that reads", () => {
  it("is a notebook of cells, with the metadata the format defaults", () => {
    const result = parseNotebook(notebookText([{ cell_type: "code", source: "print(1)" }]));
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.notebook.cells.length, 1);
    assert.deepEqual(result.notebook.cells[0]?.metadata, {});
    assert.equal(result.notebook.cells[0]?.cell_type, "code");
  });

  it("takes a source written as one string or as a line per element", () => {
    const asLines = parseNotebook(notebookText([{ cell_type: "markdown", source: ["# title", "\ntext"] }]));
    const asString = parseNotebook(notebookText([{ cell_type: "markdown", source: "# title" }]));
    assert.equal(asLines.success, true);
    assert.equal(asString.success, true);
    if (!asLines.success || !asString.success) return;
    assert.deepEqual(asLines.notebook.cells[0]?.source, ["# title", "\ntext"]);
    assert.equal(asString.notebook.cells[0]?.source, "# title");
  });

  it("reads a cell's outputs, including the error and the display data ones", () => {
    const result = parseNotebook(
      notebookText([
        {
          cell_type: "code",
          source: "x",
          outputs: [
            { output_type: "stream", text: ["a"] },
            { output_type: "error", ename: "E", evalue: "v", traceback: ["t"] },
            { output_type: "display_data", data: { "image/png": "abc" } },
          ],
        },
      ]),
    );
    assert.equal(result.success, true);
  });

  it("hands back nothing but the notebook through the tolerant reader", () => {
    const notebook = tryParseNotebook(notebookText([]));
    assert.deepEqual(notebook?.cells, []);
    assert.equal(tryParseNotebook("not json"), undefined);
  });
});

describe("a notebook that does not read", () => {
  it("says so when the text is not JSON at all, and does not pretend it was a shape problem", () => {
    const result = parseNotebook("{nope");
    assert.deepEqual(result, {
      success: false,
      error: "Failed to parse notebook as JSON",
      errorDetails: "The notebook file is not valid JSON",
    });
  });

  it("names the fields that were wrong, as a path and a reason", () => {
    const result = parseNotebook(notebookText([{ cell_type: "code" }]));
    assert.equal(result.success, false);
    if (result.success) return;
    assert.match(result.error, /^Invalid notebook structure: cells\.0\.source: /);
    assert.match(result.errorDetails, /^The notebook file does not match the expected Jupyter notebook format: cells\.0\.source: /);
  });

  it("refuses a cell type the format does not have", () => {
    const result = parseNotebook(notebookText([{ cell_type: "bogus", source: "x" }]));
    assert.equal(result.success, false);
    if (result.success) return;
    assert.match(result.error, /cells\.0\.cell_type/);
  });

  it("refuses a source that is neither text nor lines", () => {
    const result = parseNotebook(notebookText([{ cell_type: "code", source: 5 }]));
    assert.equal(result.success, false);
    if (result.success) return;
    assert.match(result.error, /cells\.0\.source/);
  });

  it("refuses an execution count that is not a number or null", () => {
    assert.equal(parseNotebook(notebookText([{ cell_type: "code", source: "x", execution_count: "one" }])).success, false);
    assert.equal(parseNotebook(notebookText([{ cell_type: "code", source: "x", execution_count: null }])).success, true);
    assert.equal(parseNotebook(notebookText([{ cell_type: "code", source: "x", execution_count: 3 }])).success, true);
  });

  it("names every field that was wrong, separated, in the order they were found", () => {
    const result = parseNotebook(notebookText([{ cell_type: "code" }, { cell_type: "bogus", source: "x" }]));
    assert.equal(result.success, false);
    if (result.success) return;
    assert.match(result.error, /cells\.0\.source: /);
    assert.match(result.error, /cells\.1\.cell_type: /);
    assert.match(result.error, /cells\.0\.source: .*, cells\.1\.cell_type: /, "the issues are separated, not run together");
  });

  it("refuses an output that is not the shape the format writes", () => {
    const result = parseNotebook(notebookText([{ cell_type: "code", source: "x", outputs: [{ text: 5 }] }]));
    assert.equal(result.success, false);
  });

  it("refuses cells that are not a list, and a notebook version that is not a number", () => {
    assert.equal(parseNotebook(JSON.stringify({ cells: "not an array" })).success, false);
    assert.equal(parseNotebook(JSON.stringify({ cells: [], nbformat: "four" })).success, false);
  });
});

describe("a cell's source as text", () => {
  it("joins the lines, because a line per element is the format's own artifact", () => {
    assert.equal(extractCellSource({ cell_type: "code", source: ["a", "b"] } as NotebookCell), "ab");
    assert.equal(extractCellSource({ cell_type: "code", source: ["# a", "\n", "b"] } as NotebookCell), "# a\nb");
  });

  it("leaves a source that is one string alone, and answers nothing for an empty one", () => {
    assert.equal(extractCellSource({ cell_type: "code", source: "one line" } as NotebookCell), "one line");
    assert.equal(extractCellSource({ cell_type: "code", source: "" } as NotebookCell), "");
    assert.equal(extractCellSource({ cell_type: "code", source: [] as string[] } as unknown as NotebookCell), "");
  });
});

describe("what counts as a notebook file", () => {
  it("is a path ending in the notebook extension", () => {
    assert.equal(isJupyterNotebook("a.ipynb"), true);
    assert.equal(isJupyterNotebook("dir/x.ipynb"), true);
    assert.equal(isJupyterNotebook(".ipynb"), true);
    assert.equal(isJupyterNotebook("a.IPYNB"), false, "the extension is written in lower case by everything that makes one");
    assert.equal(isJupyterNotebook("a.ipynb.bak"), false);
    assert.equal(isJupyterNotebook("notebook"), false);
  });
});
