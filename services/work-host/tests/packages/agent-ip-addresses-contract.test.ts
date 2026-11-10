import assert from "node:assert/strict"
import { test } from "node:test"

import { isLoopbackIpHost, isPrivateIpHost } from "../../source/packages/agent/utils/ip-addresses.ts"

test("loopback classification accepts IPv4, IPv6 and mapped loopback literals only", () => {
  for (const address of ["127.0.0.1", "127.255.255.254", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
    assert.equal(isLoopbackIpHost(address), true, address)
  }
  for (const address of ["8.8.8.8", "192.168.1.1", "::", "::ffff:8.8.8.8", "localhost", "127.0.0.999"]) {
    assert.equal(isLoopbackIpHost(address), false, address)
  }
})

test("private IPv4 ranges include local, private and link-local blocks with their edges", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "10.255.255.255",
    "127.0.0.1",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    "169.254.10.20",
  ]) {
    assert.equal(isPrivateIpHost(address), true, address)
  }
  for (const address of ["8.8.8.8", "172.15.255.255", "172.32.0.1", "192.167.255.255", "169.255.0.1"]) {
    assert.equal(isPrivateIpHost(address), false, address)
  }
})

test("private IPv6 prefixes and IPv4-mapped values use the same local-address policy", () => {
  for (const address of ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "::ffff:10.0.0.1", "::ffff:7f00:1"]) {
    assert.equal(isPrivateIpHost(address), true, address)
  }
  for (const address of ["2001:4860:4860::8888", "::ffff:8.8.8.8", "example.com", "fe80::not-hex", "fec0::1"]) {
    assert.equal(isPrivateIpHost(address), false, address)
  }
})
