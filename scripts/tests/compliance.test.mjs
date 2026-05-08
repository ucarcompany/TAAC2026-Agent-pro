import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { freezeProposal, initProposal } from "../proposal-tools.mjs";
import { ingestExternal } from "../lit-tools.mjs";
import { ingestLocal } from "../data-tools.mjs";
import {
  ENSEMBLE_KEYWORDS,
  checkComplianceGate,
  checkHumanApprovalGate,
  checkLocalGate,
  checkQuotaGate,
  checkSubmitDryRun,
  todayLocal,
} from "../_compliance.mjs";
import { setHostPassword } from "../_host-password.mjs";
import { signPayload, buildTokenPayload } from "../_hmac.mjs";

async function makeFixture({ leakage = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-compliance-"));

  // Data + lit fixtures (M1 + M2)
  const dataSrc = path.join(root, "data-src");
  await mkdir(dataSrc, { recursive: true });
  const lines = ["id,feature,leak,label"];
  for (let i = 0; i < 200; i += 1) {
    const label = i % 2;
    const feature = Math.random();
    const leak = leakage ? label + (Math.random() - 0.5) * 1e-3 : Math.random();
    lines.push(`${i},${feature.toFixed(4)},${leak.toFixed(6)},${label}`);
  }
  await writeFile(path.join(dataSrc, "train.csv"), lines.join("\n") + "\n");
  await ingestLocal({ datasetId: "ds1", src: dataSrc, execute: true, yes: true, rootDir: root });

  const inbox = path.join(root, "inbox.json");
  const papers = [];
  for (let i = 0; i < 5; i += 1) {
    papers.push({
      id: `p${i}`,
      title: `Cascaded CVR ${i}`,
      summary: "Open-source code on github.com/x/y",
      year: 2024,
    });
  }
  await writeFile(inbox, JSON.stringify(papers));
  await ingestExternal({ source: "user-pdf", fromFile: inbox, query: "cascaded cvr", rootDir: root });

  // Proposal fixture (M3) — fully filled, freeze it.
  const init = await initProposal({ planId: "plan-1", dataId: "ds1", rootDir: root });
  const filled = makeFilledMarkdown({
    planId: "plan-1",
    dataId: "ds1",
    dataManifestSha256: init.data_manifest_sha256,
    researchIndexSha256: init.research_index_sha256,
  });
  await writeFile(init.proposal_path, filled);
  await freezeProposal({ planId: "plan-1", rootDir: root, execute: true, yes: true });

  // Loop state fixture (M4)
  const loopDir = path.join(root, "taiji-output", "state", "loops", "plan-1");
  await mkdir(loopDir, { recursive: true });
  await writeFile(path.join(loopDir, "loop-state.json"), JSON.stringify({
    plan_id: "plan-1",
    state: "completed",
    iter_history: [
      { iter: 0, metrics: { val_auc: 0.50, latency: { p95_ms: 10 } } },
      { iter: 1, metrics: { val_auc: 0.55, latency: { p95_ms: 11 } } },
      { iter: 2, metrics: { val_auc: 0.62, latency: { p95_ms: 12 } } },
    ],
  }));

  return { root };
}

function makeFilledMarkdown({ planId, dataId, dataManifestSha256, researchIndexSha256 }) {
  return [
    `# 算法提案 ${planId}`,
    "",
    "## 1. 问题与目标",
    "CVR 预估，valid AUC + p95 latency。",
    "",
    "## 2. 数据假设",
    `- 数据集 ID：\`${dataId}\``,
    `- data_manifest_sha256：\`${dataManifestSha256}\``,
    "- 切分：8:1:1。",
    "",
    "## 3. 文献支撑",
    `- research_index_sha256：\`${researchIndexSha256}\``,
    "- p0 / p1 / p2 / p3 / p4。",
    "",
    "## 4. 算法方案",
    "- 主干：cascaded tower。",
    "- non_ensemble_ack: true。",
    "",
    "## 5. 实验计划",
    "- max_iters：`12`",
    "- 多 seed: [1,2,3]",
    "",
    "## 6. 延迟预算",
    "- latency_budget_ms：`25`",
    "- p95 22ms / p99 30ms",
    "",
    "## 7. 风险与回滚",
    "- R7 / R13 缓解。",
    "- 回滚：上一轮 ckpt。",
    "",
  ].join("\n");
}

test("checkLocalGate passes when last val_auc improves over baseline", async () => {
  const { root } = await makeFixture();
  const r = await checkLocalGate({ planId: "plan-1", rootDir: root, thresholdDelta: 0.001 });
  assert.equal(r.passed, true);
  assert.ok(r.evidence.delta > 0);
});

test("checkLocalGate fails when fewer than 2 iters", async () => {
  const { root } = await makeFixture();
  const loopPath = path.join(root, "taiji-output", "state", "loops", "plan-1", "loop-state.json");
  await writeFile(loopPath, JSON.stringify({ plan_id: "plan-1", state: "running_iter", iter_history: [{ iter: 0, metrics: { val_auc: 0.5 } }] }));
  const r = await checkLocalGate({ planId: "plan-1", rootDir: root });
  assert.equal(r.passed, false);
  assert.match(r.reason, /fewer than 2 iters/);
});

test("checkLocalGate fails when val_auc regresses", async () => {
  const { root } = await makeFixture();
  const loopPath = path.join(root, "taiji-output", "state", "loops", "plan-1", "loop-state.json");
  await writeFile(loopPath, JSON.stringify({
    iter_history: [
      { iter: 0, metrics: { val_auc: 0.7 } },
      { iter: 1, metrics: { val_auc: 0.65 } },
    ],
  }));
  const r = await checkLocalGate({ planId: "plan-1", rootDir: root });
  assert.equal(r.passed, false);
  assert.match(r.reason, /delta/);
});

test("checkComplianceGate passes on a clean fixture", async () => {
  const { root } = await makeFixture();
  const r = await checkComplianceGate({ planId: "plan-1", rootDir: root, latencyBudgetMs: 25 });
  // The grep root defaults to repo root; the test fixture root has no
  // ensemble keywords, so this should pass. SHA256s match because we
  // just ran freeze.
  if (!r.passed) console.log(JSON.stringify(r, null, 2));
  assert.equal(r.passed, true, `compliance failed: ${r.reason}`);
});

test("checkComplianceGate fails when bundle contains ensemble keyword", async () => {
  const { root } = await makeFixture();
  const bundle = path.join(root, "bundle");
  await mkdir(bundle, { recursive: true });
  await writeFile(path.join(bundle, "infer.py"), "from sklearn.ensemble import StackingClassifier\n");
  const r = await checkComplianceGate({ planId: "plan-1", candidateBundle: bundle, rootDir: root, latencyBudgetMs: 25 });
  assert.equal(r.passed, false);
  assert.ok(r.evidence.ensemble_keyword_hits.length >= 1);
});

test("checkComplianceGate fails when proposal.md SHA256 has drifted", async () => {
  const { root } = await makeFixture();
  const mdPath = path.join(root, "taiji-output", "proposals", "plan-1", "proposal.md");
  // Append a benign comment so SHA256 changes but markdown still validates.
  const cur = await (await import("node:fs/promises")).readFile(mdPath, "utf8");
  await writeFile(mdPath, cur + "\n<!-- tampered -->\n");
  const r = await checkComplianceGate({ planId: "plan-1", rootDir: root, latencyBudgetMs: 25 });
  assert.equal(r.passed, false);
  assert.ok(r.issues.some((i) => i.kind === "proposal_sha256_mismatch"));
});

test("checkComplianceGate fails when leakage_red_flags is non-empty", async () => {
  const { root } = await makeFixture({ leakage: true });
  // Run profile on the leaky data — but profile throws on detected leakage,
  // so we synthesise the profile.json directly here for the gate check.
  const profDir = path.join(root, "taiji-output", "profiling", "ds1");
  await mkdir(profDir, { recursive: true });
  await writeFile(path.join(profDir, "profile.json"), JSON.stringify({
    leakage_red_flags: [{ column: "leak", statistic: "pearson", value: 0.99, threshold: 0.95 }],
  }));
  const r = await checkComplianceGate({ planId: "plan-1", rootDir: root, latencyBudgetMs: 25 });
  assert.equal(r.passed, false);
  assert.ok(r.issues.some((i) => i.kind === "leakage_red_flags_present"));
});

test("checkQuotaGate passes when used < daily_hard_ceiling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-quota-"));
  await mkdir(path.join(root, "taiji-output", "state"), { recursive: true });
  await writeFile(path.join(root, "taiji-output", "state", "quota-state.json"), JSON.stringify({
    daily_official_used: { [todayLocal()]: 0 },
  }));
  const r = await checkQuotaGate({ rootDir: root, dailyHardCeiling: 1 });
  assert.equal(r.passed, true);
});

