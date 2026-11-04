import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SLATE_GATEWAY } from "../../source/shared/gateway-wire.ts";
import {
  LOCAL_EXEC_CONNECTION_PATH,
  NO_LOCAL_EXEC_CONNECTION_MESSAGE,
  resolveLocalExecConnectionFromBackend,
  runLocalExecDaemon,
  SlateLocalExecConnectionError,
  type RunLocalExecDaemonOptions,
} from "../../source/host/local-exec/local-exec-daemon.ts";
import type { LocalExecExecutor, SlateLocalExecProviderOptions } from "../../source/host/local-exec/local-exec-provider.ts";
import {
  clearLocalExecDaemonDiscovery,
  readLocalExecDaemonConnection,
  readLocalExecDaemonCredential,
  readLocalExecDaemonDiscovery,
  writeLocalExecDaemonConnection,
} from "../../source/host/local-exec/local-exec-daemon-protocol.ts";
import { SLATE_LOCAL_EXEC_SUPERVISED_WINDOW_MS } from "../../source/shared/local-exec-daemon.ts";
import { SLATE_LOCAL_TOOLS_DISABLED_MESSAGE, SLATE_LOCAL_TOOLS_UNAPPROVED_MESSAGE } from "../../source/shared/local-tool-permission-machinery.ts";

async function withRoot(run: (rootDir: string) => Promise<void>): Promise<void> {
  const rootDir = mkdtempSync(join(tmpdir(), "slate-local-exec-daemon-contract-"));
  try {
    await run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function harness(rootDir: string, overrides: Partial<RunLocalExecDaemonOptions> = {}) {
  let received: SlateLocalExecProviderOptions | undefined;
  let starts = 0;
  let closes = 0;
  const options: RunLocalExecDaemonOptions = {
    connectionPath: join(rootDir, "connection.json"),
    credentialPath: join(rootDir, "credential.json"),
    supervisorHeartbeatPath: join(rootDir, "supervisor.json"),
    discoveryPath: join(rootDir, "discovery.json"),
    approvalsPath: join(rootDir, "approvals.json"),
    retirementsPath: join(rootDir, "retirements.json"),
    publishDiscovery: false,
    executor: {} as LocalExecExecutor,
    settingsStore: { getLocalToolPermission: () => "ask" },
    ...overrides,
    providerFactory: (providerOptions) => {
      received = providerOptions;
      return {
        start: () => { starts += 1; },
        close: () => { closes += 1; },
      };
    },
  };
  return runLocalExecDaemon(options).then((lifetime) => ({
    lifetime,
    options: () => received as SlateLocalExecProviderOptions,
    starts: () => starts,
    closes: () => closes,
  }));
}

test("the connection endpoint and no-connection error keep their product contract", () => {
  assert.equal(LOCAL_EXEC_CONNECTION_PATH, "/slate-box/local-exec-connection");
  assert.equal(NO_LOCAL_EXEC_CONNECTION_MESSAGE, "local-exec daemon has no gateway connection yet (waiting for the desktop to hand one off)");
  assert.equal(new SlateLocalExecConnectionError("failure").name, "Error");
});

test("backend connection resolution sends a POST with the handoff credential", async () => {
  let requestedUrl = "";
  let requestInit: RequestInit | undefined;
  const connection = await resolveLocalExecConnectionFromBackend({
    backendUrl: "https://backend.test/base/",
    credential: "handoff-secret",
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({ baseUrl: "https://gateway.test", token: "gateway-token", networkToken: "network-token" }), { status: 200 });
    },
  });
  assert.equal(requestedUrl, `https://backend.test${LOCAL_EXEC_CONNECTION_PATH}`);
  assert.equal(requestInit?.method, "POST");
  assert.equal(new Headers(requestInit?.headers).get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { credential: "handoff-secret" });
  assert.deepEqual(connection, {
    baseUrl: "https://gateway.test",
    token: "gateway-token",
    headers: { [SLATE_GATEWAY.headers.networkToken]: "network-token" },
  });
});

