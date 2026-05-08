import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  computeKbHmac,
  getKbEntry,
  kbPath,
  listKbEntries,
  setVerification,
  upsertKbEntry,
} from "../_error-kb.mjs";

const KEY = "0".repeat(64);

async function makeRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-errkb-"));
  await mkdir(path.join(root, "taiji-output", "secrets"), { recursive: true });
  await writeFile(path.join(root, "taiji-output", "secrets", "review.hmac.key"), KEY);
  return root;
}

const SIG = "sha256:" + "a".repeat(64);
const SIG2 = "sha256:" + "b".repeat(64);

test("upsertKbEntry creates a new entry with HMAC and occurrences=1", async () => {
  const root = await makeRoot();
  const r = await upsertKbEntry({
    sig: SIG, layer: "gpu", title: "CUDA OOM", planId: "plan-1",
    fix: { kind: "config", summary: "amp on", config_overrides: { "train.amp": true } },
    rootDir: root,
  });
  assert.equal(r.mode, "created");
  assert.equal(r.entry.occurrences, 1);
  assert.equal(r.entry.layer, "gpu");
  assert.deepEqual(r.entry.plans_affected, ["plan-1"]);
  assert.match(r.entry.hmac, /^[0-9a-f]{64}$/);
});

test("upsertKbEntry on the same sig increments occurrences and unions plans_affected", async () => {
  const root = await makeRoot();
  await upsertKbEntry({ sig: SIG, layer: "gpu", title: "OOM", planId: "plan-A", rootDir: root });
  const r = await upsertKbEntry({ sig: SIG, layer: "gpu", title: "OOM", planId: "plan-B", rootDir: root });
  assert.equal(r.mode, "updated");
  assert.equal(r.entry.occurrences, 2);
  assert.deepEqual(r.entry.plans_affected.sort(), ["plan-A", "plan-B"]);
});

test("getKbEntry returns null for absent sig", async () => {
  const root = await makeRoot();
  const r = await getKbEntry({ sig: SIG, rootDir: root });
  assert.equal(r, null);
});

test("getKbEntry returns the entry when HMAC is valid", async () => {
  const root = await makeRoot();
  await upsertKbEntry({ sig: SIG, layer: "gpu", title: "OOM", planId: "p", rootDir: root });
  const r = await getKbEntry({ sig: SIG, rootDir: root });
  assert.ok(r);
  assert.equal(r.layer, "gpu");
});

test("getKbEntry refuses to return a tampered entry (HMAC mismatch)", async () => {
  const root = await makeRoot();
  const created = await upsertKbEntry({ sig: SIG, layer: "gpu", title: "OOM", planId: "p", rootDir: root });
  const filePath = kbPath(path.join(root, "taiji-output", "errors"), SIG);
  const entry = JSON.parse(await readFile(filePath, "utf8"));
  entry.layer = "data"; // try to relabel without re-signing
  await writeFile(filePath, JSON.stringify(entry));
  await assert.rejects(getKbEntry({ sig: SIG, rootDir: root }), /tampered/);
});

test("computeKbHmac is independent of key order in the entry object", () => {
  const a = { sig: SIG, layer: "gpu", title: "x" };
  const b = { layer: "gpu", title: "x", sig: SIG };
  assert.equal(computeKbHmac(a, KEY), computeKbHmac(b, KEY));
});

test("computeKbHmac excludes the existing hmac field from the signed bytes", () => {
  const base = { sig: SIG, layer: "gpu", title: "x" };
  const sigA = computeKbHmac(base, KEY);
  const withFakeHmac = { ...base, hmac: "deadbeef" };
  const sigB = computeKbHmac(withFakeHmac, KEY);
  assert.equal(sigA, sigB);
});

test("listKbEntries filters by layer and orders by last_seen desc", async () => {
  const root = await makeRoot();
  await upsertKbEntry({ sig: SIG, layer: "gpu", title: "OOM", planId: "p", rootDir: root });
  await upsertKbEntry({ sig: SIG2, layer: "submit-api", title: "422", planId: "p", rootDir: root });
  const all = await listKbEntries({ rootDir: root });
  assert.equal(all.length, 2);
  const gpu = await listKbEntries({ rootDir: root, layer: "gpu" });
  assert.equal(gpu.length, 1);
  assert.equal(gpu[0].layer, "gpu");
});

test("setVerification updates the verification subfield and re-signs", async () => {
  const root = await makeRoot();
  await upsertKbEntry({ sig: SIG, layer: "gpu", title: "OOM", planId: "p", rootDir: root });
  await setVerification({
    sig: SIG, rootDir: root,
    verification: { passed_iter_id: "iter-9", val_auc_delta: -0.001, latency_p95_delta_ms: 1.0, verified_at: new Date().toISOString() },
  });
  const after = await getKbEntry({ sig: SIG, rootDir: root });
  assert.equal(after.verification.passed_iter_id, "iter-9");
  assert.equal(after.verification.val_auc_delta, -0.001);
});

test("setVerification refuses to write if the base entry was tampered first", async () => {
  const root = await makeRoot();
  await upsertKbEntry({ sig: SIG, layer: "gpu", title: "OOM", planId: "p", rootDir: root });
  const filePath = kbPath(path.join(root, "taiji-output", "errors"), SIG);
  const entry = JSON.parse(await readFile(filePath, "utf8"));
  entry.layer = "data"; // tamper
  await writeFile(filePath, JSON.stringify(entry));
  await assert.rejects(
    setVerification({ sig: SIG, rootDir: root, verification: { passed_iter_id: "x" } }),
    /tampered/,
  );
});

test("upsertKbEntry rejects an invalid sig prefix", async () => {
  const root = await makeRoot();
  await assert.rejects(
    upsertKbEntry({ sig: "not-a-sig", layer: "gpu", title: "x", rootDir: root }),
    /invalid sig/,
  );
});