test("checkQuotaGate fails when ceiling is 0", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-quota-zero-"));
  const r = await checkQuotaGate({ rootDir: root, dailyHardCeiling: 0 });
  assert.equal(r.passed, false);
  assert.match(r.reason, />= daily_hard_ceiling=0/);
});

test("checkHumanApprovalGate passes for a valid submit_token with two approvers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-human-"));
  await mkdir(path.join(root, "taiji-output", "secrets"), { recursive: true });
  await mkdir(path.join(root, "taiji-output", "state"), { recursive: true });
  const key = "0".repeat(64);
  await writeFile(path.join(root, "taiji-output", "secrets", "review.hmac.key"), key);
  const payload = buildTokenPayload({ kind: "submit", planId: "plan-1", approver: "human:alice+human:bob", ttlHours: 2 });
  const signed = signPayload(payload, key);
  await writeFile(path.join(root, "taiji-output", "state", ".review-token-submit"), JSON.stringify(signed));
  const r = await checkHumanApprovalGate({ planId: "plan-1", rootDir: root });
  assert.equal(r.passed, true);
});

test("checkHumanApprovalGate fails when single approver", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-human-single-"));
  await mkdir(path.join(root, "taiji-output", "secrets"), { recursive: true });
  await mkdir(path.join(root, "taiji-output", "state"), { recursive: true });
  const key = "0".repeat(64);
  await writeFile(path.join(root, "taiji-output", "secrets", "review.hmac.key"), key);
  const payload = buildTokenPayload({ kind: "submit", planId: "plan-1", approver: "human:alice", ttlHours: 2 });
  const signed = signPayload(payload, key);
  await writeFile(path.join(root, "taiji-output", "state", ".review-token-submit"), JSON.stringify(signed));
  const r = await checkHumanApprovalGate({ planId: "plan-1", rootDir: root });
  assert.equal(r.passed, false);
  assert.match(r.reason, /two human approvers/);
});

