// Gate-checking primitives for the M6 submit-escalate state machine.
//
// Each gate function returns a uniform shape:
//   { passed: boolean, evidence: string|object, reason?: string }
//
// All checks are READ-ONLY against on-disk artefacts produced by earlier
// milestones (M1 manifest / profile, M2 lit index, M3 proposal.json /
// review-token, M4-M5 loop-state). Nothing here mutates state — the
// state machine in submit-escalate.mjs is responsible for persisting
// decisions.

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { verifyToken } from "./_hmac.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_PROPOSALS_ROOT = path.join(ROOT, "taiji-output", "proposals");
const DEFAULT_DATA_ROOT = path.join(ROOT, "taiji-output", "data");
const DEFAULT_PROFILE_ROOT = path.join(ROOT, "taiji-output", "profiling");
const DEFAULT_LITERATURE_ROOT = path.join(ROOT, "taiji-output", "literature");
const DEFAULT_LOOPS_ROOT = path.join(ROOT, "taiji-output", "state", "loops");
const DEFAULT_SECRETS_DIR = path.join(ROOT, "taiji-output", "secrets");
const DEFAULT_QUOTA_PATH = path.join(ROOT, "taiji-output", "state", "quota-state.json");
const DEFAULT_TOKEN_PATH = path.join(ROOT, "taiji-output", "state", ".review-token-submit");

const ENSEMBLE_KEYWORDS = [
  "StackingClassifier",
  "StackingRegressor",
  "VotingClassifier",
  "VotingRegressor",
  "BlendEnsemble",
  "xgb_lgb_blend",
  "model_avg",
  "ensemble_predict",
  "stacking",
];

const LICENSE_ALLOWLIST = new Set([
  "cc-by-nc-4.0",
  "cc-by-4.0",
  "mit",
  "apache-2.0",
  "bsd-3-clause",
]);

function rootsFor({ rootDir }) {
  if (!rootDir) {
    return {
      proposalsRoot: DEFAULT_PROPOSALS_ROOT,
      dataRoot: DEFAULT_DATA_ROOT,
      profileRoot: DEFAULT_PROFILE_ROOT,
      literatureRoot: DEFAULT_LITERATURE_ROOT,
      loopsRoot: DEFAULT_LOOPS_ROOT,
      secretsDir: DEFAULT_SECRETS_DIR,
      quotaStatePath: DEFAULT_QUOTA_PATH,
      submitTokenPath: DEFAULT_TOKEN_PATH,
      repoRoot: ROOT,
    };
  }
  return {
    proposalsRoot: path.join(rootDir, "taiji-output", "proposals"),
    dataRoot: path.join(rootDir, "taiji-output", "data"),
    profileRoot: path.join(rootDir, "taiji-output", "profiling"),
    literatureRoot: path.join(rootDir, "taiji-output", "literature"),
    loopsRoot: path.join(rootDir, "taiji-output", "state", "loops"),
    secretsDir: path.join(rootDir, "taiji-output", "secrets"),
    quotaStatePath: path.join(rootDir, "taiji-output", "state", "quota-state.json"),
    submitTokenPath: path.join(rootDir, "taiji-output", "state", ".review-token-submit"),
    repoRoot: rootDir,
  };
}

