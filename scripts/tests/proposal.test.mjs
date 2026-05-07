import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ingestLocal } from "../data-tools.mjs";
import { ingestExternal } from "../lit-tools.mjs";
import { freezeProposal, initProposal, statusProposal, validateProposal } from "../proposal-tools.mjs";

async function makeFixture({ withData = true, withLit = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-proposal-"));
  if (withData) {
    const src = path.join(root, "data-src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "train.csv"), "id,label\n1,0\n2,1\n");
    await ingestLocal({ datasetId: "ds1", src, execute: true, yes: true, rootDir: root });
  }
  if (withLit) {
    const inbox = path.join(root, "inbox.json");
    const papers = [];
    for (let i = 0; i < 5; i += 1) {
      papers.push({
        id: `p${i}`,
        title: `Cascaded CVR Paper ${i}`,
        summary: "github.com/x/y open-source code released",
        year: 2024,
        authors: ["X. Y."],
      });
    }
    await writeFile(inbox, JSON.stringify(papers));
    await ingestExternal({ source: "user-pdf", fromFile: inbox, query: "cascaded cvr", rootDir: root });
  }
  return { root };
}

test("propose init produces a 7-section markdown skeleton", async () => {
  const { root } = await makeFixture();
  const result = await initProposal({ planId: "plan-test-1", dataId: "ds1", rootDir: root });
  const md = await readFile(result.proposal_path, "utf8");
  for (const heading of [
    "## 1. 问题与目标",
    "## 2. 数据假设",
    "## 3. 文献支撑",
    "## 4. 算法方案",
    "## 5. 实验计划",
    "## 6. 延迟预算",
    "## 7. 风险与回滚",
  ]) {
    assert.match(md, new RegExp(heading.replace(/\./g, "\\.").replace(/\s/g, "\\s+")));
  }
});

test("propose validate fails when scaffold is unfilled (TODO placeholders)", async () => {
  const { root } = await makeFixture();
  await initProposal({ planId: "plan-test-2", dataId: "ds1", rootDir: root });
  const v = await validateProposal({ planId: "plan-test-2", rootDir: root });
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.kind === "todo_placeholders"));
});

test("propose validate fails when fewer than 3 evidence-relevant papers", async () => {
  // Lit fixture but with only low-relevance entries.
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-proposal-low-"));
  const inbox = path.join(root, "inbox.json");
  await writeFile(inbox, JSON.stringify([
    { id: "lo1", title: "Unrelated topic on graph theory", summary: "no code", year: 2024 },
  ]));
  await ingestExternal({ source: "user-pdf", fromFile: inbox, query: "cascaded cvr", rootDir: root });

  // Build a clean dataset.
  const dataSrc = path.join(root, "data-src");
  await mkdir(dataSrc, { recursive: true });
  await writeFile(path.join(dataSrc, "train.csv"), "id,label\n1,0\n");
  await ingestLocal({ datasetId: "ds-low", src: dataSrc, execute: true, yes: true, rootDir: root });

  const init = await initProposal({ planId: "plan-low", dataId: "ds-low", rootDir: root });
  // Manually fill the markdown so only the evidence shortage is the open issue.
  await writeFile(init.proposal_path, makeFilledMarkdown({
    planId: "plan-low",
    dataId: "ds-low",
    dataManifestSha256: init.data_manifest_sha256,
    researchIndexSha256: init.research_index_sha256,
  }));
  const v = await validateProposal({ planId: "plan-low", rootDir: root });
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.kind === "insufficient_evidence"));
});

test("propose validate passes a fully filled proposal", async () => {
  const { root } = await makeFixture();
  const init = await initProposal({ planId: "plan-good", dataId: "ds1", rootDir: root });
  await writeFile(init.proposal_path, makeFilledMarkdown({
    planId: "plan-good",
    dataId: "ds1",
    dataManifestSha256: init.data_manifest_sha256,
    researchIndexSha256: init.research_index_sha256,
  }));
  const v = await validateProposal({ planId: "plan-good", rootDir: root });
  assert.deepEqual(v.issues, []);
  assert.equal(v.ok, true);
});

test("propose freeze writes proposal.json and advances state", async () => {
  const { root } = await makeFixture();
  const init = await initProposal({ planId: "plan-freeze", dataId: "ds1", rootDir: root });
  await writeFile(init.proposal_path, makeFilledMarkdown({
    planId: "plan-freeze",
    dataId: "ds1",
    dataManifestSha256: init.data_manifest_sha256,
    researchIndexSha256: init.research_index_sha256,
  }));

  const dryRun = await freezeProposal({ planId: "plan-freeze", rootDir: root });
  assert.equal(dryRun.mode, "dry-run");

  const live = await freezeProposal({ planId: "plan-freeze", rootDir: root, execute: true, yes: true });
  assert.equal(live.written, true);
  assert.equal(live.state, "reviewed_by_compliance");

  const status = await statusProposal({ planId: "plan-freeze", rootDir: root });
  assert.equal(status.state, "reviewed_by_compliance");
  assert.match(status.proposal.proposal_sha256, /^[0-9a-f]{64}$/);
});

test("propose freeze refuses when validate fails (VALIDATION_FAILED)", async () => {
  const { root } = await makeFixture();
  await initProposal({ planId: "plan-bad", dataId: "ds1", rootDir: root });
  // Don't fill the scaffold; freeze should reject.
  await assert.rejects(
    freezeProposal({ planId: "plan-bad", rootDir: root, execute: true, yes: true }),
    (error) => {
      assert.equal(error.code, "VALIDATION_FAILED");
      return true;
    },
  );
});

// Helper: a minimal "no TODO placeholders" markdown that satisfies all
// validate gates.
function makeFilledMarkdown({ planId, dataId, dataManifestSha256, researchIndexSha256 }) {
  return [
    `# 算法提案 ${planId}`,
    "",
    "## 1. 问题与目标",
    "",
    "CVR 预估，valid AUC 优化，p95 推理延迟受限。",
    "",
    "## 2. 数据假设",
    "",
    `- 数据集 ID：\`${dataId}\``,
    `- data_manifest_sha256：\`${dataManifestSha256}\``,
    "- 切分策略：随机 8:1:1，时间无重叠。",
    "",
    "## 3. 文献支撑",
    "",
    `- research_index_sha256：\`${researchIndexSha256}\``,
    "- 候选论文：p0 / p1 / p2（均 evidence_score.relevance >= 0.6）。",
    "",
    "## 4. 算法方案",
    "",
    "- 主干：cascaded tower + cross feature interaction。",
    "- non_ensemble_ack: true（不使用 stacking / voting / blending）。",
    "",
    "## 5. 实验计划",
    "",
    "- max_iters：`12`",
    "- 早停：连续 3 轮 val AUC 提升 < 0.001。",
    "- 多 seed：[1, 2, 3, 4, 5]。",
    "",
    "## 6. 延迟预算",
    "",
    "- latency_budget_ms：`25`",
    "- benchmark 协议：单 GPU，batch=128。",
    "- p95 目标：22ms；p99 目标：30ms。",
    "",
    "## 7. 风险与回滚",
    "",
    "- 若 latency 超预算，降级为单 tower。",
    "- 若 val AUC 不增益，回滚到上一轮 checkpoint。",
    "",
  ].join("\n");
}
