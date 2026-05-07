#!/usr/bin/env node
// Algorithm proposal tooling — M3 of skill-expansion-design-2026-05-07.md.
//
// Subcommands:
//   propose init     --plan-id <id> [--data-id <id>] [--latency-budget-ms 25] [--max-iters 12]
//   propose validate --plan-id <id>
//   propose freeze   --plan-id <id> --execute --yes
//   propose status   --plan-id <id>
//
// Writes under taiji-output/proposals/<plan-id>/:
//   proposal.md   — human-edited 7-section markdown (CLI scaffolds, validates)
//   proposal.json — machine-readable (set by `freeze`; never edited by hand)
//   state.json    — state machine: draft → reviewed_by_compliance → awaiting_human → approved

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFile, atomicWriteJson, joinSafeRelative } from "./_taiji-http.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_PROPOSALS_ROOT = path.join(ROOT, "taiji-output", "proposals");
const DEFAULT_DATA_ROOT = path.join(ROOT, "taiji-output", "data");
const DEFAULT_PROFILE_ROOT = path.join(ROOT, "taiji-output", "profiling");
const DEFAULT_LIT_ROOT = path.join(ROOT, "taiji-output", "literature");

const REQUIRED_SECTIONS = [
  { id: "1", title: "问题与目标", patterns: [/##\s*1[.\s]/, /##\s*1\b/, /##\s*问题与目标/i] },
  { id: "2", title: "数据假设", patterns: [/##\s*2[.\s]/, /##\s*数据假设/i] },
  { id: "3", title: "文献支撑", patterns: [/##\s*3[.\s]/, /##\s*文献支撑/i] },
  { id: "4", title: "算法方案", patterns: [/##\s*4[.\s]/, /##\s*算法方案/i] },
  { id: "5", title: "实验计划", patterns: [/##\s*5[.\s]/, /##\s*实验计划/i] },
  { id: "6", title: "延迟预算", patterns: [/##\s*6[.\s]/, /##\s*延迟预算/i] },
  { id: "7", title: "风险与回滚", patterns: [/##\s*7[.\s]/, /##\s*风险与回滚/i] },
];

const STATES = ["draft", "reviewed_by_compliance", "awaiting_human", "approved"];

function usage() {
  return `Usage:
  taac2026 propose init     --plan-id <id> [--data-id <id>] [--latency-budget-ms 25] [--max-iters 12]
  taac2026 propose validate --plan-id <id>
  taac2026 propose freeze   --plan-id <id> --execute --yes
  taac2026 propose status   --plan-id <id>

Init scaffolds taiji-output/proposals/<plan-id>/proposal.md (7 sections).
Validate enforces: all 7 sections present, 3 referenced SHA256 match disk,
>=3 literature index entries with relevance >= 0.6, non_ensemble_ack=true,
latency_budget_ms set.
Freeze writes proposal.json and advances state to reviewed_by_compliance.
`;
}

function parseArgs(argv) {
  const args = { command: argv[0], execute: false, yes: false };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--execute") args.execute = true;
    else if (arg === "--yes") args.yes = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

function rootsFor({ rootDir }) {
  if (rootDir) {
    return {
      proposalsRoot: path.join(rootDir, "taiji-output", "proposals"),
      dataRoot: path.join(rootDir, "taiji-output", "data"),
      profileRoot: path.join(rootDir, "taiji-output", "profiling"),
      litRoot: path.join(rootDir, "taiji-output", "literature"),
    };
  }
  return {
    proposalsRoot: DEFAULT_PROPOSALS_ROOT,
    dataRoot: DEFAULT_DATA_ROOT,
    profileRoot: DEFAULT_PROFILE_ROOT,
    litRoot: DEFAULT_LIT_ROOT,
  };
}

function planDir(proposalsRoot, planId) {
  if (!/^[A-Za-z0-9_.\-]+$/.test(planId)) throw new Error(`Invalid --plan-id: ${planId}`);
  return joinSafeRelative(proposalsRoot, [planId]);
}

async function sha256OfFile(filePath) {
  const buf = await readFile(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

async function readJsonOptional(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readIndexEntries(litRoot) {
  try {
    const text = await readFile(path.join(litRoot, "index.jsonl"), "utf8");
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function buildScaffold({ planId, dataId, latencyBudgetMs, maxIters, dataManifestSha256, researchIndexSha256 }) {
  const lines = [];
  lines.push(`# 算法提案 ${planId}`);
  lines.push("");
  lines.push(`> 提案模板由 taac2026 propose init 生成。**所有占位符必须由人工填实**，否则 \`propose validate\` 会拒绝推进到 freeze。`);
  lines.push("");
  lines.push("## 1. 问题与目标");
  lines.push("");
  lines.push("- **任务**：CVR 预估（TAAC × KDD Cup 2026）。");
  lines.push("- **指标**：valid AUC（早停）+ 推理 p95 延迟 ≤ `latency_budget_ms`。");
  lines.push("- **比赛约束**：non-ensemble；不可使用外部预训练大模型作为推理 backbone。");
  lines.push("");
  lines.push("## 2. 数据假设");
  lines.push("");
  if (dataId) {
    lines.push(`- 数据集 ID：\`${dataId}\``);
  } else {
    lines.push("- 数据集 ID：**TODO**（运行 \`taac2026 data ingest\` 后回填）。");
  }
  lines.push(`- \`data_manifest_sha256\`：\`${dataManifestSha256 ?? "TODO（taac2026 data ingest --execute 后由 propose validate 自动校验）"}\``);
  lines.push("- 输入列结构、label 列、滑窗策略、训练/验证切分：**TODO**。");
  lines.push("");
  lines.push("## 3. 文献支撑");
  lines.push("");
  lines.push(`- \`research_index_sha256\`：\`${researchIndexSha256 ?? "TODO（taac2026 lit search/ingest 后由 propose validate 自动校验）"}\``);
  lines.push("- ≥3 条 \`evidence_score.relevance >= 0.6\` 的候选论文支撑（运行 \`taac2026 lit list --top 8 --min-relevance 0.6\` 列出）：");
  lines.push("  1. **TODO** — 引用 ID、相关性、对本方案的具体贡献");
  lines.push("  2. **TODO**");
  lines.push("  3. **TODO**");
  lines.push("");
  lines.push("## 4. 算法方案");
  lines.push("");
  lines.push("- 主干：**TODO**（描述网络 / 特征 / loss）");
  lines.push("- `non_ensemble_ack: true`（确认不使用 stacking / voting / blending）");
  lines.push("- 与已知 SOTA 的差异：**TODO**");
  lines.push("");
  lines.push("## 5. 实验计划");
  lines.push("");
  lines.push(`- \`max_iters\`：\`${maxIters ?? 12}\``);
  lines.push("- 早停：valid AUC 连续 N 轮 < threshold_delta。");
  lines.push("- 多 seed 95% CI（设计稿 R13 缓解项）：**TODO** 给出 seed 列表。");
  lines.push("- GPU / 时长预算：**TODO**。");
  lines.push("");
  lines.push("## 6. 延迟预算");
  lines.push("");
  lines.push(`- \`latency_budget_ms\`：\`${latencyBudgetMs ?? 25}\``);
  lines.push("- benchmark 协议：**TODO**（输入 batch / 序列长度 / 目标硬件）。");
  lines.push("- p95 / p99 目标：**TODO**。");
  lines.push("");
  lines.push("## 7. 风险与回滚");
  lines.push("");
  lines.push("- **R13 val 过拟合**：多 seed 95% CI + 合规 gate 双闸（compliance-reviewer subagent）。");
  lines.push("- **R7 推理延迟超预算**：失败时降级到 `<降级方案 TODO>`。");
  lines.push("- **数据漂移**：`schema.lock.json` 在每轮 `data profile` 自动校验。");
  lines.push("- 回滚步骤：**TODO**。");
  lines.push("");
  return lines.join("\n");
}

async function findDatasetManifest(dataRoot, dataId) {
  if (!dataId) return null;
  try {
    const manifestPath = path.join(dataRoot, dataId, "manifest.json");
    await stat(manifestPath);
    return manifestPath;
  } catch {
    return null;
  }
}

async function readState(planDirAbs) {
  return (await readJsonOptional(path.join(planDirAbs, "state.json"))) ?? { state: "draft", history: [] };
}

async function writeState(planDirAbs, state) {
  await mkdir(planDirAbs, { recursive: true });
  await atomicWriteJson(path.join(planDirAbs, "state.json"), state);
}

export async function initProposal({ planId, dataId, latencyBudgetMs, maxIters, rootDir }) {
  if (!planId) throw new Error("Missing --plan-id");
  const { proposalsRoot, dataRoot, litRoot } = rootsFor({ rootDir });
  const dir = planDir(proposalsRoot, planId);
  await mkdir(dir, { recursive: true });

  const manifestPath = await findDatasetManifest(dataRoot, dataId);
  const dataManifestSha256 = manifestPath ? await sha256OfFile(manifestPath) : null;
  const indexPath = path.join(litRoot, "index.jsonl");
  let researchIndexSha256 = null;
  try {
    researchIndexSha256 = await sha256OfFile(indexPath);
  } catch {}

  const scaffold = buildScaffold({
    planId,
    dataId,
    latencyBudgetMs: latencyBudgetMs ? Number(latencyBudgetMs) : null,
    maxIters: maxIters ? Number(maxIters) : null,
    dataManifestSha256,
    researchIndexSha256,
  });
  const proposalPath = path.join(dir, "proposal.md");
  await atomicWriteFile(proposalPath, scaffold);

  const state = await readState(dir);
  state.state = state.state === "draft" ? "draft" : state.state;
  state.plan_id = planId;
  state.scaffold_at = new Date().toISOString();
  state.history = [...(state.history ?? []), { ts: new Date().toISOString(), event: "init", note: "scaffold written" }];
  await writeState(dir, state);

  return { plan_id: planId, dir, proposal_path: proposalPath, data_manifest_sha256: dataManifestSha256, research_index_sha256: researchIndexSha256, state: state.state };
}

function checkSections(markdown) {
  const missing = [];
  for (const section of REQUIRED_SECTIONS) {
    if (!section.patterns.some((re) => re.test(markdown))) {
      missing.push(`${section.id}. ${section.title}`);
    }
  }
  return missing;
}

function findInlineSha256(markdown, key) {
  const re = new RegExp(`${key}[^\`]*\`([0-9a-f]{64})\``, "i");
  return markdown.match(re)?.[1] ?? null;
}

function checkPlaceholders(markdown) {
  const placeholderHits = (markdown.match(/\bTODO\b/g) ?? []).length;
  return placeholderHits;
}

export async function validateProposal({ planId, rootDir, minRelevance = 0.6, minPapers = 3 }) {
  if (!planId) throw new Error("Missing --plan-id");
  const { proposalsRoot, dataRoot, litRoot } = rootsFor({ rootDir });
  const dir = planDir(proposalsRoot, planId);
  const proposalPath = path.join(dir, "proposal.md");
  let markdown;
  try {
    markdown = await readFile(proposalPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Proposal not found: ${proposalPath} — run \`taac2026 propose init --plan-id ${planId}\` first.`);
    throw error;
  }

  const issues = [];
  const missing = checkSections(markdown);
  if (missing.length) issues.push({ kind: "missing_section", missing });

  const placeholderCount = checkPlaceholders(markdown);
  if (placeholderCount > 0) issues.push({ kind: "todo_placeholders", count: placeholderCount });

  const dataManifestSha256 = findInlineSha256(markdown, "data_manifest_sha256");
  const researchIndexSha256 = findInlineSha256(markdown, "research_index_sha256");
  if (!dataManifestSha256) issues.push({ kind: "missing_data_manifest_sha256" });
  if (!researchIndexSha256) issues.push({ kind: "missing_research_index_sha256" });

  // Cross-check SHA256 vs current files when possible.
  if (dataManifestSha256) {
    const dataIdMatch = markdown.match(/数据集 ID：\s*`([^`]+)`/);
    if (dataIdMatch) {
      const manifestPath = path.join(dataRoot, dataIdMatch[1], "manifest.json");
      try {
        const onDisk = await sha256OfFile(manifestPath);
        if (onDisk !== dataManifestSha256) {
          issues.push({ kind: "data_manifest_sha256_mismatch", expected: dataManifestSha256, on_disk: onDisk });
        }
      } catch (error) {
        issues.push({ kind: "data_manifest_unreadable", path: manifestPath, error: error.message });
      }
    }
  }
  if (researchIndexSha256) {
    const indexPath = path.join(litRoot, "index.jsonl");
    try {
      const onDisk = await sha256OfFile(indexPath);
      if (onDisk !== researchIndexSha256) {
        issues.push({ kind: "research_index_sha256_mismatch", expected: researchIndexSha256, on_disk: onDisk });
      }
    } catch (error) {
      issues.push({ kind: "research_index_unreadable", path: indexPath, error: error.message });
    }
  }

  // ≥ minPapers entries in index.jsonl with relevance ≥ minRelevance.
  const entries = await readIndexEntries(litRoot);
  const relevantCount = entries.filter((e) => (e.evidence_score?.relevance ?? 0) >= minRelevance).length;
  if (relevantCount < minPapers) {
    issues.push({ kind: "insufficient_evidence", required: minPapers, have: relevantCount, threshold: minRelevance });
  }

  // non_ensemble_ack and latency_budget present.
  if (!/non_ensemble_ack[^\n]*true/i.test(markdown)) issues.push({ kind: "non_ensemble_ack_missing" });
  if (!/latency_budget_ms[^\n]*\d+/.test(markdown)) issues.push({ kind: "latency_budget_ms_missing" });

  const ok = issues.length === 0;
  return { plan_id: planId, ok, issues, data_manifest_sha256: dataManifestSha256, research_index_sha256: researchIndexSha256 };
}

export async function freezeProposal({ planId, execute = false, yes = false, rootDir }) {
  if (!planId) throw new Error("Missing --plan-id");
  const { proposalsRoot, dataRoot, litRoot } = rootsFor({ rootDir });
  const dir = planDir(proposalsRoot, planId);

  const validation = await validateProposal({ planId, rootDir });
  if (!validation.ok) {
    const error = new Error(`Cannot freeze: validation failed (${validation.issues.length} issue${validation.issues.length === 1 ? "" : "s"}).`);
    error.code = "VALIDATION_FAILED";
    error.issues = validation.issues;
    throw error;
  }

  const proposalPath = path.join(dir, "proposal.md");
  const proposalSha256 = await sha256OfFile(proposalPath);
  const proposalJson = {
    plan_id: planId,
    proposal_sha256: proposalSha256,
    data_manifest_sha256: validation.data_manifest_sha256,
    research_index_sha256: validation.research_index_sha256,
    non_ensemble_ack: true,
    latency_budget_ms: Number((await readFile(proposalPath, "utf8")).match(/latency_budget_ms[^`]*`(\d+)`/)?.[1] ?? 25),
    max_iters: Number((await readFile(proposalPath, "utf8")).match(/max_iters[^`]*`(\d+)`/)?.[1] ?? 12),
    schedule_window: "00:00-08:00 Asia/Shanghai",
    compliance_acks: { non_ensemble: true, license: true, no_pii: true },
    frozen_at: new Date().toISOString(),
    state: "reviewed_by_compliance",
  };

  const plan = { plan_id: planId, dir, proposal_json_preview: proposalJson, mode: execute ? "execute" : "dry-run" };
  if (!execute) return plan;
  if (!yes) throw new Error("--execute requires --yes");

  await atomicWriteJson(path.join(dir, "proposal.json"), proposalJson);

  const state = await readState(dir);
  state.state = "reviewed_by_compliance";
  state.history = [...(state.history ?? []), { ts: new Date().toISOString(), event: "freeze", proposal_sha256: proposalSha256 }];
  await writeState(dir, state);
  return { ...plan, written: true, state: state.state };
}

export async function statusProposal({ planId, rootDir }) {
  if (!planId) throw new Error("Missing --plan-id");
  const { proposalsRoot } = rootsFor({ rootDir });
  const dir = planDir(proposalsRoot, planId);
  const state = await readState(dir);
  const proposalJson = await readJsonOptional(path.join(dir, "proposal.json"));
  return { plan_id: planId, dir, state: state.state, history: state.history ?? [], proposal: proposalJson };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command || args.command === "--help") {
    console.log(usage());
    return;
  }

  if (args.command === "init") {
    const result = await initProposal({
      planId: args.planId,
      dataId: args.dataId,
      latencyBudgetMs: args.latencyBudgetMs,
      maxIters: args.maxIters,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === "validate") {
    const result = await validateProposal({ planId: args.planId });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  if (args.command === "freeze") {
    try {
      const result = await freezeProposal({ planId: args.planId, execute: args.execute, yes: args.yes });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      if (error.code === "VALIDATION_FAILED") {
        console.error(JSON.stringify({ error: error.message, issues: error.issues }, null, 2));
        process.exitCode = 2;
        return;
      }
      throw error;
    }
    return;
  }
  if (args.command === "status") {
    const result = await statusProposal({ planId: args.planId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error(`Unknown subcommand: ${args.command}`);
  console.error(usage());
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

export { STATES };