async function sha256OfFile(filePath) {
  const buf = await readFile(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

// ---------- local_gate ----------

// "本地指标确实有提升": uses the last loop's iter_history. Default check:
// last iter val_auc >= max(prior 3 iters val_auc) + threshold_delta.
// Multi-seed CI is out of scope for M6 — flagged as TODO so it surfaces
// in the audit trail rather than silently passing.
export async function checkLocalGate({ planId, rootDir, thresholdDelta = 0.001 } = {}) {
  if (!planId) return { passed: false, evidence: null, reason: "missing plan_id" };
  const { loopsRoot } = rootsFor({ rootDir });
  let state;
  try {
    state = await readJson(path.join(loopsRoot, planId, "loop-state.json"));
  } catch (error) {
    return { passed: false, evidence: null, reason: `loop-state.json not found: ${error.message}` };
  }
  const history = state.iter_history ?? [];
  if (history.length < 2) {
    return { passed: false, evidence: { iter_count: history.length }, reason: "fewer than 2 iters in loop history" };
  }
  const tail = history.slice(-4);
  const last = tail[tail.length - 1].metrics?.val_auc;
  const baseline = Math.max(...tail.slice(0, -1).map((h) => h.metrics?.val_auc ?? -Infinity));
  if (!Number.isFinite(last) || !Number.isFinite(baseline)) {
    return { passed: false, evidence: { last, baseline }, reason: "val_auc not numeric" };
  }
  const delta = last - baseline;
  return {
    passed: delta >= thresholdDelta,
    evidence: { last_val_auc: Number(last.toFixed(6)), baseline_val_auc: Number(baseline.toFixed(6)), delta: Number(delta.toFixed(6)), threshold_delta: thresholdDelta },
    reason: delta >= thresholdDelta ? null : `val_auc delta ${delta.toFixed(6)} < threshold ${thresholdDelta}`,
    todo: "M6 does not yet enforce multi-seed 95% CI (design R13). Flag-only.",
  };
}

// ---------- compliance_gate ----------

// Walks the candidate inference_code directory (or repo subset) looking
// for ensemble keywords. Returns the first 5 hits with file:line.
async function grepEnsembleKeywords(searchRoot, { maxFiles = 500, maxBytes = 1_000_000 } = {}) {
  const hits = [];
  let scanned = 0;
  async function walk(dir) {
    if (hits.length >= 10) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      if (hits.length >= 10 || scanned >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", ".git", "__pycache__", "taiji-output"].includes(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (!/\.(py|mjs|js|ts|tsx|cjs|sh|yaml|yml|json|md)$/i.test(lower)) continue;
      let s;
      try { s = await stat(full); } catch { continue; }
      if (s.size > maxBytes) continue;
      scanned += 1;
      let text;
      try { text = await readFile(full, "utf8"); } catch { continue; }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        for (const needle of ENSEMBLE_KEYWORDS) {
          if (lines[i].includes(needle)) {
            hits.push({ file: full, line: i + 1, keyword: needle, snippet: lines[i].trim().slice(0, 200) });
            if (hits.length >= 10) return;
            break;
          }
        }
      }
    }
  }
  await walk(searchRoot);
  return hits;
}

export async function checkComplianceGate({ planId, candidateBundle, rootDir, latencyBudgetMs } = {}) {
  if (!planId) return { passed: false, evidence: null, reason: "missing plan_id" };
  const { proposalsRoot, dataRoot, literatureRoot, loopsRoot, repoRoot } = rootsFor({ rootDir });
  const issues = [];
  const evidence = {};

  // 1) proposal.json + 3 SHA256 still match.
  let proposal;
  try {
    proposal = await readJson(path.join(proposalsRoot, planId, "proposal.json"));
    evidence.proposal_path = path.join(proposalsRoot, planId, "proposal.json");
  } catch (error) {
    issues.push({ kind: "proposal_missing", error: error.message });
    return { passed: false, evidence, reason: issues.map((i) => i.kind).join(",") };
  }
  const mdPath = path.join(proposalsRoot, planId, "proposal.md");
  try {
    const onDisk = await sha256OfFile(mdPath);
    evidence.proposal_md_sha256 = onDisk;
    if (onDisk !== proposal.proposal_sha256) {
      issues.push({ kind: "proposal_sha256_mismatch", expected: proposal.proposal_sha256, on_disk: onDisk });
    }
  } catch (error) { issues.push({ kind: "proposal_md_unreadable", error: error.message }); }

  if (proposal.data_manifest_sha256) {
    // We don't know which dataset id without re-parsing markdown; instead, scan all manifests.
    try {
      const datasets = await readdir(dataRoot, { withFileTypes: true });
      let matched = false;
      for (const entry of datasets) {
        if (!entry.isDirectory()) continue;
        const manifestPath = path.join(dataRoot, entry.name, "manifest.json");
        try {
          if ((await sha256OfFile(manifestPath)) === proposal.data_manifest_sha256) {
            matched = true;
            evidence.data_manifest_dataset_id = entry.name;
            break;
          }
        } catch {}
      }
      if (!matched) issues.push({ kind: "data_manifest_sha256_no_match" });
    } catch (error) {
      issues.push({ kind: "data_root_unreadable", error: error.message });
    }
  }

  if (proposal.research_index_sha256) {
    try {
      const onDisk = await sha256OfFile(path.join(literatureRoot, "index.jsonl"));
      evidence.research_index_sha256 = onDisk;
      if (onDisk !== proposal.research_index_sha256) issues.push({ kind: "research_index_sha256_mismatch" });
    } catch (error) {
      issues.push({ kind: "research_index_unreadable", error: error.message });
    }
  }

  // 2) non_ensemble_ack present and no ensemble keywords in candidate bundle.
  if (!proposal.non_ensemble_ack) issues.push({ kind: "non_ensemble_ack_missing_in_proposal_json" });
  const grepRoot = candidateBundle ? path.resolve(candidateBundle) : repoRoot;
  evidence.ensemble_grep_root = grepRoot;
  const ensembleHits = await grepEnsembleKeywords(grepRoot);
  evidence.ensemble_keyword_hits = ensembleHits;
  if (ensembleHits.length > 0) issues.push({ kind: "ensemble_keywords_present", count: ensembleHits.length });

  // 3) latency budget. Pull last iter's metrics (if present) and compare.
  const budget = Number(latencyBudgetMs ?? proposal.latency_budget_ms ?? 0) || null;
  evidence.latency_budget_ms = budget;
  try {
    const loopState = await readJson(path.join(loopsRoot, planId, "loop-state.json"));
    const last = loopState.iter_history?.at(-1);
    const p95 = last?.metrics?.latency?.p95_ms ?? last?.metrics?.p95_latency_ms ?? null;
    evidence.latency_p95_ms = p95;
    if (budget && Number.isFinite(p95) && p95 > budget) {
      issues.push({ kind: "latency_p95_over_budget", p95_ms: p95, budget_ms: budget });
    } else if (budget && p95 == null) {
      // No latency data yet — note but do not block in M6 (tests may run
      // without latency profile).
      evidence.latency_note = "no p95 latency in last iter metrics; gate flagged as advisory";
    }
  } catch {
    evidence.latency_note = "loop-state.json missing — cannot verify latency";
  }

  // 4) leakage red flags from data-profile (if present for the matched dataset).
  if (evidence.data_manifest_dataset_id) {
    try {
      const profile = await readJson(path.join(rootsFor({ rootDir }).profileRoot, evidence.data_manifest_dataset_id, "profile.json"));
      evidence.leakage_red_flags = profile.leakage_red_flags ?? [];
      if ((profile.leakage_red_flags ?? []).length > 0) {
        issues.push({ kind: "leakage_red_flags_present", count: profile.leakage_red_flags.length });
      }
    } catch {
      evidence.leakage_note = "profile.json missing — leakage check skipped (advisory)";
    }
  }

  // 5) license allowlist.
  if (evidence.data_manifest_dataset_id) {
    try {
      const manifest = await readJson(path.join(dataRoot, evidence.data_manifest_dataset_id, "manifest.json"));
      const license = String(manifest.license?.id ?? "").toLowerCase();
      evidence.dataset_license = license;
      if (license && !LICENSE_ALLOWLIST.has(license)) {
        issues.push({ kind: "license_not_in_allowlist", license });
      }
    } catch {}
  }

  return {
    passed: issues.length === 0,
    evidence,
    reason: issues.length === 0 ? null : issues.map((i) => i.kind).join(","),
    issues,
  };
}

// ---------- quota_gate ----------

function todayLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function checkQuotaGate({ rootDir, dailyHardCeiling = 0 } = {}) {
  const { quotaStatePath } = rootsFor({ rootDir });
  let state = { daily_official_used: {} };
  try { state = await readJson(quotaStatePath); } catch {}
  const day = todayLocal();
  const used = state.daily_official_used?.[day] ?? 0;
  return {
    passed: used < dailyHardCeiling,
    evidence: { day, used_today: used, daily_hard_ceiling: dailyHardCeiling, daily_official_used: state.daily_official_used ?? {} },
    reason: used < dailyHardCeiling ? null : `daily_official_used[${day}]=${used} >= daily_hard_ceiling=${dailyHardCeiling}`,
  };
}

// ---------- human_approval gate ----------

export async function checkHumanApprovalGate({ planId, rootDir, now = () => new Date() } = {}) {
  const { secretsDir, submitTokenPath } = rootsFor({ rootDir });
  let token;
  try {
    token = await readJson(submitTokenPath);
  } catch (error) {
    return { passed: false, evidence: { token_path: submitTokenPath }, reason: `submit_token missing: ${error.message}` };
  }
  let key;
  try {
    key = (await readFile(path.join(secretsDir, "review.hmac.key"), "utf8")).trim();
  } catch (error) {
    return { passed: false, evidence: null, reason: `hmac key missing: ${error.message}` };
  }
  const result = verifyToken(token, key, { now });
  if (!result.ok) return { passed: false, evidence: { token_kind: token.kind, token_plan_id: token.plan_id }, reason: result.reason };
  if (token.kind !== "submit") return { passed: false, evidence: null, reason: `token kind=${token.kind} expected submit` };
  if (token.plan_id !== planId) return { passed: false, evidence: null, reason: `plan_id mismatch token=${token.plan_id} expected=${planId}` };
  if (!String(token.approver ?? "").includes("+human:")) {
    return { passed: false, evidence: { approver: token.approver }, reason: "submit_token requires two human approvers (approver field must contain '+human:')" };
  }
  return { passed: true, evidence: { approver: token.approver, expires_at: token.expires_at } };
}

// ---------- submit_dry_run gate ----------

function spawnAndCapture(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const child = (options.spawnFn ?? spawn)(cmd, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on?.("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on?.("data", (chunk) => { stderr += chunk.toString(); });
    const timer = options.timeoutMs ? setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, options.timeoutMs) : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + (error.message ?? String(error)) });
    });
  });
}

export async function checkSubmitDryRun({ candidateBundle, templateJobInternalId, rootDir, spawnFn, scriptOverride } = {}) {
  if (!candidateBundle) return { passed: false, evidence: null, reason: "missing candidateBundle" };
  if (!templateJobInternalId) return { passed: false, evidence: null, reason: "missing templateJobInternalId" };
  const { repoRoot } = rootsFor({ rootDir });
  const submitScript = scriptOverride ?? path.join(repoRoot, "scripts", "submit-taiji.mjs");
  const args = [submitScript, "--bundle", path.resolve(candidateBundle), "--template-job-internal-id", String(templateJobInternalId)];
  const result = await spawnAndCapture(process.execPath, args, { cwd: repoRoot, spawnFn, timeoutMs: 60_000 });
  return {
    passed: result.code === 0,
    evidence: { exit_code: result.code, stdout_tail: result.stdout.slice(-500), stderr_tail: result.stderr.slice(-500) },
    reason: result.code === 0 ? null : `submit dry-run exit=${result.code}`,
  };
}

export { ENSEMBLE_KEYWORDS, LICENSE_ALLOWLIST, todayLocal };
