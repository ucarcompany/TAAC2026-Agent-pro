import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  GATES,
  advanceEscalation,
  initEscalation,
  resetEscalation,
  statusEscalation,
} from "../submit-escalate.mjs";

async function makeRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "taac2026-escalate-"));
}

const PASS = (gate) => async () => ({ passed: true, evidence: { gate, mocked: true } });
const FAIL = (gate, reason) => async () => ({ passed: false, evidence: { gate, mocked: true }, reason });

const ALL_PASS = {
  local_gate:      PASS("local_gate"),
  compliance_gate: PASS("compliance_gate"),
  quota_gate:      PASS("quota_gate"),
  human_approval:  PASS("human_approval"),
  submit_dry_run:  PASS("submit_dry_run"),
};

test("init creates state file with state=candidate and gate_results sketched", async () => {
  const root = await makeRoot();
  const r = await initEscalation({
    planId: "p-1",
    candidateBundle: path.join(root, "bundle"),
    templateJobInternalId: "12345",
    rootDir: root,
  });
  assert.equal(r.state, "candidate");
  const status = await statusEscalation({ planId: "p-1", rootDir: root });
  assert.equal(status.state, "candidate");
  assert.equal(status.next_gate, "local_gate");
  for (const g of GATES) assert.equal(status.gate_results[g.name], null);
});

test("advance walks all 5 gates in order to submit_dry_run_verified", async () => {
  const root = await makeRoot();
  await initEscalation({ planId: "p-2", candidateBundle: path.join(root, "b"), templateJobInternalId: "1", rootDir: root });
  for (let step = 0; step < 5; step += 1) {
    const r = await advanceEscalation({ planId: "p-2", rootDir: root, execute: true, yes: true, gateRunners: ALL_PASS });
    assert.equal(r.passed, true, `step ${step} failed`);
  }
  const status = await statusEscalation({ planId: "p-2", rootDir: root });
  assert.equal(status.state, "submit_dry_run_verified");
  assert.equal(status.next_gate, null); // M6 stops here; M7 picks up "submitted"
});

test("advance dry-run does NOT change state", async () => {
  const root = await makeRoot();
  await initEscalation({ planId: "p-dry", candidateBundle: path.join(root, "b"), templateJobInternalId: "1", rootDir: root });
  const r = await advanceEscalation({ planId: "p-dry", rootDir: root, gateRunners: ALL_PASS });
  assert.equal(r.mode, "dry-run");
  const status = await statusEscalation({ planId: "p-dry", rootDir: root });
  assert.equal(status.state, "candidate");
});

test("advance --gate <name> with the wrong gate name is rejected", async () => {
  const root = await makeRoot();
  await initEscalation({ planId: "p-wrong", candidateBundle: path.join(root, "b"), templateJobInternalId: "1", rootDir: root });
  await assert.rejects(
    advanceEscalation({ planId: "p-wrong", rootDir: root, execute: true, yes: true, gate: "compliance_gate", gateRunners: ALL_PASS }),
    /next pending gate is 'local_gate'/,
  );
});

test("advance fails the second gate without changing state, leaves first gate's pass intact", async () => {
  const root = await makeRoot();
  await initEscalation({ planId: "p-fail2", candidateBundle: path.join(root, "b"), templateJobInternalId: "1", rootDir: root });
  // Pass local_gate, fail compliance_gate.
  await advanceEscalation({ planId: "p-fail2", rootDir: root, execute: true, yes: true, gateRunners: ALL_PASS });
  const r = await advanceEscalation({
    planId: "p-fail2",
    rootDir: root,
    execute: true,
    yes: true,
    gateRunners: { ...ALL_PASS, compliance_gate: FAIL("compliance_gate", "ensemble keyword found") },
  });
  assert.equal(r.passed, false);
  assert.match(r.reason, /ensemble keyword/);
  const status = await statusEscalation({ planId: "p-fail2", rootDir: root });
  assert.equal(status.state, "local_gate_passed");
  assert.equal(status.gate_results.local_gate.passed, true);
  assert.equal(status.gate_results.compliance_gate.passed, false);
});

