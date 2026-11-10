import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createUaTokenKillSwitchReconciler } from "../../source/host/extensions/browser-ua/ua-token-kill-switch-service.ts"

test("a failed marker write is reported and retried until the desired state is applied", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "slate-ua-token-kill-switch-"))
  const marker = join(scratch, "disabled")
  const logged: string[] = []
  const reconcile = createUaTokenKillSwitchReconciler({
    path: marker,
    isKillSwitchEnabled: () => true,
    log: message => logged.push(message),
  })

  try {
    await mkdir(marker)
    await reconcile()
    assert.equal(logged.length, 1)
    assert.match(logged[0]!, /^ua-token kill-switch marker update failed:/)

    await rm(marker, { recursive: true })
    await reconcile()
    assert.equal(await readFile(marker, "utf8"), "1\n")
    assert.equal(logged.length, 1)

    await reconcile()
    assert.equal(await readFile(marker, "utf8"), "1\n")
    assert.equal(logged.length, 1)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
