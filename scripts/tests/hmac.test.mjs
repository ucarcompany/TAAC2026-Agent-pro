import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTokenPayload, canonicalJson, signPayload, verifyToken } from "../_hmac.mjs";

const KEY = "0".repeat(64); // 32 bytes hex

test("canonicalJson sorts keys recursively", () => {
  const a = canonicalJson({ b: 1, a: { y: 2, x: 1 } });
  const b = canonicalJson({ a: { x: 1, y: 2 }, b: 1 });
  assert.equal(a, b);
});

test("signPayload produces deterministic hmac for stable input", () => {
  const payload = buildTokenPayload({
    kind: "train", planId: "plan-1", approver: "alice", ttlHours: 24,
    now: () => new Date("2026-05-08T00:00:00Z"),
  });
  const a = signPayload(payload, KEY);
  const b = signPayload(payload, KEY);
  assert.equal(a.hmac, b.hmac);
});

test("verifyToken accepts a freshly signed token", () => {
  const payload = buildTokenPayload({
    kind: "train", planId: "plan-1", approver: "alice", ttlHours: 24,
    now: () => new Date("2026-05-08T00:00:00Z"),
  });
  const signed = signPayload(payload, KEY);
  const result = verifyToken(signed, KEY, { now: () => new Date("2026-05-08T01:00:00Z") });
  assert.equal(result.ok, true);
});

test("verifyToken rejects a tampered hmac", () => {
  const payload = buildTokenPayload({ kind: "train", planId: "plan-1", approver: "alice" });
  const signed = signPayload(payload, KEY);
  signed.approver = "human:eve";
  const result = verifyToken(signed, KEY);
  assert.equal(result.ok, false);
  assert.match(result.reason, /hmac mismatch/);
});

test("verifyToken rejects an expired token", () => {
  const payload = buildTokenPayload({
    kind: "train", planId: "plan-1", approver: "alice", ttlHours: 1,
    now: () => new Date("2026-05-08T00:00:00Z"),
  });
  const signed = signPayload(payload, KEY);
  const result = verifyToken(signed, KEY, { now: () => new Date("2026-05-08T03:00:00Z") });
  assert.equal(result.ok, false);
  assert.match(result.reason, /expired/);
});

test("verifyToken rejects when hmac field is non-hex", () => {
  const payload = buildTokenPayload({ kind: "train", planId: "plan-1", approver: "alice" });
  const signed = signPayload(payload, KEY);
  signed.hmac = "not-hex-zzz";
  const result = verifyToken(signed, KEY);
  assert.equal(result.ok, false);
});

test("verifyToken with a different key returns hmac mismatch", () => {
  const payload = buildTokenPayload({ kind: "train", planId: "plan-1", approver: "alice" });
  const signed = signPayload(payload, KEY);
  const otherKey = "1".repeat(64);
  const result = verifyToken(signed, otherKey);
  assert.equal(result.ok, false);
  assert.match(result.reason, /hmac mismatch/);
});

test("buildTokenPayload requires kind / planId / approver", () => {
  assert.throws(() => buildTokenPayload({ planId: "p", approver: "a" }), /kind is required/);
  assert.throws(() => buildTokenPayload({ kind: "train", approver: "a" }), /planId is required/);
  assert.throws(() => buildTokenPayload({ kind: "train", planId: "p" }), /approver is required/);
});
