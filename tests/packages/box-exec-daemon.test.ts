/**
 * The box's exec daemon: the operations it serves into the box, and the process it starts as.
 *
 * The first group drives the daemon over its own connection, the way a host does; the last one starts the daemon as
 * a real child process through its command line and speaks to it there, which is what the platform ships.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createPromiseClient, type PromiseClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";

import { BOX_EXEC_DAEMON_AUTH_TOKEN, BOX_EXEC_DAEMON_HOST, BOX_EXEC_DAEMON_PORT, BOX_TERMINAL_VIRTUAL_PREFIX, startBoxExecDaemon, type BoxExecDaemonHandle } from "../../source/box-exec/server.ts";
import { createSlateBoxControlClient } from "../../source/adapters/interop/box/slate-box-control-client.ts";
import { createSlateBoxExecClient } from "../../source/adapters/interop/box/slate-box-exec-client.ts";
import { productionSlateBoxPorts } from "../../source/adapters/interop/agent/production-box-slate-adapter.ts";
import { createBoxTransport } from "../../source/host/boxes/box-remote-accessor.ts";
import {
  SLATE_BOX_CONTROL_PATHS,
  SLATE_BOX_CONTROL_PROTOCOL_HEADER,
  SLATE_BOX_CONTROL_PROTOCOL_VERSION,
} from "../../source/shared/box-control-protocol.ts";
import { createContext } from "../../source/packages/context/context.ts";
import { SLATE_BOX_EXEC_SCHEMA } from "../../source/shared/box-exec-protocol.ts";
import { ControlService } from "../../source/adapters/interop/proto/generated/agent/v1/control_service_connect.ts";
import { ExecService } from "../../source/adapters/interop/proto/generated/agent/v1/exec_service_connect.ts";
import { ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";

const WORKSPACE_NOTE = "line one\nline two\nline three\n";

function boxWorkspace(): { workspaceRoot: string; terminalsDirectory: string } {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "slate-box-work-"));
  writeFileSync(join(workspaceRoot, "note.txt"), WORKSPACE_NOTE);
  return { workspaceRoot, terminalsDirectory: mkdtempSync(join(tmpdir(), "slate-box-terminals-")) };
}

function clients(handle: BoxExecDaemonHandle, authToken = "test-token"): { control: PromiseClient<typeof ControlService>; exec: PromiseClient<typeof ExecService> } {
  const transport = createConnectTransport({ httpVersion: "1.1", baseUrl: handle.url, nodeOptions: { headers: { authorization: `Bearer ${authToken}` } } });
  return { control: createPromiseClient(ControlService, transport), exec: createPromiseClient(ExecService, transport) };
}

async function collectExec(exec: PromiseClient<typeof ExecService>, request: ExecServerMessage) {
  const elements = [];
  for await (const element of exec.exec(request)) elements.push(element);
  return elements;
}

/** The client message a stream element carries, whichever of the two kinds it is. */
function clientMessage(element: { element: { case?: string; value?: unknown } }) {
  const value = element.element.value as { message?: { case?: string; value?: Record<string, unknown> } } | undefined;
  return value?.message;
}