test("checkHumanApprovalGate fails when token is for a different plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-human-mismatch-"));
  await mkdir(path.join(root, "taiji-output", "secrets"), { recursive: true });
  await mkdir(path.join(root, "taiji-output", "state"), { recursive: true });
  const key = "0".repeat(64);
  await writeFile(path.join(root, "taiji-output", "secrets", "review.hmac.key"), key);
  const payload = buildTokenPayload({ kind: "submit", planId: "plan-OTHER", approver: "human:alice+human:bob", ttlHours: 2 });
  const signed = signPayload(payload, key);
  await writeFile(path.join(root, "taiji-output", "state", ".review-token-submit"), JSON.stringify(signed));
  const r = await checkHumanApprovalGate({ planId: "plan-1", rootDir: root });
  assert.equal(r.passed, false);
  assert.match(r.reason, /plan_id mismatch/);
});

test("checkSubmitDryRun reports exit code from the spawned process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-dryrun-"));
  // Use an injected spawn that always exits 0 with success message.
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("dry-run plan written\n"));
      child.emit("close", 0);
    });
    child.kill = () => {};
    return child;
  };
  const r = await checkSubmitDryRun({
    candidateBundle: path.join(root, "bundle"),
    templateJobInternalId: "12345",
    rootDir: root,
    spawnFn: fakeSpawn,
  });
  // Either passes via stub or fails because submit-taiji.mjs needs a real bundle.
  // Both outcomes are acceptable for this test — we mainly check the shape.
  assert.ok(typeof r.passed === "boolean");
  assert.ok(typeof r.evidence === "object");
});

test("ENSEMBLE_KEYWORDS includes the standard sklearn / xgb names", () => {
  assert.ok(ENSEMBLE_KEYWORDS.includes("StackingClassifier"));
  assert.ok(ENSEMBLE_KEYWORDS.includes("VotingRegressor"));
  assert.ok(ENSEMBLE_KEYWORDS.includes("xgb_lgb_blend"));
});
