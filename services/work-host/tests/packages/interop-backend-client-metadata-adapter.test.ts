import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getSlateBackendClientHeaders } from "../../source/adapters/interop/backend/slate-client-metadata-adapter.ts"

describe("backend client metadata adapter", () => {
  it("maps Slate build and box identity into the external request header names", () => {
    assert.deepEqual(
      getSlateBackendClientHeaders({
        SLATE_CLIENT_APP_VERSION: "4.5.6-beta.2",
        SLATE_BOX_OWNER_NAMESPACE: "lab",
      }),
      {
        "x-cursor-client-type": "slate",
        "x-cursor-client-version": "4.5.6-lab",
        "x-slate-box-namespace": "lab",
      },
    )
  })

  it("uses the Slate fallback version and development namespace when no stamped version is usable", () => {
    assert.deepEqual(
      getSlateBackendClientHeaders({
        SLATE_CLIENT_APP_VERSION: "unreleased",
        SLATE_BOX_OWNER_NAMESPACE: "dev",
      }),
      {
        "x-cursor-client-type": "slate",
        "x-cursor-client-version": "0.1.0-dev",
        "x-slate-box-namespace": "dev",
      },
    )
  })
})
