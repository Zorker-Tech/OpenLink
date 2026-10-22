import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SOCKET_ENV_VARS_TO_SCRUB,
  filterElectronEnv,
  scrubSocketEnvVars,
} from "../../source/packages/shell-exec/env-filter.ts";

describe("the environment a shell is given", () => {
  it("knows which session variables must not travel", () => {
    assert.deepEqual([...SOCKET_ENV_VARS_TO_SCRUB], ["SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "WAYLAND_DISPLAY"]);
  });

  it("drops the flag that would turn a shell into a node process", () => {
    assert.deepEqual(filterElectronEnv({ PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" }), { PATH: "/bin" });
    assert.deepEqual(filterElectronEnv({ ELECTRON_RUN_AS_NODE: "1" }), {});
    assert.deepEqual(filterElectronEnv({ PATH: "/bin" }), { PATH: "/bin" });
  });

  it("answers a new environment and leaves the given one alone", () => {
    const env = { PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" };
    const filtered = filterElectronEnv(env);
    assert.deepEqual(env, { PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" });
    assert.notEqual(filtered, env);
  });

  it("starts from the process's own environment for a missing or falsy one", () => {
    for (const given of [undefined, null, "", 0, false]) {
      const filtered = filterElectronEnv(given as never);
      assert.equal(Object.keys(filtered).length > 0, true, "the process's environment was not used: " + String(given));
    }
  });

  it("starts from the process's own environment when given none", () => {
    const saved = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = "1";
    try {
      const filtered = filterElectronEnv();
      assert.equal(Object.hasOwn(filtered, "ELECTRON_RUN_AS_NODE"), false);
    } finally {
      if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = saved;
    }
  });

  it("scrubs every session socket variable from a copy", () => {
    const env = {
      PATH: "/bin",
      SSH_AUTH_SOCK: "/tmp/agent",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/bus",
      XDG_RUNTIME_DIR: "/run/user/1",
      WAYLAND_DISPLAY: "wayland-0",
      SSH_AUTH_SOCKET: "/tmp/other",
    };
    const scrubbed = scrubSocketEnvVars(env);
    assert.deepEqual(scrubbed, { PATH: "/bin", SSH_AUTH_SOCKET: "/tmp/other" });
    assert.deepEqual(Object.keys(scrubbed), ["PATH", "SSH_AUTH_SOCKET"], "the remaining keys keep their order");
    assert.equal(Object.hasOwn(env, "SSH_AUTH_SOCK"), true, "the given environment is not changed");
    assert.notEqual(scrubbed, env);
  });

  it("keeps the keys that only look like the scrubbed ones", () => {
    assert.deepEqual(scrubSocketEnvVars({ SSH_AUTH: "x", WAYLAND: "y", DBUS_SESSION_BUS: "z" }), { SSH_AUTH: "x", WAYLAND: "y", DBUS_SESSION_BUS: "z" });
  });
});