import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { issueToken, status, verify } from "../review-gate.mjs";

async function makeRoot({ withKey = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-review-"));
  const secrets = path.join(root, "taiji-output", "secrets");
  const proposals = path.join(root, "taiji-output", "proposals", "plan-x");
  const state = path.join(root, "taiji-output", "state");
  await mkdir(secrets, { recursive: true });
  await mkdir(proposals, { recursive: true });
  await mkdir(state, { recursive: true });
  if (withKey) await writeFile(path.join(secrets, "review.hmac.key"), "0".repeat(64));
  // Minimal proposal.json so issue can read SHA256 references.
  await writeFile(path.join(proposals, "proposal.json"), JSON.stringify({
    plan_id: "plan-x",
    proposal_sha256: "a".repeat(64),
    data_manifest_sha256: "b".repeat(64),
    research_index_sha256: "c".repeat(64),
  }));
  return root;
}

test("issue --kind train requires --execute --yes (dry-run by default)", async () => {
  const root = await makeRoot();
  const dry = await issueToken({
    kind: "train", planId: "plan-x", approver: "alice", rootDir: root,
  });
  assert.equal(dry.mode, "dry-run");
});

test("issue + verify train round-trip succeeds", async () => {
  const root = await makeRoot();
  const issued = await issueToken({
    kind: "train", planId: "plan-x", approver: "alice", execute: true, yes: true, rootDir: root,
  });
  assert.equal(issued.kind, "train");
  const v = await verify({ kind: "train", planId: "plan-x", rootDir: root });
  assert.equal(v.ok, true);
  assert.equal(v.payload.kind, "train");
  assert.equal(v.payload.plan_id, "plan-x");
  assert.equal(v.payload.allow_ssh, true);
  assert.equal(v.payload.allow_official_submit, false);
});

test("verify rejects a train_token used as submit_token", async () => {
  const root = await makeRoot();
  await issueToken({
    kind: "train", planId: "plan-x", approver: "alice", execute: true, yes: true, rootDir: root,
  });
  const v = await verify({
    kind: "submit",
    tokenFile: path.join(root, "taiji-output", "state", ".review-token-train"),
    rootDir: root,
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /kind mismatch/);
});

test("verify rejects when plan_id does not match", async () => {
  const root = await makeRoot();
  await issueToken({
    kind: "train", planId: "plan-x", approver: "alice", execute: true, yes: true, rootDir: root,
  });
  const v = await verify({ kind: "train", planId: "plan-y", rootDir: root });
  assert.equal(v.ok, false);
  assert.match(v.reason, /plan_id mismatch/);
});

test("verify rejects a tampered token (any field change)", async () => {
  const root = await makeRoot();
  await issueToken({
    kind: "train", planId: "plan-x", approver: "alice", execute: true, yes: true, rootDir: root,
  });
  const tokenPath = path.join(root, "taiji-output", "state", ".review-token-train");
  const token = JSON.parse(await readFile(tokenPath, "utf8"));
  token.allow_official_submit = true; // attempt privilege escalation
  await writeFile(tokenPath, JSON.stringify(token));
  const v = await verify({ kind: "train", rootDir: root });
  assert.equal(v.ok, false);
  assert.match(v.reason, /hmac mismatch/);
});

test("issue --kind submit requires TAAC2026_SECOND_APPROVER env", async () => {
  const root = await makeRoot();
  await assert.rejects(
    issueToken({
      kind: "submit", planId: "plan-x", approver: "alice", execute: true, yes: true, rootDir: root,
      secondApprover: "",
    }),
    /second human approver/,
  );
});

test("issue --kind submit succeeds when second approver is provided", async () => {
  const root = await makeRoot();
  const issued = await issueToken({
    kind: "submit", planId: "plan-x", approver: "alice", secondApprover: "bob",
    execute: true, yes: true, rootDir: root,
  });
  assert.equal(issued.kind, "submit");
  const v = await verify({ kind: "submit", planId: "plan-x", rootDir: root });
  assert.equal(v.ok, true);
  assert.equal(v.payload.allow_ssh, false);
  assert.equal(v.payload.allow_official_submit, true);
  assert.match(v.payload.approver, /alice.*bob/);
});

test("issue fails with a clear error when HMAC key is missing", async () => {
  const root = await makeRoot({ withKey: false });
  await assert.rejects(
    issueToken({
      kind: "train", planId: "plan-x", approver: "alice", execute: true, yes: true, rootDir: root,
    }),
    /Missing HMAC key/,
  );
});

test("issue fails when HMAC key is malformed (not 32-byte hex)", async () => {
  const root = await makeRoot();
  await writeFile(path.join(root, "taiji-output", "secrets", "review.hmac.key"), "garbage");
  await assert.rejects(
    issueToken({
      kind: "train", planId: "plan-x", approver: "alice", execute: true, yes: true, rootDir: root,
    }),
    /not 32-byte hex/,
  );
});

test("status reports both train and submit token slots", async () => {
  const root = await makeRoot();
  await issueToken({
    kind: "train", planId: "plan-x", approver: "alice", execute: true, yes: true, rootDir: root,
  });
  const s = await status({ rootDir: root });
  assert.equal(s.train.present, true);
  assert.equal(s.train.plan_id, "plan-x");
  assert.equal(s.submit.present, false);
});

test("verify reports a clear reason when no token file exists", async () => {
  const root = await makeRoot();
  const v = await verify({ kind: "submit", rootDir: root });
  assert.equal(v.ok, false);
  assert.match(v.reason, /token file missing/);
});
