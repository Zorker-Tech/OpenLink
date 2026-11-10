import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CombinedResourceAccessor,
  RegistryResourceAccessor,
  RemoteResourceAccessor,
  createResource,
  resourceEntry,
  type ResourceAccessor,
} from "../../source/packages/agent-exec/resource-provider.ts";

/** An implementation that says where it was built, so the test can tell the sides apart. */
type Say = { readonly from: string };

describe("naming an operation", () => {
  it("gives each resource its own symbol, even when two are built from the same functions", () => {
    const build = (manager: string): Say => ({ from: `remote:${manager}` });
    const register = () => {};
    const one = createResource<Say, string>(build, register);
    const two = createResource<Say, string>(build, register);
    assert.notEqual(one.symbol, two.symbol);
    assert.equal(one.remoteImplementation, build);
  });

  it("keeps the two sides apart: building the client side is not registering the host side", () => {
    const calls: string[] = [];
    const resource = createResource<Say, string>(
      () => {
        calls.push("remote");
        return { from: "remote" };
      },
      (_implementation, manager) => {
        calls.push(`controlled:${String(manager)}`);
      },
    );
    resource.remoteImplementation("exec-1");
    resource.registerControlledImplementation({ from: "local" }, "exec-9");
    assert.deepEqual(calls, ["remote", "controlled:exec-9"]);
  });

  it("pairs a resource with its local implementation", () => {
    const resource = createResource<Say, string>(() => ({ from: "remote" }), () => {});
    const local: Say = { from: "local" };
    assert.deepEqual(resourceEntry(resource, local), [resource, local]);
  });
});

describe("where a call runs", () => {
  it("is built over the manager that talks to the host", () => {
    const resource = createResource<Say, string>((manager) => ({ from: `remote:${manager}` }), () => {});
    const accessor = new RemoteResourceAccessor("exec-1");
    assert.deepEqual(accessor.get(resource), { from: "remote:exec-1" });
  });

  it("is found in the host's registry by the resource's own symbol", () => {
    const resource = createResource<Say, string>(() => ({ from: "remote" }), () => {});
    const registry = new RegistryResourceAccessor();
    assert.equal(registry.get(resource), undefined, "nothing is registered yet");
    const local: Say = { from: "local" };
    registry.register(resource, local);
    assert.equal(registry.get(resource), local);
  });

  it("keeps two resources of the same shape apart in the registry", () => {
    const build = (): Say => ({ from: "remote" });
    const register = () => {};
    const first = createResource<Say, string>(build, register);
    const second = createResource<Say, string>(build, register);
    const registry = new RegistryResourceAccessor();
    registry.register(first, { from: "first" });
    registry.register(second, { from: "second" });
    assert.deepEqual(registry.get(first), { from: "first" });
    assert.deepEqual(registry.get(second), { from: "second" });
    assert.equal(registry.entries().length, 2);
  });

  it("lists what the host registered in the order it was registered", () => {
    const first = createResource<Say, string>(() => ({ from: "remote" }), () => {});
    const second = createResource<Say, string>(() => ({ from: "remote" }), () => {});
    const registry = new RegistryResourceAccessor();
    registry.register(first, { from: "first" });
    registry.register(second, { from: "second" });
    assert.deepEqual(registry.entries().map(([resource, value]) => [resource.symbol === first.symbol ? "first" : "second", (value as Say).from]), [
      ["first", "first"],
      ["second", "second"],
    ]);
  });

  it("prefers the local implementation, and falls back to the remote one for anything not overridden", () => {
    const overridden = createResource<Say, string>(() => ({ from: "remote:overridden" }), () => {});
    const untouched = createResource<Say, string>(() => ({ from: "remote:untouched" }), () => {});
    const base = new RemoteResourceAccessor<string>("exec-1");
    const combined = new CombinedResourceAccessor<string>(base, [resourceEntry(overridden, { from: "local" })]);
    assert.deepEqual(combined.get(overridden), { from: "local" });
    assert.deepEqual(combined.get(untouched), { from: "remote:untouched" });
  });

  it("serves the same call site whether the implementation is local or remote", () => {
    const resource = createResource<Say, string>((manager) => ({ from: `remote:${manager}` }), () => {});
    // A caller that receives "an accessor" cannot tell which of the two it was handed.
    const remote: ResourceAccessor<string> = new RemoteResourceAccessor("exec-1");
    const local: ResourceAccessor<string> = new CombinedResourceAccessor(remote, [[resource, { from: "local" }]]);
    assert.deepEqual(remote.get(resource), { from: "remote:exec-1" });
    assert.deepEqual(local.get(resource), { from: "local" });
  });
});