test("backend connection resolver omits absent token fields and accepts an empty network token as absent", async () => {
  const connection = await resolveLocalExecConnectionFromBackend({
    backendUrl: "https://backend.test",
    credential: "handoff",
    fetchImpl: async () => new Response(JSON.stringify({ baseUrl: "https://gateway.test", token: "", networkToken: "" }), { status: 200 }),
  });
  assert.deepEqual(connection, { baseUrl: "https://gateway.test" });
});

test("network failures and unsuccessful backend responses return no connection", async () => {
  const input = { backendUrl: "https://backend.test", credential: "c" };
  assert.equal(await resolveLocalExecConnectionFromBackend({ ...input, fetchImpl: async () => { throw new Error("offline"); } }), null);
  assert.equal(await resolveLocalExecConnectionFromBackend({ ...input, fetchImpl: async () => new Response("{}", { status: 503 }) }), null);
  assert.equal(await resolveLocalExecConnectionFromBackend({ ...input, fetchImpl: async () => new Response("not-json", { status: 200 }) }), null);
  assert.equal(await resolveLocalExecConnectionFromBackend({ ...input, fetchImpl: async () => new Response("null", { status: 200 }) }), null);
  assert.equal(await resolveLocalExecConnectionFromBackend({ ...input, fetchImpl: async () => new Response(JSON.stringify({ baseUrl: "" }), { status: 200 }) }), null);
});

test("daemon startup requires an executor and canonical discovery identity", async () => {
  await assert.rejects(
    () => runLocalExecDaemon({ publishDiscovery: false }),
    (error: unknown) => error instanceof SlateLocalExecConnectionError && error.message === "local-exec executor runtime is not configured",
  );
  await withRoot(async (rootDir) => {
    await assert.rejects(
      () => runLocalExecDaemon({ discoveryPath: join(rootDir, "discovery.json"), executor: {} as LocalExecExecutor }),
      (error: unknown) => error instanceof SlateLocalExecConnectionError && /canonical entry identity and generation token/.test(error.message),
    );
  });
});

test("a private daemon starts once and closes its provider", async () => {
  await withRoot(async (rootDir) => {
    const daemon = await harness(rootDir);
    assert.equal(daemon.starts(), 1);
    assert.equal(daemon.options().onInflightChange, undefined);
    await daemon.lifetime.close();
    assert.equal(daemon.closes(), 1);
    assert.equal(existsSync(join(rootDir, "discovery.json")), false);
  });
});

test("published discovery tracks the latest in-flight count and clears only its own record", async () => {
  await withRoot(async (rootDir) => {
    const daemon = await harness(rootDir, {
      publishDiscovery: true,
      entryRealpath: "/host/slate-local-exec-daemon.js",
      generationToken: "generation-a",
      pid: 71,
      now: () => 100,
    });
    assert.deepEqual(await readLocalExecDaemonDiscovery(join(rootDir, "discovery.json")), {
      pid: 71,
      startedAt: 100,
      entryRealpath: "/host/slate-local-exec-daemon.js",
      generationToken: "generation-a",
      inflightCount: 0,
    });
    daemon.options().onInflightChange?.(1);
    daemon.options().onInflightChange?.(2);
    daemon.options().onInflightChange?.(3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await readLocalExecDaemonDiscovery(join(rootDir, "discovery.json")))?.inflightCount, 3);
    await daemon.lifetime.close();
    assert.equal(await readLocalExecDaemonDiscovery(join(rootDir, "discovery.json")), null);
  });
});

