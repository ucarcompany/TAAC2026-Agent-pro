#!/usr/bin/env node
// submit-escalate state machine — M6 of skill-expansion-design-2026-05-07.md §14.
//
// Subcommands:
//   submit-escalate init     --plan-id <id> --candidate-bundle <dir>
//                                           --template-job-internal-id <id>
//                                           [--latency-budget-ms 25]
//                                           [--daily-hard-ceiling 1]
//   submit-escalate status   --plan-id <id>
//   submit-escalate advance  --plan-id <id> [--gate <name>] --execute --yes
//   submit-escalate reset    --plan-id <id> [--to <state>] --execute --yes
//
// State machine (linear; advance respects insertion order):
//   candidate
//     ↳ local_gate_passed
//     ↳ compliance_gate_passed
//     ↳ quota_available
//     ↳ human_second_approved
//     ↳ submit_dry_run_verified
//     ↳ submitted              (M7 — not implemented yet)
//
// All state writes are atomic (tmp + rename); each gate decision is also
// dropped to taiji-output/state/submits/<plan-id>/decisions/<gate>-<ts>.json
// for offline audit and reproducibility.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteJson, joinSafeRelative } from "./_taiji-http.mjs";
import { appendEvent } from "./_events.mjs";
import {
  checkComplianceGate,
  checkHumanApprovalGate,
  checkLocalGate,
  checkQuotaGate,
  checkSubmitDryRun,
} from "./_compliance.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_SUBMITS_ROOT = path.join(ROOT, "taiji-output", "state", "submits");

// Ordered list of (gate name, target state). advance walks this in order.
export const GATE_ORDER = [
  { name: "local_gate",      to: "local_gate_passed" },
  { name: "compliance_gate", to: "compliance_gate_passed" },
  { name: "quota_gate",      to: "quota_available" },
  { name: "human_approval",  to: "human_second_approved" },
  { name: "submit_dry_run",  to: "submit_dry_run_verified" },
];

export const STATES = [
  "candidate",
  "local_gate_passed",
  "compliance_gate_passed",
  "quota_available",
  "human_second_approved",
  "submit_dry_run_verified",
  "submitted",
  "eval_created",
  "eval_completed",
  "archived",
];

const STATE_INDEX = new Map(STATES.map((s, i) => [s, i]));

function usage() {
  return `Usage:
  taac2026 submit-escalate init     --plan-id <id> --candidate-bundle <dir>
                                    --template-job-internal-id <id>
                                    [--latency-budget-ms 25]
                                    [--daily-hard-ceiling 1]
  taac2026 submit-escalate status   --plan-id <id>
  taac2026 submit-escalate advance  --plan-id <id> [--gate <name>] --execute --yes
  taac2026 submit-escalate reset    --plan-id <id> [--to <state>] --execute --yes

Gate order (must be advanced sequentially):
  local_gate → compliance_gate → quota_gate → human_approval → submit_dry_run

\`advance\` without --gate runs the next pending gate. With --gate, it
runs that specific gate (must be the next pending one). Each gate must
PASS before the next can be attempted; a FAIL is recorded in
decisions/<gate>-<ts>.json and the state is unchanged.
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
  const submitsRoot = rootDir ? path.join(rootDir, "taiji-output", "state", "submits") : DEFAULT_SUBMITS_ROOT;
  const eventsPath = rootDir
    ? path.join(rootDir, "taiji-output", "state", "events.ndjson")
    : path.join(ROOT, "taiji-output", "state", "events.ndjson");
  return { submitsRoot, eventsPath };
}

function planDir(submitsRoot, planId) {
  if (!/^[A-Za-z0-9_.\-]+$/.test(planId)) throw new Error(`Invalid --plan-id: ${planId}`);
  return joinSafeRelative(submitsRoot, [planId]);
}

async function loadState(planDirAbs) {
  try {
    return JSON.parse(await readFile(path.join(planDirAbs, "quota-state.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function saveState(planDirAbs, state, eventsPath, eventName) {
  await mkdir(planDirAbs, { recursive: true });
  await atomicWriteJson(path.join(planDirAbs, "quota-state.json"), state);
  if (eventName) {
    await appendEvent({
      event: eventName,
      actor: "cli:submit-escalate",
      payload: { plan_id: state.plan_id, state: state.state },
      eventsPath,
    });
  }
}

async function recordDecision(planDirAbs, gateName, decision) {
  const decisionsDir = path.join(planDirAbs, "decisions");
  await mkdir(decisionsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(decisionsDir, `${gateName}-${ts}.json`);
  await atomicWriteJson(filePath, { gate: gateName, recorded_at: ts, ...decision });
  return filePath;
}

function nextPendingGate(state) {
  // Find the gate whose target state immediately follows state.state.
  const currentIdx = STATE_INDEX.get(state.state) ?? -1;
  for (const gate of GATE_ORDER) {
    if (STATE_INDEX.get(gate.to) === currentIdx + 1) return gate;
  }
  return null;
}

export async function initEscalation({
  planId, candidateBundle, templateJobInternalId, latencyBudgetMs = 25,
  dailyHardCeiling = 1, rootDir,
}) {
  if (!planId) throw new Error("Missing --plan-id");
  if (!candidateBundle) throw new Error("Missing --candidate-bundle");
  if (!templateJobInternalId) throw new Error("Missing --template-job-internal-id");
  const { submitsRoot, eventsPath } = rootsFor({ rootDir });
  const planDirAbs = planDir(submitsRoot, planId);
  await mkdir(planDirAbs, { recursive: true });

  const existing = await loadState(planDirAbs);
  const state = {
    plan_id: planId,
    state: existing?.state ?? "candidate",
    candidate_bundle: path.resolve(candidateBundle),
    template_job_internal_id: String(templateJobInternalId),
    latency_budget_ms: Number(latencyBudgetMs),
    daily_hard_ceiling: Number(dailyHardCeiling),
    initialised_at: existing?.initialised_at ?? new Date().toISOString(),
    history: existing?.history ?? [],
    gate_results: existing?.gate_results ?? Object.fromEntries(GATE_ORDER.map((g) => [g.name, null])),
  };
  await saveState(planDirAbs, state, eventsPath, "submit_escalate.init");
  return { plan_id: planId, plan_dir: planDirAbs, state: state.state };
}

export async function statusEscalation({ planId, rootDir }) {
  const { submitsRoot } = rootsFor({ rootDir });
  const planDirAbs = planDir(submitsRoot, planId);
  const state = await loadState(planDirAbs);
  if (!state) throw new Error(`No submit-escalate state for ${planId} — run \`taac2026 submit-escalate init\` first.`);
  return { ...state, plan_dir: planDirAbs, next_gate: nextPendingGate(state)?.name ?? null };
}

