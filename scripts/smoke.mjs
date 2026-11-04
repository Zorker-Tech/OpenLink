/**
 * The platform's own process-level smoke check.
 *
 * It starts the daemons this repository builds, over the built output, and speaks to them the way the host does: the
 * box's exec daemon is asked whether it is there, the local-exec daemon is started and stopped. A daemon that cannot be
 * started, answered or stopped fails the check rather than being reported as fine.
 *
 * Run it after a build: `pnpm --filter @slate/work-host build && pnpm --filter @slate/work-host smoke`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(packageRoot, "dist");

/** A port nothing is listening on, taken by asking the system for one and letting it go again. */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function startProcess(entry, env, args = []) {
  const child = spawn(process.execPath, [entry, ...args], { cwd: packageRoot, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stdout.on("data", (data) => { output += String(data); });
  child.stderr.on("data", (data) => { errors += String(data); });
  return {
    child,
    get output() { return output; },
    get errors() { return errors; },
    exited: new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
    stop(signal = "SIGTERM") { if (child.exitCode == null && child.signalCode == null) child.kill(signal); },
  };
}

async function waitForReady(started, seconds = 15) {
  const deadline = Date.now() + seconds * 1_000;
  while (Date.now() < deadline) {
    const line = started.output.split("\n").find((candidate) => candidate.includes("box-exec-daemon-ready"));
    if (line !== undefined) return JSON.parse(line);
    if (started.child.exitCode != null || started.child.signalCode != null) throw new Error(`the box exec daemon exited before it was ready: ${started.output}${started.errors}`);
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  throw new Error(`the box exec daemon did not report itself ready: ${started.output}${started.errors}`);
}

async function hostProcess() {
  const port = await freePort();
  const dataRoot = mkdtempSync(join(tmpdir(), "slate-smoke-host-process-"));
  const discoveryPath = join(dataRoot, "gateway.json");
  const started = startProcess(join(dist, "host", "main.js"), {
    SLATE_DATA_ROOT: dataRoot,
    SLATE_HOST_PORT: String(port),
    SLATE_USE_EXISTING_BOX_EXEC_DAEMON: "1",
  });
  try {
    const deadline = Date.now() + 30_000;
    let discovery;
    while (Date.now() < deadline) {
      if (started.child.exitCode != null || started.child.signalCode != null) {
        throw new Error(`the Slate host exited before publishing its gateway: ${started.output}${started.errors}`);
      }
      try {
        discovery = JSON.parse(await readFile(discoveryPath, "utf8"));
        if (Number.isInteger(discovery.port) && discovery.host != null && discovery.scheme != null) break;
      } catch {
        // The host publishes discovery atomically once the gateway is listening.
      }
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    if (discovery == null || !Number.isInteger(discovery.port)) {
      throw new Error(`the Slate host did not publish gateway discovery: ${started.output}${started.errors}`);
    }

    const { SLATE_GATEWAY } = await import(join(dist, "shared", "gateway-wire.js"));
    const gatewayUrl = new URL(SLATE_GATEWAY.paths.health, `${discovery.scheme}://${discovery.host}:${discovery.port}`);
    const response = await fetch(gatewayUrl, {
      headers: discovery.token === undefined ? undefined : { authorization: `Bearer ${discovery.token}` },
    });
    if (!response.ok) throw new Error(`the Slate host health route returned HTTP ${response.status}`);
    const health = await response.json();
    if (health.ok !== true || health.pid !== started.child.pid) {
      throw new Error(`the Slate host returned an unexpected health response: ${JSON.stringify(health)}`);
    }

    started.stop();
    const exited = await Promise.race([started.exited, new Promise((resolve) => { setTimeout(() => resolve("timeout"), 15_000); })]);
    if (exited === "timeout") throw new Error(`the Slate host did not stop on SIGTERM: ${started.output}${started.errors}`);
    if (exited.code !== 0) throw new Error(`the Slate host exited with ${exited.code}: ${started.output}${started.errors}`);
    if (!started.output.includes("received SIGTERM, shutting down")) {
      throw new Error(`the Slate host did not report its shutdown: ${started.output}${started.errors}`);
    }
    if (existsSync(discoveryPath)) throw new Error("the Slate host left gateway discovery behind after shutdown");
    return `started pid ${started.child.pid}, health answered on ${gatewayUrl.pathname}, stopped cleanly`;
  } finally {
    started.stop("SIGKILL");
    if (started.child.exitCode == null && started.child.signalCode == null) {
      await Promise.race([started.exited, new Promise((resolve) => { setTimeout(resolve, 5_000); })]);
    }
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

async function agentStoreWorker() {
  const dataRoot = mkdtempSync(join(tmpdir(), "slate-smoke-agent-store-"));
  const { AgentWorkerPool } = await import(join(dist, "host", "agents", "isolation", "agent-worker-pool.js"));
  const pool = new AgentWorkerPool({ idleTimeoutMs: Number.POSITIVE_INFINITY });
  const blobDbPath = join(dataRoot, "conversation-blobs.db");
  const blobId = new Uint8Array([1, 4, 9]);
  const blobBytes = new Uint8Array([2, 5, 8, 13]);
  try {
    await pool.setBlob("smoke-agent", blobDbPath, blobId, blobBytes);
    const readBack = await pool.getBlob("smoke-agent", blobDbPath, blobId);
    if (readBack == null || Buffer.compare(Buffer.from(readBack), Buffer.from(blobBytes)) !== 0) {
      throw new Error("the built agent-store worker returned different blob bytes");
    }
    return "built worker opened its store, round-tripped a blob, and shut down";
  } finally {
    try {
      await pool.closeAll();
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  }
}

async function boxExecDaemon() {
  const port = await freePort();
  const started = startProcess(join(dist, "box-exec", "cli.js"), {
    SLATE_BOX_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), "slate-smoke-workspace-")),
    SLATE_BOX_TERMINALS_DIRECTORY: mkdtempSync(join(tmpdir(), "slate-smoke-terminals-")),
    SLATE_BOX_EXEC_DAEMON_PORT: String(port),
  });
  try {
    const ready = await waitForReady(started);
    // It answers the box's own control call, with the token it was started with.
    const { createPromiseClient } = await import("@connectrpc/connect");
    const { createConnectTransport } = await import("@connectrpc/connect-node");
    const { ControlService } = await import(join(dist, "adapters/interop/proto/generated/agent/v1/control_service_connect.js"));
    const transport = createConnectTransport({ httpVersion: "1.1", baseUrl: ready.url, nodeOptions: { headers: { authorization: "Bearer local" } } });
    const client = createPromiseClient(ControlService, transport);
    const capabilities = await client.getCapabilities({});
    const answered = { computerUseSupported: capabilities.computerUseSupported, installPluginArtifactSupported: capabilities.installPluginArtifactSupported };
    // And it stops when it is asked to, leaving the port free.
    started.stop();
    const stopped = await Promise.race([started.exited, new Promise((resolve) => { setTimeout(() => resolve("timeout"), 10_000); })]);
    if (stopped === "timeout") throw new Error(`the box exec daemon did not stop: ${started.errors}`);
    if (stopped.code !== 0) throw new Error(`the box exec daemon exited with ${stopped.code}: ${started.errors}`);
    const stillListening = await new Promise((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(true));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(false)));
    });
    if (stillListening) throw new Error(`the box exec daemon left ${ready.url} bound`);
    return `box exec daemon: ready at ${ready.url}, answered ${JSON.stringify(answered)}, stopped cleanly`;
  } finally {
    started.stop("SIGKILL");
  }
}

async function localExecDaemon() {
  // The daemon only runs when its own identity is bound: the token it was handed and the generation it was started for.
  const token = "smoke-generation";
  const started = startProcess(join(dist, "local-exec", "main.js"), {
    SLATE_ROOT_DIR: mkdtempSync(join(tmpdir(), "slate-smoke-host-")),
    SLATE_LOCAL_EXEC_GENERATION_TOKEN: token,
  }, [`--slate-local-exec-generation=${token}`]);
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !started.output.includes("[slate-local-exec-daemon] started")) {
      if (started.child.exitCode != null || started.child.signalCode != null) throw new Error(`the local-exec daemon exited with ${started.child.exitCode}: ${started.output}${started.errors}`);
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    if (!started.output.includes("[slate-local-exec-daemon] started")) throw new Error(`the local-exec daemon did not report itself started: ${started.output}${started.errors}`);
    // And it stops when it is asked to, saying so.
    started.stop();
    const exited = await Promise.race([started.exited, new Promise((resolve) => { setTimeout(() => resolve("timeout"), 10_000); })]);
    if (exited === "timeout") throw new Error(`the local-exec daemon did not stop: ${started.output}${started.errors}`);
    if (!started.output.includes("shutting down")) throw new Error(`the local-exec daemon did not say it was shutting down: ${started.output}${started.errors}`);
    return `local-exec daemon: started, served local exec, and shut down on a signal`;
  } finally {
    started.stop("SIGKILL");
  }
}

const checks = [["Slate host", hostProcess], ["agent-store worker", agentStoreWorker], ["box exec daemon", boxExecDaemon], ["local-exec daemon", localExecDaemon]];
let failed = 0;
for (const [name, check] of checks) {
  try {
    process.stdout.write(`ok   ${name}: ${await check()}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
process.exitCode = failed === 0 ? 0 : 1;
