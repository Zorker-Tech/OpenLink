import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  GetEffectiveUserPluginsRequest,
  GetEffectiveUserPluginsResponse,
  GetMeRequest,
  GetMeResponse,
} from "../../source/adapters/interop/proto/generated/aiserver/v1/dashboard_pb.ts";
import { adaptInstalledPluginDashboard } from "../../source/adapters/interop/plugin-marketplace/installed-plugin-dashboard-adapter.ts";
import { createSharedInstalledPluginsLoader } from "../../source/host/skills/plugin-skills-loader.ts";

test("the dashboard adapter constructs wire requests and returns Slate-owned projections", async () => {
  const calls: Array<{ method: string; request: unknown; timeoutMs: number }> = [];
  const listing = new GetEffectiveUserPluginsResponse({ plugins: [] });
  const user = new GetMeResponse({ userId: 37 });
  const dashboard = adaptInstalledPluginDashboard({
    async getEffectiveUserPlugins(request: GetEffectiveUserPluginsRequest, options: { timeoutMs: number }) {
      calls.push({ method: "list", request, timeoutMs: options.timeoutMs });
      return listing;
    },
    async getMe(request: GetMeRequest, options: { timeoutMs: number }) {
      calls.push({ method: "user", request, timeoutMs: options.timeoutMs });
      return user;
    },
  } as never);

  const plugins = await dashboard.listEffectivePlugins({ timeoutMs: 15_000 });
  const currentUser = await dashboard.readCurrentUser({ timeoutMs: 10_000 });

  assert.deepEqual(plugins, listing.toJson());
  assert.notEqual(plugins, listing, "the host receives a plain JSON projection, not a generated message");
  assert.deepEqual(currentUser, { userId: 37 });
  assert.equal(calls[0]?.request instanceof GetEffectiveUserPluginsRequest, true);
  assert.equal(calls[1]?.request instanceof GetMeRequest, true);
  assert.deepEqual(calls.map(({ method, timeoutMs }) => [method, timeoutMs]), [["list", 15_000], ["user", 10_000]]);
})

test("the plugin loader consumes the Slate dashboard port without constructing wire messages", async () => {
  const slateRootDir = mkdtempSync(join(tmpdir(), "slate-plugin-dashboard-port-"));
  const calls: Array<[string, number]> = [];
  try {
    const load = createSharedInstalledPluginsLoader({
      slateRootDir,
      auth: {
        getAccessToken: async () => "unused",
        getMachineId: async () => "machine",
        peekAccessToken: () => null,
      },
      isSparsePluginClonesEnabled: () => false,
      dashboardReaderForTesting: {
        listEffectivePlugins: async ({ timeoutMs }) => {
          calls.push(["list", timeoutMs]);
          return { plugins: [], marketplaces: [] };
        },
        readCurrentUser: async ({ timeoutMs }) => {
          calls.push(["user", timeoutMs]);
          return { userId: 37 };
        },
      },
      log: () => {},
    });

    const result = await load();
    assert.deepEqual(calls, [["list", 15_000], ["user", 10_000]]);
    assert.deepEqual(result, {
      plugins: [],
      authBlocked: [],
      listedPluginIds: [],
      listedCacheKeys: [],
      publisherFacts: new Map(),
      currentUserId: 37,
    });
  } finally {
    rmSync(slateRootDir, { recursive: true, force: true });
  }
})