test("a close leaves a discovery record owned by a newer generation", async () => {
  await withRoot(async (rootDir) => {
    const path = join(rootDir, "discovery.json");
    const daemon = await harness(rootDir, {
      publishDiscovery: true,
      entryRealpath: "/host/slate-local-exec-daemon.js",
      generationToken: "old-generation",
      pid: 71,
      now: () => 100,
    });
    await clearLocalExecDaemonDiscovery(path);
    writeFileSync(path, JSON.stringify({ pid: 72, startedAt: 101, entryRealpath: "/host/slate-local-exec-daemon.js", generationToken: "new-generation", inflightCount: 0 }));
    await daemon.lifetime.close();
    assert.equal((await readLocalExecDaemonDiscovery(path))?.generationToken, "new-generation");
  });
});

test("a missing connection gives the provider the waiting error", async () => {
  await withRoot(async (rootDir) => {
    const daemon = await harness(rootDir);
    await assert.rejects(daemon.options().resolveConnection(), (error: unknown) => error instanceof SlateLocalExecConnectionError && error.message === NO_LOCAL_EXEC_CONNECTION_MESSAGE);
  });
});

test("the provider reads the connection file on demand", async () => {
  await withRoot(async (rootDir) => {
    const connectionPath = join(rootDir, "connection.json");
    await writeLocalExecDaemonConnection({ baseUrl: "https://gateway.test", token: "t" }, connectionPath);
    const daemon = await harness(rootDir, { connectionPath });
    assert.deepEqual(await daemon.options().resolveConnection(), { baseUrl: "https://gateway.test", token: "t" });
  });
});

test("a stale connection refreshes only when a valid handoff credential resolves", async () => {
  await withRoot(async (rootDir) => {
    const credentialPath = join(rootDir, "credential.json");
    const connectionPath = join(rootDir, "connection.json");
    writeFileSync(credentialPath, JSON.stringify({ credential: "refresh-secret", backendUrl: "https://backend.test", expiresAtMs: 999 }));
    const calls: unknown[] = [];
    const daemon = await harness(rootDir, {
      credentialPath,
      connectionPath,
      resolveConnectionFromBackend: async (input) => { calls.push(input); return { baseUrl: "https://fresh-gateway", token: "fresh-token" }; },
    });
    await daemon.options().onConnectionStale?.();
    assert.deepEqual(calls, [{ backendUrl: "https://backend.test", credential: "refresh-secret" }]);
    assert.deepEqual(await readLocalExecDaemonConnection(connectionPath), { baseUrl: "https://fresh-gateway", token: "fresh-token" });
  });
});

test("a missing handoff credential and an unresolved refresh leave the connection file alone", async () => {
  await withRoot(async (rootDir) => {
    const credentialPath = join(rootDir, "credential.json");
    const connectionPath = join(rootDir, "connection.json");
    await writeLocalExecDaemonConnection({ baseUrl: "https://old-gateway" }, connectionPath);
    let calls = 0;
    const daemon = await harness(rootDir, {
      credentialPath,
      connectionPath,
      resolveConnectionFromBackend: async () => { calls += 1; return null; },
    });
    await daemon.options().onConnectionStale?.();
    assert.equal(calls, 0);
    writeFileSync(credentialPath, JSON.stringify({ credential: "c", backendUrl: "https://backend.test" }));
    await daemon.options().onConnectionStale?.();
    assert.equal(calls, 1);
    assert.deepEqual(await readLocalExecDaemonConnection(connectionPath), { baseUrl: "https://old-gateway" });
  });
});

test("supervision remains true through the exact heartbeat freshness boundary", async () => {
  await withRoot(async (rootDir) => {
    const heartbeatPath = join(rootDir, "supervisor.json");
    const nowMs = 100_000;
    const daemon = await harness(rootDir, { supervisorHeartbeatPath: heartbeatPath, now: () => nowMs });
    writeFileSync(heartbeatPath, JSON.stringify({ pid: 1, at: nowMs - SLATE_LOCAL_EXEC_SUPERVISED_WINDOW_MS }));
    assert.equal(await daemon.options().isSupervised?.(), true);
    writeFileSync(heartbeatPath, JSON.stringify({ pid: 1, at: nowMs - SLATE_LOCAL_EXEC_SUPERVISED_WINDOW_MS - 1 }));
    assert.equal(await daemon.options().isSupervised?.(), false);
  });
});

