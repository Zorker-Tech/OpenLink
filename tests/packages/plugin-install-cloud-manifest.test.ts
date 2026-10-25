import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { releaseSourceFromManifest } from "../../source/packages/plugin-install/cloud-manifest.ts";

describe("release source from a plugin manifest", () => {
  it("uses the manifest's complete release coordinates", () => {
    assert.deepEqual(
      releaseSourceFromManifest({ releaseRepo: "owner/repo", releaseAsset: "plugin.tar.gz", releaseTag: "v2" }),
      { kind: "release", releaseRepo: "owner/repo", releaseAsset: "plugin.tar.gz", releaseTag: "v2" }
    );
  });

  it("uses the fallback tag only when the manifest did not provide one", () => {
    assert.deepEqual(
      releaseSourceFromManifest({ releaseRepo: "owner/repo", releaseAsset: "plugin.tar.gz" }, "v3"),
      { kind: "release", releaseRepo: "owner/repo", releaseAsset: "plugin.tar.gz", releaseTag: "v3" }
    );
    assert.deepEqual(
      releaseSourceFromManifest({ releaseRepo: "owner/repo", releaseAsset: "plugin.tar.gz", releaseTag: "v2" }, "v3"),
      { kind: "release", releaseRepo: "owner/repo", releaseAsset: "plugin.tar.gz", releaseTag: "v2" }
    );
  });

  it("does not treat empty coordinates or an explicit empty tag as a release", () => {
    for (const manifest of [
      { releaseRepo: "", releaseAsset: "plugin.tar.gz", releaseTag: "v2" },
      { releaseRepo: "owner/repo", releaseAsset: "", releaseTag: "v2" },
      { releaseRepo: "owner/repo", releaseAsset: "plugin.tar.gz", releaseTag: "" },
      { releaseRepo: "owner/repo", releaseAsset: "plugin.tar.gz" },
    ]) {
      assert.equal(releaseSourceFromManifest(manifest, ""), undefined);
    }
    assert.equal(
      releaseSourceFromManifest({ releaseRepo: "owner/repo", releaseAsset: "plugin.tar.gz", releaseTag: "" }, "v2"),
      undefined
    );
  });

  it("keeps non-empty values as written without trimming", () => {
    assert.deepEqual(
      releaseSourceFromManifest({ releaseRepo: " owner/repo ", releaseAsset: " asset.tar.gz ", releaseTag: " v2 " }),
      { kind: "release", releaseRepo: " owner/repo ", releaseAsset: " asset.tar.gz ", releaseTag: " v2 " }
    );
  });
});
