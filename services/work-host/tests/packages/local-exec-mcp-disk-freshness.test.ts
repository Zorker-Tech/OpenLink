/**
 * Keeping the MCP catalog fresh on access: path predicates, the per-server checks and the debounced scheduling.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isMcpDirectoryPath,
  parseMcpsPath,
  scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess,
} from "../../source/packages/local-exec/mcp-disk-freshness-on-access.ts";
import { createContext } from "../../source/packages/context/context.ts";

const server = (serverIdentifier: string, toolNames: string[]) => ({ serverIdentifier, tools: toolNames.map((toolName) => ({ toolName })) });

test("only paths inside the mcps layout are MCP directory paths", () => {
  assert.equal(isMcpDirectoryPath("/home/u/project/slate/mcps"), true);
  assert.equal(isMcpDirectoryPath("/home/u/project/slate/mcps/"), true);
  assert.equal(isMcpDirectoryPath("/home/u/project/slate/mcps/server-a"), true);
  assert.equal(isMcpDirectoryPath("C:\\Users\\u\\project\\mcps\\server-a"), true);
  assert.equal(isMcpDirectoryPath("/home/u/project/slate/mcpsx"), false);
  assert.equal(isMcpDirectoryPath("/home/u/project"), false);
  assert.equal(isMcpDirectoryPath(undefined), false);
});

test("an mcps path is split into its project and optional server folder", () => {
  assert.deepEqual(parseMcpsPath("/home/u/project/slate/mcps"), { projectDir: "/home/u/project/slate", kind: "mcps_root" });
  assert.deepEqual(parseMcpsPath("/home/u/project/slate/mcps/"), { projectDir: "/home/u/project/slate", kind: "mcps_root" });
  assert.deepEqual(parseMcpsPath("/home/u/project/slate/mcps/server-a"), { projectDir: "/home/u/project/slate", kind: "server", sanitizedServerFolder: "server-a" });
  assert.deepEqual(parseMcpsPath("/home/u/project/slate/mcps/server-a/tools/x"), { projectDir: "/home/u/project/slate", kind: "server", sanitizedServerFolder: "server-a" });
  assert.deepEqual(parseMcpsPath("/home/u/project/slate/mcps/a/b"), { projectDir: "/home/u/project/slate", kind: "server", sanitizedServerFolder: "a" });
  assert.equal(parseMcpsPath("/mcps/root"), undefined);
  assert.equal(parseMcpsPath("/home/u/project/slate"), undefined);
});

type Timer = { callback: () => void; cleared: boolean };
function captureTimers() {
  const savedSetTimeout = globalThis.setTimeout;
  const savedClearTimeout = globalThis.clearTimeout;
  const timers: Timer[] = [];
  const cleared: Timer[] = [];
  globalThis.setTimeout = ((callback: () => void) => { const timer = { callback, cleared: false }; timers.push(timer); return timer as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: unknown) => { const timer = handle as Timer; timer.cleared = true; cleared.push(timer); }) as typeof clearTimeout;
  return {
    timers,
    cleared,
    get scheduledCount() { return timers.length; },
    restore() { globalThis.setTimeout = savedSetTimeout; globalThis.clearTimeout = savedClearTimeout; },
    async flush(): Promise<void> { for (const timer of timers.splice(0)) if (!timer.cleared) timer.callback(); await new Promise((resolve) => savedSetTimeout(resolve, 10)); },
  };
}
function harness(servers: unknown[], disk: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  const logs: string[] = [];
  const savedWarn = console.warn;
  console.warn = (...args: unknown[]) => { logs.push(args.map((value) => String(value)).join(" ")); };
  const accessor = {
    async getState() { calls.push(["getState"]); if (options.stateThrows === true) throw new Error("state failed"); return { servers }; },
  };
  const reader = async (projectDir: unknown, serverIdentifier: unknown) => {
    calls.push(["read", projectDir, serverIdentifier]);
    if (options.readThrows === true) throw Object.assign(new Error("read failed"), { name: "ReadError" });
    return (disk[serverIdentifier as string] as Record<string, unknown> | undefined) ?? { toolsDirExists: true, toolNames: [] };
  };
  return { calls, logs, accessor, reader, restore() { console.warn = savedWarn; } };
}

test("access to the mcps root checks every server in the state", async () => {
  const timers = captureTimers();
  const built = harness([server("alpha", ["a1", "a2"]), server("Beta!", ["b1"])], {
    alpha: { toolsDirExists: true, toolNames: ["a1", "a2"] },
    "Beta!": { toolsDirExists: true, toolNames: ["b1", "b2"] },
  });
  try {
    scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess(createContext(), built.accessor as never, "/proj/slate/mcps", built.reader as never);
    assert.equal(timers.scheduledCount, 1);
    await timers.flush();
    assert.deepEqual(built.calls, [["getState"], ["read", "/proj/slate", "alpha"], ["read", "/proj/slate", "Beta!"]]);
    assert.equal(built.logs.length, 1);
    assert.match(built.logs[0]!, / mcp_disk_discovery_freshness_mismatch meta=/);
    assert.match(built.logs[0]!, /extra_tool_count: 1/);
  } finally {
    built.restore();
    timers.restore();
  }
});

test("access to one server folder checks only that server", async () => {
  const timers = captureTimers();
  const built = harness([server("alpha", ["a1"])], { alpha: { toolsDirExists: true, toolNames: ["a1"] } });
  try {
    scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess(createContext(), built.accessor as never, "/proj/slate/mcps/alpha", built.reader as never);
    await timers.flush();
    assert.deepEqual(built.calls, [["getState"], ["read", "/proj/slate", "alpha"]]);
    assert.deepEqual(built.logs, []);
  } finally {
    built.restore();
    timers.restore();
  }
});

test("a state read or catalog read failure is logged and does not throw", async () => {
  for (const options of [{ stateThrows: true }, { readThrows: true }]) {
    const timers = captureTimers();
    const built = harness([server("alpha", [])], {}, options);
    try {
      scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess(createContext(), built.accessor as never, "/proj/slate/mcps/alpha", built.reader as never);
      await timers.flush();
      assert.equal(built.logs.length, 1);
      assert.match(built.logs[0]!, options.stateThrows === true ? / mcp_disk_state_read_failed meta=/ : / mcp_disk_catalog_read_failed meta=/);
    } finally {
      built.restore();
      timers.restore();
    }
  }
});

test("a missing tools directory and a missing server stop quietly", async () => {
  const timers = captureTimers();
  const built = harness([server("alpha", [])], { alpha: { toolsDirExists: false, toolNames: [] } });
  try {
    scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess(createContext(), built.accessor as never, "/proj/slate/mcps/alpha", built.reader as never);
    await timers.flush();
    assert.deepEqual(built.logs, []);
    const other = harness([server("other", [])]);
    try {
      scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess(createContext(), other.accessor as never, "/proj/slate/mcps/alpha", other.reader as never);
      await timers.flush();
      assert.deepEqual(other.logs, []);
      assert.deepEqual(other.calls, [["getState"]]);
    } finally {
      other.restore();
    }
  } finally {
    built.restore();
    timers.restore();
  }
});

test("a sweep that fails while reading state is logged as a schedule failure", async () => {
  const timers = captureTimers();
  const built = harness([server("alpha", [])], {}, { stateThrows: true });
  try {
    scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess(createContext(), built.accessor as never, "/proj/slate/mcps", built.reader as never);
    await timers.flush();
    assert.equal(built.logs.length, 1);
    assert.match(built.logs[0]!, / mcp_disk_discovery_freshness_schedule_failed meta=/);
  } finally {
    built.restore();
    timers.restore();
  }
});

test("a non-mcp or missing path schedules nothing", () => {
  const timers = captureTimers();
  const built = harness([]);
  try {
    scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess(createContext(), built.accessor as never, "/proj/slate/other", built.reader as never);
    scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess(createContext(), built.accessor as never, undefined, built.reader as never);
    assert.equal(timers.timers.length, 0);
    assert.deepEqual(built.calls, []);
  } finally {
    built.restore();
    timers.restore();
  }
});

test("a burst of accesses keeps one debounced check", async () => {
  const timers = captureTimers();
  const built = harness([server("alpha", ["a1"])], { alpha: { toolsDirExists: true, toolNames: ["a1"] } });
  try {
    scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess(createContext(), built.accessor as never, "/proj/slate/mcps/alpha", built.reader as never);
    scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess(createContext(), built.accessor as never, "/proj/slate/mcps/alpha", built.reader as never);
    assert.equal(timers.scheduledCount, 2);
    assert.equal(timers.cleared.length, 1);
    await timers.flush();
    assert.deepEqual(built.calls, [["getState"], ["read", "/proj/slate", "alpha"]]);
  } finally {
    built.restore();
    timers.restore();
  }
});