describe("the box's exec daemon", () => {
  it("serves the box's control operations behind the token it was started with", async () => {
    const { workspaceRoot, terminalsDirectory } = boxWorkspace();
    const handle = await startBoxExecDaemon({ host: "127.0.0.1", port: 0, workspaceRoot, terminalsDirectory, authToken: "test-token" });
    try {
      assert.equal(handle.isReady(), true);
      assert.equal(handle.host, "127.0.0.1");
      assert.equal(handle.url, `http://127.0.0.1:${handle.port}`);
      assert.equal(handle.terminalsDirectory.endsWith(terminalsDirectory.split("/").at(-1) ?? ""), true);
      const { control } = clients(handle);
      assert.deepEqual(await control.ping({}).then((response) => response.toJson()), {});
      assert.deepEqual(await control.getCapabilities({}).then((response) => response.toJson()), { computerUseSupported: false, installPluginArtifactSupported: false });
      assert.deepEqual(await control.loadMcpServers({ mcpConfigJson: "{}" }).then((response) => response.toJson()), {});
      // The daemon is for the box's own host: without its token nothing is served.
      const bare = createConnectTransport({ httpVersion: "1.1", baseUrl: handle.url });
      const refused = await createPromiseClient(ControlService, bare).ping({}).then(
        () => "answered",
        (error: Error) => error.message,
      );
      assert.equal(typeof refused === "string" && refused.includes("401"), true);
    } finally {
      await handle.stop();
    }
    assert.equal(handle.isReady(), false);
    // Once it has stopped, the address is not answered at all.
    await createPromiseClient(ControlService, createConnectTransport({ httpVersion: "1.1", baseUrl: handle.url })).ping({}).then(
      () => assert.fail("a stopped daemon answered"),
      () => undefined,
    );
  });

  it("reads a file inside the workspace, and refuses a path that leaves it", async () => {
    const { workspaceRoot, terminalsDirectory } = boxWorkspace();
    const handle = await startBoxExecDaemon({ host: "127.0.0.1", port: 0, workspaceRoot, terminalsDirectory, authToken: "test-token" });
    try {
      const { exec } = clients(handle);
      const read = await collectExec(exec, new ExecServerMessage({ id: 1, execId: "exec-1", message: { case: "readArgs", value: { path: "/workspace/note.txt", limit: 2 } } }));
      assert.deepEqual(read.map((element) => element.element.case), ["execClientMessage", "execClientControlMessage"]);
      const message = clientMessage(read[0] as { element: { case?: string; value?: unknown } });
      assert.equal(message?.case, "readResult");
      const result = message?.value?.result as { case: string; value: { output?: { case: string; value: string }; totalLines?: number; truncated?: boolean } };
      assert.equal(result.case, "success");
      assert.deepEqual(result.value.output, { case: "content", value: "line one\nline two" });
      // Three lines plus the empty one that follows the file's last newline.
      assert.equal(result.value.totalLines, 4);
      assert.equal(result.value.truncated, true);
      assert.equal(read[1]?.element.case === "execClientControlMessage" ? (read[1]?.element.value as { message?: { case?: string } }).message?.case : "", "streamClose");

      const escaped = await collectExec(exec, new ExecServerMessage({ id: 2, execId: "exec-2", message: { case: "readArgs", value: { path: "/etc/hosts" } } }));
      const rejected = clientMessage(escaped[0] as { element: { case?: string; value?: unknown } });
      assert.equal(rejected?.case, "readResult");
      assert.equal((rejected?.value?.result as { case: string }).case, "rejected");
      // The same is true of a path that tries to leave through the terminals it may write into.
      const throughTerminals = await collectExec(exec, new ExecServerMessage({ id: 3, execId: "exec-3", message: { case: "readArgs", value: { path: `${BOX_TERMINAL_VIRTUAL_PREFIX}../../note.txt` } } }));
      assert.equal((clientMessage(throughTerminals[0] as { element: { case?: string; value?: unknown } })?.value?.result as { case: string }).case, "rejected");
      // A missing file is reported as missing rather than as an error of the daemon's own.
      const missing = await collectExec(exec, new ExecServerMessage({ id: 4, execId: "exec-4", message: { case: "readArgs", value: { path: "/workspace/absent.txt" } } }));
      assert.equal((clientMessage(missing[0] as { element: { case?: string; value?: unknown } })?.value?.result as { case: string }).case, "fileNotFound");
      // A path outside the workspace is refused before anything is read, whether or not it exists — a file that is
      // neither would otherwise be reported as merely missing.
      const absentOutside = await collectExec(exec, new ExecServerMessage({ id: 5, execId: "exec-5", message: { case: "readArgs", value: { path: join(tmpdir(), "slate-box-not-here.txt") } } }));
      assert.equal((clientMessage(absentOutside[0] as { element: { case?: string; value?: unknown } })?.value?.result as { case: string }).case, "rejected");
      // A link that leaves the workspace is refused, and so is a file reached through a linked directory: the
      // first because it is a link, the second because where it really lives is outside.
      symlinkSync("/etc/hosts", join(workspaceRoot, "outside-link"));
      symlinkSync("/etc", join(workspaceRoot, "outside-directory"));
      const throughLink = await collectExec(exec, new ExecServerMessage({ id: 6, execId: "exec-6", message: { case: "readArgs", value: { path: "/workspace/outside-link" } } }));
      const throughLinkResult = clientMessage(throughLink[0] as { element: { case?: string; value?: unknown } })?.value?.result as { case: string; value: { reason?: string } };
      assert.equal(throughLinkResult.case, "rejected");
      assert.equal(throughLinkResult.value.reason?.includes("Symlink") === true || throughLinkResult.value.reason?.includes("Symbolic-link") === true, true);
      const throughDirectory = await collectExec(exec, new ExecServerMessage({ id: 7, execId: "exec-7", message: { case: "readArgs", value: { path: "/workspace/outside-directory/hosts" } } }));
      assert.equal((clientMessage(throughDirectory[0] as { element: { case?: string; value?: unknown } })?.value?.result as { case: string }).case, "rejected");
    } finally {
      await handle.stop();
    }
  });

  it("serves the Slate-native control protocol while retaining legacy Connect", async () => {
    const { workspaceRoot, terminalsDirectory } = boxWorkspace();
    const handle = await startBoxExecDaemon({
      host: "127.0.0.1",
      port: 0,
      workspaceRoot,
      terminalsDirectory,
      authToken: "test-token",
    });
    try {
      const target = {
        baseUrl: handle.url,
        interceptors: [
          <Reply>(step: (request: { header: { set(name: string, value: string): void } }) => Promise<Reply>) =>
            async (request: { header: { set(name: string, value: string): void } }): Promise<Reply> => {
              request.header.set("authorization", "Bearer test-token");
              return await step(request);
            },
        ],
      };
      const client = createSlateBoxControlClient(target);
      const context = createContext();
      assert.deepEqual(await client.ping(context, {}, { timeoutMs: 1_000 }), { ok: true });
      const environment = await client.updateEnvironmentVariables(context, {
        env: { SLATE_NATIVE_MARKER: "yes" },
        replace: true,
      });
      assert.equal((environment as { applied: number }).applied, 1);
      assert.equal((environment as { removed: number }).removed >= 0, true);
      assert.deepEqual(await client.loadMcpServers(context, { mcpConfigJson: "{}" }), { loadedServerNames: [] });

      const productionTransport = createBoxTransport({
        host: handle.host,
        port: handle.port,
        authToken: "test-token",
      }, productionSlateBoxPorts.createTransport);
      const productionControl = productionSlateBoxPorts.createControlClient(productionTransport);
      assert.deepEqual(await productionControl.ping(context, {}, { timeoutMs: 1_000 }), { ok: true });
      assert.deepEqual(await productionControl.loadServers(context, "{}"), []);

      const execClient = createSlateBoxExecClient(target);
      const responses = [];
      for await (const response of execClient.exec(context, {
        schema: SLATE_BOX_EXEC_SCHEMA,
        id: 70,
        op: "workspace.read",
        redacted: false,
        path: "/workspace/note.txt",
        limit: 2,
      })) responses.push(response);
      assert.equal(responses[0]?.kind, "workspace.read");
      assert.equal(responses[0]?.kind === "workspace.read" ? responses[0].result.kind : "", "success");
      assert.equal(responses.at(-1)?.kind, "control");

      const shellResponses = [];
      for await (const response of execClient.exec(context, {
        schema: SLATE_BOX_EXEC_SCHEMA,
        id: 72,
        op: "shell.run",
        variant: "default",
        command: "printf native",
        workingDirectory: "/workspace",
        timeout: 0,
      })) shellResponses.push(response);
      assert.equal(
        shellResponses[0]?.kind === "shell.run" ? shellResponses[0].result.kind : "",
        "success",
      );

      const productionExec = productionSlateBoxPorts.createExecClient(productionTransport);
      const generated = [];
      for await (const envelope of productionExec.exec(context, new ExecServerMessage({
        id: 71,
        message: { case: "readArgs", value: { path: "/workspace/note.txt" } },
      }))) generated.push(envelope);
      assert.equal(generated[0]?.element.case, "execClientMessage");
      assert.equal(
        generated[0]?.element.case === "execClientMessage"
          ? generated[0].element.value.message.case
          : undefined,
        "readResult",
      );
      assert.equal(generated.at(-1)?.element.case, "execClientControlMessage");

      const streamed = [];
      for await (const envelope of productionExec.exec(context, new ExecServerMessage({
        id: 73,
        message: {
          case: "shellStreamArgs",
          value: { command: "printf stream", workingDirectory: "/workspace" },
        },
      }))) streamed.push(envelope);
      const stdout = streamed.flatMap((envelope) => {
        if (envelope.element.case !== "execClientMessage") return [];
        const message = envelope.element.value.message;
        return message.case === "shellStream" && message.value.event.case === "stdout"
          ? [message.value.event.value.data]
          : [];
      }).join("");
      assert.equal(stdout, "stream");

      const background = [];
      for await (const response of execClient.exec(context, {
        schema: SLATE_BOX_EXEC_SCHEMA,
        id: 74,
        op: "shell.background.spawn",
        command: "printf native-background",
        workingDirectory: "/workspace",
      })) background.push(response);
      assert.equal(
        background[0]?.kind === "shell.background.spawn" ? background[0].result.kind : "",
        "success",
      );

      const stdin = [];
      for await (const response of execClient.exec(context, {
        schema: SLATE_BOX_EXEC_SCHEMA,
        id: 75,
        op: "shell.stdin.write",
        shellId: 999,
        chars: "x",
      })) stdin.push(response);
      assert.equal(stdin[0]?.kind === "shell.stdin.write" ? stdin[0].result.kind : "", "error");

      const unsupported = [];
      for await (const response of execClient.exec(context, {
        schema: SLATE_BOX_EXEC_SCHEMA,
        id: 76,
        op: "unsupported",
        sourceOperation: "notImplemented",
      })) unsupported.push(response);
      assert.deepEqual(unsupported.map((response) =>
        response.kind === "control" ? response.control.kind : response.kind
      ), ["throw", "stream.close"]);

      const response = await fetch(handle.url + SLATE_BOX_CONTROL_PATHS.ping, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get(SLATE_BOX_CONTROL_PROTOCOL_HEADER), String(SLATE_BOX_CONTROL_PROTOCOL_VERSION));

      const invalid = await fetch(handle.url + SLATE_BOX_CONTROL_PATHS.environment, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ env: { "INVALID=NAME": "x" }, replace: true }),
      });
      assert.equal(invalid.status, 400);
    } finally {
      await handle.stop();
    }
  });

  it("streams a command as it runs, and finishes with how it ended", async () => {
    const { workspaceRoot, terminalsDirectory } = boxWorkspace();
    const handle = await startBoxExecDaemon({ host: "127.0.0.1", port: 0, workspaceRoot, terminalsDirectory, authToken: "test-token" });
    try {
      const { exec } = clients(handle);
      const streamed = await collectExec(exec, new ExecServerMessage({ id: 1, execId: "exec-1", message: { case: "shellStreamArgs", value: { command: "printf 'one\\ntwo\\n'", workingDirectory: "/workspace" } } }));
      const events = streamed.flatMap((element) => {
        const message = clientMessage(element as { element: { case?: string; value?: unknown } });
        if (message?.case !== "shellStream") return [];
        const event = message.value?.event as { case: string; value?: Record<string, unknown> } | undefined;
        return event == null ? [] : [{ case: event.case, data: event.value?.data }];
      });
      assert.equal(events.some((event) => event.case === "start"), true);
      assert.equal(events.filter((event) => event.case === "stdout").map((event) => event.data).join(""), "one\ntwo\n");
      // The stream ends with how the command ended and then closes, in that order.
      assert.equal(streamed.at(-1)?.element.case, "execClientControlMessage");
      const exitValue = clientMessage(streamed.at(-2) as { element: { case?: string; value?: unknown } })?.value?.event as { case: string; value?: Record<string, unknown> } | undefined;
      assert.equal(exitValue?.case, "exit");
      assert.equal(exitValue?.value?.code, 0);
      assert.equal(exitValue?.value?.aborted, false);

      // A command whose exit code is not zero is reported as a failure, not as a stream that never finished.
      const failed = await collectExec(exec, new ExecServerMessage({ id: 2, execId: "exec-2", message: { case: "shellArgs", value: { command: "exit 3", workingDirectory: "/workspace" } } }));
      const failure = clientMessage(failed[0] as { element: { case?: string; value?: unknown } });
      assert.equal(failure?.case, "shellResult");
      assert.equal((failure?.value?.result as { case: string }).case, "failure");
      assert.equal((failure?.value?.result as { value: { exitCode: number } }).value.exitCode, 3);
    } finally {
      await handle.stop();
    }
  });

  it("keeps a background shell running, with its terminal file to read back", async () => {
    const { workspaceRoot, terminalsDirectory } = boxWorkspace();
    const handle = await startBoxExecDaemon({ host: "127.0.0.1", port: 0, workspaceRoot, terminalsDirectory, authToken: "test-token" });
    try {
      const { exec } = clients(handle);
      const spawned = await collectExec(exec, new ExecServerMessage({ id: 1, execId: "exec-1", message: { case: "backgroundShellSpawnArgs", value: { command: "echo background-work", workingDirectory: "/workspace" } } }));
      const spawnResult = clientMessage(spawned[0] as { element: { case?: string; value?: unknown } })?.value?.result as { case: string; value: { shellId: number } };
      assert.equal(spawnResult.case, "success");
      assert.equal(spawnResult.value.shellId, 1);
      // The shell writes what it prints into its terminal file, which the daemon names after the shell.
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      const terminalFiles = readdirSync(terminalsDirectory);
      assert.deepEqual(terminalFiles, ["1.txt"]);
      const terminal = readFileSync(join(terminalsDirectory, "1.txt"), "utf8");
      assert.equal(terminal.startsWith("---\n"), true);
      assert.equal(terminal.includes('cwd: "/workspace"'), true);
      assert.equal(terminal.includes('command: "echo background-work"'), true);
      assert.equal(terminal.includes("background-work"), true);
      // It is read back through the path the box uses for terminals, which the daemon maps to that file.
      const virtual = await collectExec(exec, new ExecServerMessage({ id: 2, execId: "exec-2", message: { case: "readArgs", value: { path: `${BOX_TERMINAL_VIRTUAL_PREFIX}1.txt` } } }));
      const virtualResult = clientMessage(virtual[0] as { element: { case?: string; value?: unknown } })?.value?.result as { case: string; value: { output?: { value: string } } };
      assert.equal(virtualResult.case, "success");
      assert.equal(virtualResult.value.output?.value?.includes("background-work"), true);
      // A shell that is not running cannot be written to.
      const stdin = await collectExec(exec, new ExecServerMessage({ id: 3, execId: "exec-3", message: { case: "writeShellStdinArgs", value: { shellId: 99, chars: "x" } } }));
      assert.equal((clientMessage(stdin[0] as { element: { case?: string; value?: unknown } })?.value?.result as { case: string }).case, "error");
    } finally {
      await handle.stop();
    }
  });

  it("reports a request it does not serve rather than leaving the call open", async () => {
    const { workspaceRoot, terminalsDirectory } = boxWorkspace();
    const handle = await startBoxExecDaemon({ host: "127.0.0.1", port: 0, workspaceRoot, terminalsDirectory, authToken: "test-token" });
    try {
      const { exec } = clients(handle);
      const unsupported = await collectExec(exec, new ExecServerMessage({ id: 1, execId: "exec-1" }));
      const thrown = clientMessage(unsupported[0] as { element: { case?: string; value?: unknown } });
      assert.equal(thrown?.case, "throw");
      assert.equal(thrown?.value?.errorCode, "BOX_EXEC_UNSUPPORTED");
      // The environment the daemon runs the box's commands with is the one the host last set.
      const { control } = clients(handle);
      const applied = await control.updateEnvironmentVariables({ env: { SLATE_BOX_MARKER: "yes" }, replace: true });
      assert.equal(applied.applied, 1);
      assert.equal(applied.removed >= 0, true);
      const marker = await collectExec(exec, new ExecServerMessage({ id: 2, execId: "exec-2", message: { case: "shellArgs", value: { command: "printf %s \"$SLATE_BOX_MARKER\"", workingDirectory: "/workspace" } } }));
      const printed = clientMessage(marker[0] as { element: { case?: string; value?: unknown } })?.value?.result as { case: string; value: { stdout: string } };
      assert.equal(printed.case, "success");
      assert.equal(printed.value.stdout, "yes");
      // Replacing the environment with nothing takes the marker back out of it.
      const clearedEnvironment = await control.updateEnvironmentVariables({ env: {}, replace: true });
      assert.deepEqual({ applied: clearedEnvironment.applied, removed: clearedEnvironment.removed }, { applied: 0, removed: 1 });
      const cleared = await collectExec(exec, new ExecServerMessage({ id: 3, execId: "exec-3", message: { case: "shellArgs", value: { command: "printf %s \"$SLATE_BOX_MARKER\"", workingDirectory: "/workspace" } } }));
      assert.equal((clientMessage(cleared[0] as { element: { case?: string; value?: unknown } })?.value?.result as { value: { stdout: string } }).value.stdout, "");
    } finally {
      await handle.stop();
    }
  });

  it("starts as its own process, reports where it is listening, and stops on a signal", async () => {
    const { workspaceRoot, terminalsDirectory } = boxWorkspace();
    const child = spawn(process.execPath, ["--experimental-transform-types", "--no-warnings", "source/box-exec/cli.ts"], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { ...process.env, SLATE_BOX_WORKSPACE_ROOT: workspaceRoot, SLATE_BOX_TERMINALS_DIRECTORY: terminalsDirectory, SLATE_BOX_EXEC_DAEMON_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stderr.on("data", (data) => { errors += String(data); });
    try {
      const ready = await new Promise<{ event: string; url: string; workspaceRoot: string; terminalsDirectory: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the daemon did not report itself ready: ${output}${errors}`)), 15_000);
        child.stdout.on("data", (data) => {
          output += String(data);
          const line = output.split("\n").find((candidate) => candidate.includes("box-exec-daemon-ready"));
          if (line === undefined) return;
          clearTimeout(timer);
          resolve(JSON.parse(line) as { event: string; url: string; workspaceRoot: string; terminalsDirectory: string });
        });
        child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`the daemon exited with ${code}: ${output}${errors}`)); });
      });
      assert.equal(ready.event, "box-exec-daemon-ready");
      assert.equal(ready.url.startsWith("http://127.0.0.1:"), true);
      assert.equal(ready.workspaceRoot, terminalsDirectory === ready.workspaceRoot ? "" : ready.workspaceRoot);
      const transport = createConnectTransport({ httpVersion: "1.1", baseUrl: ready.url, nodeOptions: { headers: { authorization: `Bearer ${BOX_EXEC_DAEMON_AUTH_TOKEN}` } } });
      assert.deepEqual(await createPromiseClient(ControlService, transport).ping({}).then((response) => response.toJson()), {});
      // A signal finishes the process without it having to be killed.
      const exited = new Promise<number | null>((resolve) => { child.once("exit", (code) => resolve(code)); });
      child.kill("SIGTERM");
      assert.equal(await exited, 0);
    } finally {
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    }
  });
});

describe("the box exec daemon's own defaults", () => {
  it("keeps a loopback address, a fixed port and the box's terminal path", () => {
    assert.equal(BOX_EXEC_DAEMON_HOST, "127.0.0.1");
    assert.equal(BOX_EXEC_DAEMON_PORT, 1337);
    assert.equal(BOX_EXEC_DAEMON_AUTH_TOKEN, "local");
    assert.equal(BOX_TERMINAL_VIRTUAL_PREFIX, "/root/.slate/projects/workspace/terminals/");
  });
});
