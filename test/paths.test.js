import assert from "node:assert/strict";
import test from "node:test";

import {
  bindHost,
  clientHost,
  hostForUrl,
  IPV6_LOOPBACK_HOST,
  LOOPBACK_HOST,
  linkHost,
  publicOrigin,
} from "../src/paths.js";

test("bindHost defaults to loopback and honors LAVISH_AXI_HOST", () => {
  assert.equal(bindHost({}), LOOPBACK_HOST);
  assert.equal(bindHost({ LAVISH_AXI_HOST: "" }), LOOPBACK_HOST);
  assert.equal(bindHost({ LAVISH_AXI_HOST: "  " }), LOOPBACK_HOST);
  assert.equal(bindHost({ LAVISH_AXI_HOST: "100.64.0.1" }), "100.64.0.1");
  assert.equal(bindHost({ LAVISH_AXI_HOST: " 0.0.0.0 " }), "0.0.0.0");
});

test("clientHost dials the bind host but falls back to the matching-family loopback for wildcard binds", () => {
  assert.equal(clientHost({}), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "100.64.0.1" }), "100.64.0.1");
  assert.equal(clientHost({ LAVISH_AXI_HOST: "0.0.0.0" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "::" }), IPV6_LOOPBACK_HOST);
});

test("linkHost prefers LAVISH_AXI_LINK_HOST, then falls back to the dial host", () => {
  assert.equal(linkHost({}), LOOPBACK_HOST);
  assert.equal(linkHost({ LAVISH_AXI_LINK_HOST: "host.example" }), "host.example");
  assert.equal(linkHost({ LAVISH_AXI_LINK_HOST: "  " }), LOOPBACK_HOST);
  // Non-wildcard bind with no explicit link host -> links reuse the bind address.
  assert.equal(linkHost({ LAVISH_AXI_HOST: "100.64.0.1" }), "100.64.0.1");
  // Wildcard bind with an explicit link host -> links use the hostname, not 0.0.0.0.
  assert.equal(linkHost({ LAVISH_AXI_HOST: "0.0.0.0", LAVISH_AXI_LINK_HOST: "host.example" }), "host.example");
  // IPv6 wildcard bind with no explicit link host -> links fall back to the IPv6 loopback.
  assert.equal(linkHost({ LAVISH_AXI_HOST: "::" }), IPV6_LOOPBACK_HOST);
});

test("publicOrigin returns null unless LAVISH_AXI_PUBLIC_ORIGIN is a usable http(s) origin", () => {
  assert.equal(publicOrigin({}), null);
  assert.equal(publicOrigin({ LAVISH_AXI_PUBLIC_ORIGIN: "" }), null);
  assert.equal(publicOrigin({ LAVISH_AXI_PUBLIC_ORIGIN: "   " }), null);
  assert.equal(publicOrigin({ LAVISH_AXI_PUBLIC_ORIGIN: "https://lavish.example" }), "https://lavish.example");
  // A trailing slash would double up against the "/session/<key>" suffix.
  assert.equal(publicOrigin({ LAVISH_AXI_PUBLIC_ORIGIN: "https://lavish.example/" }), "https://lavish.example");
  // An explicit port is legitimate (a proxy on a non-default port) and must survive.
  assert.equal(
    publicOrigin({ LAVISH_AXI_PUBLIC_ORIGIN: "https://lavish.example:8443" }),
    "https://lavish.example:8443",
  );
  // Any path component is dropped: session URLs are always built from the origin.
  assert.equal(publicOrigin({ LAVISH_AXI_PUBLIC_ORIGIN: "https://lavish.example/base" }), "https://lavish.example");
  // Garbage and non-http schemes fall back to the port-based URL rather than emitting a broken link.
  assert.equal(publicOrigin({ LAVISH_AXI_PUBLIC_ORIGIN: "not a url" }), null);
  assert.equal(publicOrigin({ LAVISH_AXI_PUBLIC_ORIGIN: "ftp://lavish.example" }), null);
});

test("hostForUrl brackets IPv6 literals but leaves IPv4 and hostnames alone", () => {
  assert.equal(hostForUrl("127.0.0.1"), "127.0.0.1");
  assert.equal(hostForUrl("host.example"), "host.example");
  assert.equal(hostForUrl("::1"), "[::1]");
  assert.equal(hostForUrl("[::1]"), "[::1]");
});