test("permission mode never refuses, always allows, and ask mode requires an approval description", async () => {
  await withRoot(async (rootDir) => {
    let permission: "always" | "ask" | "never" = "never";
    const daemon = await harness(rootDir, { settingsStore: { getLocalToolPermission: () => permission } });
    const request = { terminalsFolder: join(rootDir, "terminals"), describes: { action: "run-command", target: "npm test" } };
    assert.equal(await daemon.options().isLocalUseBlocked?.(request as never), SLATE_LOCAL_TOOLS_DISABLED_MESSAGE);
    permission = "always";
    assert.equal(await daemon.options().isLocalUseBlocked?.(request as never), undefined);
    permission = "ask";
    assert.equal(await daemon.options().isLocalUseBlocked?.({ terminalsFolder: request.terminalsFolder } as never), SLATE_LOCAL_TOOLS_UNAPPROVED_MESSAGE);
    assert.equal(await daemon.options().isLocalUseBlocked?.({ ...request, approvalId: "missing" } as never), SLATE_LOCAL_TOOLS_UNAPPROVED_MESSAGE);
  });
});

test("ask mode permits only a live approval covering the requested action", async () => {
  await withRoot(async (rootDir) => {
    const approvalsPath = join(rootDir, "approvals.json");
    const retirementsPath = join(rootDir, "retirements.json");
    writeFileSync(approvalsPath, JSON.stringify({ approvals: [
      { id: "approval-1", action: "run-command", target: "npm test" },
      { id: "terminal-approval", action: "run-command", target: "old command", resourcePath: "/old/terminals" },
    ] }));
    const daemon = await harness(rootDir, { approvalsPath, retirementsPath, settingsStore: { getLocalToolPermission: () => "ask" } });
    const args = {
      approvalId: "approval-1",
      describes: { action: "run-command", target: "npm test" },
      terminalsFolder: join(rootDir, "terminals"),
    };
    assert.equal(await daemon.options().isLocalUseBlocked?.(args as never), undefined);
    assert.equal(await daemon.options().isLocalUseBlocked?.({ ...args, describes: { action: "run-command", target: "rm -rf /" } } as never), SLATE_LOCAL_TOOLS_UNAPPROVED_MESSAGE);
    assert.equal(await daemon.options().isLocalUseBlocked?.({ approvalId: "approval-1", terminalsFolder: args.terminalsFolder } as never), SLATE_LOCAL_TOOLS_UNAPPROVED_MESSAGE);
    assert.equal(await daemon.options().isLocalUseBlocked?.({
      approvalId: "terminal-approval",
      describes: { action: "run-command", target: "a different command", attachToResourcePath: args.terminalsFolder },
      terminalsFolder: args.terminalsFolder,
    } as never), undefined);
  });
});

test("approval retirement persists and removes the approval from future checks", async () => {
  await withRoot(async (rootDir) => {
    const approvalsPath = join(rootDir, "approvals.json");
    const retirementsPath = join(rootDir, "retirements.json");
    writeFileSync(approvalsPath, JSON.stringify({ approvals: [{ id: "approval-1", action: "run-command", target: "npm test" }] }));
    const daemon = await harness(rootDir, { approvalsPath, retirementsPath, settingsStore: { getLocalToolPermission: () => "ask" } });
    await daemon.options().onApprovalRetired?.("approval-1");
    const check = await daemon.options().isLocalUseBlocked?.({
      approvalId: "approval-1",
      describes: { action: "run-command", target: "npm test" },
      terminalsFolder: join(rootDir, "terminals"),
    } as never);
    assert.equal(check, SLATE_LOCAL_TOOLS_UNAPPROVED_MESSAGE);
  });
});