test("advance writes a decisions/<gate>-<ts>.json record per attempt", async () => {
  const root = await makeRoot();
  await initEscalation({ planId: "p-dec", candidateBundle: path.join(root, "b"), templateJobInternalId: "1", rootDir: root });
  await advanceEscalation({ planId: "p-dec", rootDir: root, execute: true, yes: true, gateRunners: ALL_PASS });
  const decisionsDir = path.join(root, "taiji-output", "state", "submits", "p-dec", "decisions");
  const entries = await readdir(decisionsDir);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^local_gate-/);
  const decision = JSON.parse(await readFile(path.join(decisionsDir, entries[0]), "utf8"));
  assert.equal(decision.gate, "local_gate");
  assert.equal(decision.passed, true);
});

test("advance --execute requires --yes", async () => {
  const root = await makeRoot();
  await initEscalation({ planId: "p-yes", candidateBundle: path.join(root, "b"), templateJobInternalId: "1", rootDir: root });
  await assert.rejects(
    advanceEscalation({ planId: "p-yes", rootDir: root, execute: true, yes: false, gateRunners: ALL_PASS }),
    /--execute requires --yes/,
  );
});

test("reset to an earlier state clears gate_results past the target", async () => {
  const root = await makeRoot();
  await initEscalation({ planId: "p-rst", candidateBundle: path.join(root, "b"), templateJobInternalId: "1", rootDir: root });
  for (let step = 0; step < 3; step += 1) {
    await advanceEscalation({ planId: "p-rst", rootDir: root, execute: true, yes: true, gateRunners: ALL_PASS });
  }
  let status = await statusEscalation({ planId: "p-rst", rootDir: root });
  assert.equal(status.state, "quota_available");

  await resetEscalation({ planId: "p-rst", to: "local_gate_passed", rootDir: root, execute: true, yes: true });
  status = await statusEscalation({ planId: "p-rst", rootDir: root });
  assert.equal(status.state, "local_gate_passed");
  // Gate results past local_gate_passed must be cleared.
  assert.equal(status.gate_results.local_gate.passed, true); // local_gate keeps its result
  assert.equal(status.gate_results.compliance_gate, null);
  assert.equal(status.gate_results.quota_gate, null);
});

test("reset to an unknown state is rejected", async () => {
  const root = await makeRoot();
  await initEscalation({ planId: "p-rst-bad", candidateBundle: path.join(root, "b"), templateJobInternalId: "1", rootDir: root });
  await assert.rejects(
    resetEscalation({ planId: "p-rst-bad", to: "magical_state", rootDir: root, execute: true, yes: true }),
    /Unknown reset target/,
  );
});

test("once submit_dry_run_verified, advance reports no further M6 gates", async () => {
  const root = await makeRoot();
  await initEscalation({ planId: "p-tail", candidateBundle: path.join(root, "b"), templateJobInternalId: "1", rootDir: root });
  for (let i = 0; i < 5; i += 1) {
    await advanceEscalation({ planId: "p-tail", rootDir: root, execute: true, yes: true, gateRunners: ALL_PASS });
  }
  const r = await advanceEscalation({ planId: "p-tail", rootDir: root, execute: true, yes: true, gateRunners: ALL_PASS });
  assert.equal(r.state, "submit_dry_run_verified");
  assert.match(r.message, /no further gates/);
});

test("init twice on the same plan-id keeps existing history but updates fields", async () => {
  const root = await makeRoot();
  await initEscalation({ planId: "p-twice", candidateBundle: path.join(root, "b1"), templateJobInternalId: "1", rootDir: root });
  await advanceEscalation({ planId: "p-twice", rootDir: root, execute: true, yes: true, gateRunners: ALL_PASS });
  const r = await initEscalation({ planId: "p-twice", candidateBundle: path.join(root, "b2"), templateJobInternalId: "1", rootDir: root });
  assert.equal(r.state, "local_gate_passed", "init must not regress state");
});