export async function advanceEscalation({
  planId, gate, execute = false, yes = false, rootDir,
  // Test hooks — let unit tests substitute deterministic gate functions.
  gateRunners,
} = {}) {
  if (!planId) throw new Error("Missing --plan-id");
  const { submitsRoot, eventsPath } = rootsFor({ rootDir });
  const planDirAbs = planDir(submitsRoot, planId);
  const state = await loadState(planDirAbs);
  if (!state) throw new Error(`No state for ${planId} — init first.`);

  const next = nextPendingGate(state);
  if (!next) {
    return { plan_id: planId, state: state.state, message: "no further gates to advance (state is past M6 scope)" };
  }
  if (gate && gate !== next.name) {
    throw new Error(`Cannot advance via gate '${gate}'; the next pending gate is '${next.name}' (state=${state.state}).`);
  }

  const runners = gateRunners ?? {
    local_gate:      () => checkLocalGate({ planId, rootDir }),
    compliance_gate: () => checkComplianceGate({ planId, candidateBundle: state.candidate_bundle, latencyBudgetMs: state.latency_budget_ms, rootDir }),
    quota_gate:      () => checkQuotaGate({ rootDir, dailyHardCeiling: state.daily_hard_ceiling }),
    human_approval:  () => checkHumanApprovalGate({ planId, rootDir }),
    submit_dry_run:  () => checkSubmitDryRun({ candidateBundle: state.candidate_bundle, templateJobInternalId: state.template_job_internal_id, rootDir }),
  };

  if (!execute) {
    return {
      mode: "dry-run",
      plan_id: planId,
      state: state.state,
      next_gate: next.name,
      will_advance_to: next.to,
      note: "Re-run with --execute --yes to actually run the gate.",
    };
  }
  if (!yes) throw new Error("--execute requires --yes");

  const decision = await runners[next.name]();
  const decisionPath = await recordDecision(planDirAbs, next.name, decision);

  state.gate_results = { ...(state.gate_results ?? {}), [next.name]: { ...decision, recorded_at: new Date().toISOString(), decision_path: decisionPath } };
  if (decision.passed) {
    state.history = [...(state.history ?? []), { ts: new Date().toISOString(), from: state.state, to: next.to, gate: next.name }];
    state.state = next.to;
    await saveState(planDirAbs, state, eventsPath, "submit_escalate.gate.passed");
  } else {
    await saveState(planDirAbs, state, eventsPath, "submit_escalate.gate.failed");
  }
  return {
    plan_id: planId,
    state: state.state,
    gate: next.name,
    passed: decision.passed,
    reason: decision.reason ?? null,
    decision_path: decisionPath,
  };
}

export async function resetEscalation({ planId, to = "candidate", execute = false, yes = false, rootDir }) {
  if (!STATE_INDEX.has(to)) throw new Error(`Unknown reset target state: ${to}`);
  const { submitsRoot, eventsPath } = rootsFor({ rootDir });
  const planDirAbs = planDir(submitsRoot, planId);
  const state = await loadState(planDirAbs);
  if (!state) throw new Error(`No state for ${planId}`);

  if (!execute) {
    return { mode: "dry-run", plan_id: planId, would_reset_from: state.state, would_reset_to: to };
  }
  if (!yes) throw new Error("--execute requires --yes");

  // Drop gate_results for any state strictly after `to`.
  const targetIdx = STATE_INDEX.get(to);
  for (const gate of GATE_ORDER) {
    if (STATE_INDEX.get(gate.to) > targetIdx) state.gate_results[gate.name] = null;
  }
  state.history = [...(state.history ?? []), { ts: new Date().toISOString(), from: state.state, to, gate: "reset" }];
  state.state = to;
  await saveState(planDirAbs, state, eventsPath, "submit_escalate.reset");
  return { plan_id: planId, state: state.state, reset_to: to };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command || args.command === "--help") {
    console.log(usage());
    return;
  }

  if (args.command === "init") {
    const result = await initEscalation({
      planId: args.planId,
      candidateBundle: args.candidateBundle,
      templateJobInternalId: args.templateJobInternalId,
      latencyBudgetMs: args.latencyBudgetMs,
      dailyHardCeiling: args.dailyHardCeiling,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === "status") {
    const result = await statusEscalation({ planId: args.planId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === "advance") {
    const result = await advanceEscalation({
      planId: args.planId,
      gate: args.gate,
      execute: args.execute,
      yes: args.yes,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.passed === false) process.exitCode = 2;
    return;
  }
  if (args.command === "reset") {
    const result = await resetEscalation({
      planId: args.planId,
      to: args.to,
      execute: args.execute,
      yes: args.yes,
    });
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

export { GATE_ORDER as GATES, nextPendingGate };
