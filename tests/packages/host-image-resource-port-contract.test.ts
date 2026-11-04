import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createAgentImageResourcePort } from "../../source/host/attachments/generate-image-resource-accessor.ts";
import { getAgentAssetsDir, getAgentAttachmentsDir } from "../../source/host/attachments/attachment-paths.ts";

test("generated images are written under assets and can be read from the media store", async () => {
  const agentDirectory = mkdtempSync(join(tmpdir(), "slate-image-resource-"));
  try {
    const port = createAgentImageResourcePort(agentDirectory);
    const imagePath = join(getAgentAssetsDir(agentDirectory), "generated", "image.png");
    const bytes = new Uint8Array([1, 2, 3]);
    const written = await port.write({ path: imagePath, fileBytes: bytes });
    assert.deepEqual(written, {
      result: { case: "success", value: { path: imagePath, fileSize: 3 } },
    });
    assert.deepEqual(readFileSync(imagePath), Buffer.from(bytes));
    assert.deepEqual(await port.read({ path: imagePath }), {
      result: { case: "success", value: { data: bytes } },
    });
  } finally {
    rmSync(agentDirectory, { recursive: true, force: true });
  }
});

test("media access refuses paths outside both allowed roots and reports missing files", async () => {
  const agentDirectory = mkdtempSync(join(tmpdir(), "slate-image-resource-boundary-"));
  const outside = mkdtempSync(join(tmpdir(), "slate-image-resource-outside-"));
  try {
    const port = createAgentImageResourcePort(agentDirectory);
    const outsideFile = join(outside, "private.png");
    writeFileSync(outsideFile, "private");
    assert.equal((await port.write({ path: outsideFile, fileBytes: new Uint8Array([9]) })).result.case, "error");
    assert.deepEqual(await port.read({ path: outsideFile }), {
      result: { case: "error", value: { path: outsideFile, error: "Refused to read a reference image outside the agent's sandboxed media store." } },
    });

    mkdirSync(getAgentAttachmentsDir(agentDirectory), { recursive: true });
    symlinkSync(outsideFile, join(getAgentAttachmentsDir(agentDirectory), "escape.png"));
    assert.equal((await port.read({ path: join(getAgentAttachmentsDir(agentDirectory), "escape.png") })).result.case, "error");
    const missing = join(getAgentAssetsDir(agentDirectory), "missing.png");
    assert.equal((await port.read({ path: missing })).result.case, "error");
  } finally {
    rmSync(agentDirectory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
