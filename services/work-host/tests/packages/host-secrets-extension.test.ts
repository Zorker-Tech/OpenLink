import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import type { Context } from "../../source/packages/context/context.ts"
import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts"
import { createSecretsExtension } from "../../source/host/extensions/secrets/extension.ts"
import { BOX_SECRET_REDACTION_NAMES_ENV_VAR } from "../../source/adapters/interop/agent/box-secrets-adapter.ts"
import { SLATE_BOX_SECRET_NAMES_ENV } from "../../source/shared/box-secret-policy.ts"

describe("host secrets extension", () => {
  it("starts with a named request context and exposes persisted apply/status controls", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "slate-secrets-extension-"))
    const priorRoot = process.env.SLATE_DATA_ROOT
    process.env.SLATE_DATA_ROOT = root

    try {
      const namedContexts: string[] = []
      const requestContext = { requestName: "secrets" } as unknown as Context
      const applied: Array<{ context: Context; update: unknown }> = []
      const teardown: Array<() => void | Promise<void>> = []
      const extension = createSecretsExtension(() => ({
        withName: (name) => {
          namedContexts.push(name)
          return requestContext
        },
      }))

      assert.deepEqual(extension.dependencies, [HostExtensions.ForeverBox])
      const api = extension.start({
        deps: {
          [HostExtensions.ForeverBox]: {
            box: { applyEnvironment: async (context: Context, update: unknown) => { applied.push({ context, update }) } },
          },
        },
        host: { log: () => {} },
        onStop: (stop: () => void | Promise<void>) => teardown.push(stop),
      } as never) as {
        set(input: { secrets: Record<string, string> }): Promise<{ keys: string[]; isApplied: boolean; lastAppliedAtMs: number | null }>
        getStatus(): { keys: string[]; isApplied: boolean; lastAppliedAtMs: number | null }
      }

      const status = await api.set({ secrets: { ZED: "last", ALPHA: "first" } })
      assert.deepEqual(namedContexts, ["secrets"])
      assert.deepEqual(status.keys, ["ALPHA", "ZED"])
      assert.equal(status.isApplied, true)
      assert.equal(typeof status.lastAppliedAtMs, "number")
      assert.equal(applied.length, 1)
      assert.equal(applied[0]?.context, requestContext)
      assert.deepEqual(applied[0]?.update, {
        env: { ALPHA: "first", ZED: "last", CLOUD_AGENT_INJECTED_SECRET_NAMES: "ALPHA,ZED" },
        replace: true,
      })
      assert.deepEqual(api.getStatus(), status)
      assert.equal(teardown.length, 1)

      const reservedNames: ReadonlyArray<readonly [string, RegExp]> = [
        [SLATE_BOX_SECRET_NAMES_ENV, /Names starting with SLATE_ are reserved by the box runtime/],
        [BOX_SECRET_REDACTION_NAMES_ENV_VAR, new RegExp(`${BOX_SECRET_REDACTION_NAMES_ENV_VAR} is reserved by the box runtime`)],
      ]
      for (const [reservedName, message] of reservedNames) {
        await assert.rejects(
          api.set({ secrets: { [reservedName]: "spoofed" } }),
          message,
        )
      }
      assert.equal(applied.length, 1, "reserved marker values are rejected before the box is touched")

      const persisted = JSON.parse(await readFile(path.join(root, "box-secrets.json"), "utf8")) as { version: number; secrets: Record<string, string> }
      assert.deepEqual(persisted, { version: 1, secrets: { ZED: "last", ALPHA: "first" } })
      await teardown[0]?.()
    } finally {
      if (priorRoot === undefined) delete process.env.SLATE_DATA_ROOT
      else process.env.SLATE_DATA_ROOT = priorRoot
      await rm(root, { recursive: true, force: true })
    }
  })
})
