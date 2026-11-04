import assert from "node:assert/strict"
import { test } from "node:test"

import * as packageSurface from "../../source/packages/agent-core/index.ts"
import * as actionInbox from "../../source/packages/agent-core/conversation-actions/action-inbox.ts"
import * as remoteReceiver from "../../source/packages/agent-core/conversation-actions/remote-receiver.ts"
import * as goalContinuation from "../../source/packages/agent-core/goal-continuation.ts"
import * as goalGuidelines from "../../source/packages/agent-core/goal-guidelines.ts"
import * as interactionListener from "../../source/packages/agent-core/interaction-listener.ts"
import * as interactionQueries from "../../source/packages/agent-core/interaction-queries.ts"
import * as interactionUpdates from "../../source/packages/agent-core/interaction-updates.ts"
import * as redactedInteractionUpdates from "../../source/packages/agent-core/redacted-interaction-updates.ts"

test("agent-core exports exactly its Slate-owned modules through one package entry", () => {
  const declaredSurface = new Set([
    ...Object.keys(actionInbox),
    ...Object.keys(remoteReceiver),
    ...Object.keys(goalContinuation),
    ...Object.keys(goalGuidelines),
    ...Object.keys(interactionListener),
    ...Object.keys(interactionQueries),
    ...Object.keys(interactionUpdates),
    ...Object.keys(redactedInteractionUpdates),
  ])
  assert.deepEqual(Object.keys(packageSurface).sort(), [...declaredSurface].sort())
  assert.equal("toRedactedInteractionUpdate" in packageSurface, false)
})
