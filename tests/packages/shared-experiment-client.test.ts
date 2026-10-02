/**
 * Slate's own experiment client: what it reads out of a bootstrap config, what it answers when the config says nothing,
 * when it logs an exposure, and what a flush does — including when it is rejected or the client is already closed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gunzipSync } from "node:zlib";

import { SlateExperimentClient, SlateLogEventCompressionMode } from "../../source/shared/node/experiments/slate-experiment-client.ts";
import { DYNAMIC_CONFIGS, EXPERIMENTS, FLAGS } from "../../source/shared/node/experiments/experiment-config.gen.ts";

const CONFIG = JSON.stringify({
  user: { userID: "user-1", custom: "carried" },
  feature_gates: { on_gate: { value: true }, off_gate: { value: false }, truthy_gate: { value: "yes" }, odd_gate: "not an object" },
  dynamic_configs: {
    a_config: { value: { a: 1 }, group_name: "arm-a" },
    bare_config: { value: {} },
    odd_config: { value: "not an object" },
  },
  experiments: { an_experiment: { value: { enabled: true }, group_name: "treatment" }, unnamed_arm: { value: {}, group_name: "" } },
});

function recorder(status = 200) {
  const calls: Array<{ url: string; args: RequestInit }> = [];
  return {
    calls,
    override: async (url: string, args: RequestInit) => {
      calls.push({ url, args });
      return new Response("{}", { status });
    },
  };
}

function clientFor(network = recorder(), options: { compression?: boolean } = {}) {
  const client = new SlateExperimentClient("slate-work-host", { userID: "user-1" }, {
    loggingEnabled: "always",
    disableStorage: true,
    ...(options.compression === true ? { logEventCompressionMode: SlateLogEventCompressionMode.Forced } : {}),
    networkConfig: { api: "https://experiments.slate.invalid/log", networkOverrideFunc: network.override },
  });
  client.dataAdapter.setData(CONFIG);
  client.initializeSync();
  return { client, network };
}

describe("what the experiment client reads", () => {
  it("answers gates, experiments and configs from the config it was handed", () => {
    const { client } = clientFor();
    assert.deepEqual(
      [client.checkGate("on_gate"), client.checkGate("off_gate"), client.checkGate("truthy_gate"), client.checkGate("odd_gate"), client.checkGate("never_heard_of_it")],
      [true, false, false, false, false],
    );
    assert.deepEqual(client.getDynamicConfig("a_config"), { name: "a_config", value: { a: 1 } });
    assert.deepEqual(client.getDynamicConfig("bare_config"), { name: "bare_config", value: {} });
    assert.deepEqual(client.getDynamicConfig("odd_config"), { name: "odd_config", value: {} });
    assert.deepEqual(client.getDynamicConfig("never_heard_of_it"), { name: "never_heard_of_it", value: {} });
    assert.deepEqual(client.getExperiment("an_experiment", { disableExposureLog: true }), { name: "an_experiment", value: { enabled: true }, groupName: "treatment" });
    // An experiment that is only a dynamic config reads from there, and an empty arm is no arm.
    assert.deepEqual(client.getExperiment("a_config", { disableExposureLog: true }), { name: "a_config", value: { a: 1 }, groupName: "arm-a" });
    assert.deepEqual(client.getExperiment("unnamed_arm", { disableExposureLog: true }), { name: "unnamed_arm", value: {}, groupName: null });
    assert.deepEqual(client.getExperiment("never_heard_of_it", { disableExposureLog: true }), { name: "never_heard_of_it", value: {}, groupName: null });
  });

  it("answers with the platform's bundled values for what the config does not mention", () => {
    const client = new SlateExperimentClient("slate-work-host", {}, {});
    client.dataAdapter.setData(JSON.stringify({ feature_gates: { slate_browser_use_subagent: { value: true } } }));
    assert.deepEqual(
      [client.checkGate("slate_browser_use_subagent"), client.checkGate("slate_computer_use_playwright")],
      [true, FLAGS.slate_computer_use_playwright.default],
    );
    assert.deepEqual(client.getDynamicConfig("slate_default_model").value, DYNAMIC_CONFIGS.slate_default_model.fallbackValues);
    assert.deepEqual(client.getExperiment("slate_model_selection", { disableExposureLog: true }).value, EXPERIMENTS.slate_model_selection.fallbackValues);
  });

  it("answers with nothing at all before a config, and replaces what it had when a new one comes", () => {
    const client = new SlateExperimentClient("slate-work-host", {}, {});
    assert.deepEqual([client.checkGate("on_gate"), client.getDynamicConfig("a_config").value, client.getExperiment("an_experiment").groupName], [false, {}, null]);
    client.dataAdapter.setData(CONFIG);
    assert.equal(client.checkGate("on_gate"), true);
    // A config that cannot be read is not an error: what was read before it is simply gone.
    client.dataAdapter.setData("{not json");
    assert.deepEqual([client.checkGate("on_gate"), client.getDynamicConfig("a_config").value], [false, {}]);
    client.dataAdapter.setData("[]");
    assert.equal(client.checkGate("on_gate"), false);
    client.dataAdapter.setData("null");
    assert.equal(client.checkGate("on_gate"), false);
  });
});

describe("what the experiment client sends", () => {
  it("logs an exposure only when it is asked to, and sends what it logged on the next flush", async () => {
    const { client, network } = clientFor();
    client.getExperiment("an_experiment", { disableExposureLog: true });
    client.getExperiment("never_heard_of_it");
    // Neither of those logged anything, so there is nothing for a flush to send.
    await client.flush();
    assert.deepEqual(network.calls.length, 0);
    client.getExperiment("an_experiment");
    await client.flush();
    assert.equal(network.calls.length, 1);
    const sent = network.calls[0];
    assert.deepEqual([sent?.url, sent?.args.method, (sent?.args.headers as Record<string, string>)["content-type"]], ["https://experiments.slate.invalid/log", "POST", "application/json"]);
    const body = JSON.parse(String(sent?.args.body)) as { key: string; user: { userID: string }; events: Array<Record<string, unknown>> };
    assert.deepEqual([body.key, body.user.userID], ["slate-work-host", "user-1"]);
    assert.deepEqual(body.events.map((event) => [event.event, event.experiment, event.group, event.userID]), [["experiment_exposure", "an_experiment", "treatment", "user-1"]]);
    assert.equal(typeof body.events[0]?.time, "number");
    // Nothing new to log means nothing to send.
    await client.flush();
    assert.equal(network.calls.length, 1);
  });

  it("carries the user it was told about last, and compresses when asked to", async () => {
    const network = recorder();
    const { client } = clientFor(network, { compression: true });
    client.updateUserSync({ userID: "user-2" });
    client.getExperiment("an_experiment");
    await client.flush();
    const sent = network.calls[0];
    assert.deepEqual((sent?.args.headers as Record<string, string>)["content-encoding"], "gzip");
    const body = JSON.parse(gunzipSync(sent?.args.body as Uint8Array).toString("utf8")) as { user: { userID: string }; events: Array<{ userID: string }> };
    assert.deepEqual([body.user.userID, body.events[0]?.userID], ["user-2", "user-2"]);
    // And the user the config itself carries replaces the one it was built with.
    const second = recorder();
    const carried = new SlateExperimentClient("slate-work-host", {}, { networkConfig: { api: "https://experiments.slate.invalid/log", networkOverrideFunc: second.override } });
    carried.dataAdapter.setData(CONFIG);
    carried.getExperiment("an_experiment");
    await carried.flush();
    assert.equal((JSON.parse(String(second.calls[0]?.args.body)) as { user: { userID: string } }).user.userID, "user-1");
  });

  it("treats a rejected log as an error, and sends nothing once it is closed", async () => {
    const rejected = clientFor(recorder(500));
    rejected.client.getExperiment("an_experiment");
    await assert.rejects(() => rejected.client.flush(), /status 500/);
    assert.equal(rejected.network.calls.length, 1);
    // What was tried is gone rather than queued forever, and closing stops everything.
    await rejected.client.flush();
    assert.equal(rejected.network.calls.length, 1);
    const { client, network } = clientFor();
    client.getExperiment("an_experiment");
    await client.shutdown();
    client.getExperiment("an_experiment");
    client.updateUserSync({ userID: "user-3" });
    client.initializeSync();
    await client.flush();
    assert.deepEqual([network.calls.length, client.checkGate("on_gate"), client.getDynamicConfig("a_config").value, client.getExperiment("an_experiment").value, client.getExperiment("an_experiment").groupName], [0, false, {}, {}, null]);
  });
});
