import assert from "node:assert/strict"
import { test } from "node:test"

import {
  LOCAL_EXEC_FAILED_EVENT,
  LOCAL_EXEC_PROVIDER_EVENT,
  LOCAL_EXEC_REFUSED_EVENT,
  projectLocalExecFailure,
  projectLocalExecProvider,
  projectLocalExecRefusal,
} from "../../source/host/telemetry/local-exec-telemetry.ts"
import { describeLocalExecRefusal } from "../../source/host/telemetry/local-exec-refusal-policy.ts"

test("refusal causes map to registered Slate error details", () => {
  assert.deepEqual(describeLocalExecRefusal("stale_heartbeat"), {
    code: "SLATE-E0112",
    domain: "transport",
    retryable: true,
  })
})

test("a local-exec refusal records counts and preserves an explicit zero duration", () => {
  assert.deepEqual(projectLocalExecRefusal({
    cause: "no_providers",
    site: "ask_gate",
    conversationId: "conversation-1",
    providerCount: 0,
    liveProviderCount: 0,
    everRegistered: false,
    emptyForMs: 0,
  }), {
    level: "warn",
    event: LOCAL_EXEC_REFUSED_EVENT,
    metadata: {
      cause: "no_providers",
      site: "ask_gate",
      conversation_id: "conversation-1",
      provider_count: "0",
      live_provider_count: "0",
      ever_registered: "false",
      empty_for_ms: "0",
      error_code: "SLATE-E0111",
      error_domain: "transport",
      error_retryable: "true",
    },
  })
})

test("failed command telemetry carries the local failure class and optional errno", () => {
  assert.deepEqual(projectLocalExecFailure({
    errorClass: "SpawnFailure",
    errno: "ENOENT",
    site: "shell",
    conversationId: "conversation-2",
  }), {
    level: "warn",
    event: LOCAL_EXEC_FAILED_EVENT,
    metadata: {
      error_class: "SpawnFailure",
      errno: "ENOENT",
      site: "shell",
      surface: "external",
      conversation_id: "conversation-2",
    },
  })
})

test("provider telemetry keeps phase-specific fields separate", () => {
  const hello = projectLocalExecProvider({
    phase: "hello",
    providerId: "provider-1",
    providerCount: 2,
    helloDelayMs: 2.6,
    computerIdPresent: true,
    rehello: false,
    supervised: true,
    variant: "shared",
  })
  assert.deepEqual(hello, {
    level: "info",
    event: LOCAL_EXEC_PROVIDER_EVENT,
    metadata: {
      phase: "hello",
      provider_id: "provider-1",
      provider_count: "2",
      hello_delay_ms: "3",
      computer_id_present: "true",
      rehello: "false",
      supervised: "true",
      variant: "shared",
    },
  })

  const detached = projectLocalExecProvider({
    phase: "detached",
    providerId: "provider-1",
    providerCount: 1,
    ageMs: 4.4,
    hadHello: true,
    hasHeartbeat: false,
    wasLive: false,
    emptied: true,
  })
  assert.deepEqual(detached.metadata, {
    phase: "detached",
    provider_id: "provider-1",
    provider_count: "1",
    age_ms: "4",
    had_hello: "true",
    has_heartbeat: "false",
    was_live: "false",
    emptied: "true",
  })
})
