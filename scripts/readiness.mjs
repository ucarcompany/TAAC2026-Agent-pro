#!/usr/bin/env node
// Stage-0 readiness gate (skill-expansion-design-2026-05-07.md §2).
//
// Checks that the P0/P1 fixes from code-audit-2026-05-07.md are in place
// and that secrets that production paths depend on are present. Writes a
// machine-readable report to taiji-output/state/readiness.json and exits 2
// when the readiness status is "blocked".
//
// Status mapping:
//   - any p0_* check failing  → "blocked"  (CLI hard-gate denies submit/loop)
//   - any p1_* check failing  → "warning"  (allowed but discouraged)
//   - secrets missing only    → "warning"
//   - all green               → "ready"

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_STATE_DIR = path.join(ROOT, "taiji-output", "state");
const DEFAULT_REPORT = path.join(DEFAULT_STATE_DIR, "readiness.json");
const DEFAULT_SECRETS_DIR = path.join(ROOT, "taiji-output", "secrets");

function usage() {
  return `Usage:
  taac2026 readiness check [--out <readiness.json>]
  node scripts/readiness.mjs check [--out <readiness.json>]

Writes taiji-output/state/readiness.json. Exits 2 if status is "blocked".`;
}

function parseArgs(argv) {
  const args = { command: argv[0] === "check" ? "check" : argv[0] };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--out" && argv[i + 1]) args.out = argv[++i];
  }
  return args;
}

async function readIfExists(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function tag(passed, evidence) {
  return { passed: Boolean(passed), evidence: evidence ?? "" };
}

export async function runReadinessCheck({ rootDir = ROOT, secretsDir = DEFAULT_SECRETS_DIR } = {}) {
  const scripts = path.join(rootDir, "scripts");
  const [scrape, submit, http] = await Promise.all([
    readIfExists(path.join(scripts, "scrape-taiji.mjs")),
    readIfExists(path.join(scripts, "submit-taiji.mjs")),
    readIfExists(path.join(scripts, "_taiji-http.mjs")),
  ]);

  const checks = {
    p0_cookie_isolation: tag(
      Boolean(scrape && /assertArtifactHostAllowed/.test(scrape)) && Boolean(http && /assertCookieHostAllowed/.test(http)),
      "scripts/_taiji-http.mjs::assertCookieHostAllowed; scripts/scrape-taiji.mjs::fetchBinaryResource"
    ),
    p0_path_traversal: tag(
      Boolean(scrape && /joinSafeRelative/.test(scrape) && /Unsafe path segment/.test(scrape)),
      "scripts/scrape-taiji.mjs::safeRelativeFilePath / saveJobCodeFiles"
    ),
    p0_submit_silent_fallback: tag(
      Boolean(submit && /--execute requires --cookie-file/.test(submit)),
      "scripts/submit-taiji.mjs::main"
    ),
    p1_http_timeout: tag(
      Boolean(http && /AbortSignal\.timeout/.test(http)),
      "scripts/_taiji-http.mjs::fetchWithRetry"
    ),
    p1_atomic_state_write: tag(
      Boolean(scrape && /atomicWriteJson/.test(scrape) && /persistAllJobsArtifacts/.test(scrape)),
      "scripts/scrape-taiji.mjs::persistAllJobsArtifacts"
    ),
    p1_cos_token_reuse: tag(
      Boolean(submit && /COS_CLIENT_CACHE/.test(submit)),
      "scripts/submit-taiji.mjs::getCachedCosClient"
    ),
    p1_error_code_validation: tag(
      Boolean(http && /Taiji error\.code=/.test(http)),
      "scripts/_taiji-http.mjs::fetchTaijiJson"
    ),
    p1_partial_metrics: tag(
      Boolean(scrape && /Promise\.allSettled/.test(scrape) && /partialErrors/.test(scrape)),
      "scripts/scrape-taiji.mjs::fetchInstanceOutput"
    ),
    secrets_present: {
      cookie: await fileExists(path.join(secretsDir, "taiji.cookie.json")),
      review_hmac: await fileExists(path.join(secretsDir, "review.hmac.key")),
    },
  };

  const blockers = [];
  const warnings = [];
  for (const [key, value] of Object.entries(checks)) {
    if (key === "secrets_present") continue;
    if (key.startsWith("p0_") && !value.passed) blockers.push(key);
    if (key.startsWith("p1_") && !value.passed) warnings.push(key);
  }
  if (!checks.secrets_present.cookie) warnings.push("secrets.cookie");
  if (!checks.secrets_present.review_hmac) warnings.push("secrets.review_hmac");

  const status = blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "ready";

  return {
    version: 1,
    checked_at: new Date().toISOString(),
    status,
    checks,
    blockers,
    warnings,
  };
}

// Synchronous gate used by bin/taac2026.mjs before executing high-risk
// commands. Returns { ok, status, blockers } so the CLI can decide whether
// to abort with exit 2.
export async function loadReadinessOrExit(rootDir = ROOT) {
  const reportPath = path.join(rootDir, "taiji-output", "state", "readiness.json");
  const text = await readIfExists(reportPath);
  if (!text) {
    return { ok: false, status: "unknown", blockers: ["readiness_not_run"], reportPath };
  }
  try {
    const report = JSON.parse(text);
    return { ok: report.status === "ready", status: report.status, blockers: report.blockers ?? [], reportPath };
  } catch {
    return { ok: false, status: "unparseable", blockers: ["readiness_unparseable"], reportPath };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (args.command && args.command !== "check")) {
    console.log(usage());
    if (args.command && args.command !== "check") process.exitCode = 2;
    return;
  }

  const reportPath = args.out ? path.resolve(args.out) : DEFAULT_REPORT;
  const report = await runReadinessCheck();

  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`readiness: status=${report.status}`);
  if (report.blockers.length) console.log(`  blockers: ${report.blockers.join(", ")}`);
  if (report.warnings.length) console.log(`  warnings: ${report.warnings.join(", ")}`);
  console.log(`Wrote ${reportPath}`);

  if (report.status === "blocked") process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
