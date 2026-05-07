#!/usr/bin/env node
// auto-loop CLI — M4 of skill-expansion-design-2026-05-07.md §11.
//
// Subcommands:
//   loop init    --plan-id <id> [--config <yaml>] [--gpu-host <host>]
//   loop status  --plan-id <id>
//   loop run     --plan-id <id> [--max-iters N] [--from-iter N]
//                                [--execute --yes] [--seed <n>]
//   loop kill    --plan-id <id>
//   loop resume  --plan-id <id>
//
// M4 is dry-run-only end-to-end. The "remote runner" is a deterministic
// in-process stub (val_auc grows by ~0.005 / iter, with bounded noise),
// suitable for verifying state-machine correctness, KILL-switch latency,
// retry budgets, and atomic state writes. M5 swaps the stub for real
// SSH + scp/rsync against a GPU host.

import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFile, atomicWriteJson, joinSafeRelative } from "./_taiji-http.mjs";
import { appendEvent } from "./_events.mjs";
import { defaultLoopConfig, parseLoopConfig, renderLoopConfigYaml } from "./_loop-config.mjs";
import { buildRemoteRunner } from "./_remote-runner.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_LOOP_ROOT = path.join(ROOT, "taiji-output", "state", "loops");

export const STATES = Object.freeze([
  "idle",
  "planned",
  "approved",
  "queued",
  "running_iter",
  "collecting_metrics",
  "analyzing",
  "proposing_next",
  "completed",
  "paused",
  "failed",
  "killed",
]);

const TERMINAL = new Set(["completed", "failed", "killed"]);

// Linear advancement table — every transition must be explicitly allowed.
// Branches (paused/failed/killed) can interrupt from any non-terminal
// state but cannot themselves transition forward except through `resume`.
const ALLOWED_TRANSITIONS = new Map([
  ["idle",                ["planned", "killed"]],
  ["planned",             ["approved", "paused", "killed"]],
  ["approved",            ["queued", "paused", "killed"]],
  ["queued",              ["running_iter", "paused", "killed"]],
  ["running_iter",        ["collecting_metrics", "failed", "paused", "killed"]],
  ["collecting_metrics",  ["analyzing", "failed", "paused", "killed"]],
  ["analyzing",           ["proposing_next", "failed", "paused", "killed"]],
  ["proposing_next",      ["queued", "completed", "paused", "killed"]],
  ["paused",              ["queued", "killed"]],
  // Terminal states have no outgoing transitions.
  ["completed",           []],
  ["failed",              []],
  ["killed",              []],
]);

function usage() {
  return `Usage:
  taac2026 loop init    --plan-id <id> [--config <yaml>] [--gpu-host <host>] [--remote-host <ssh-alias>]
  taac2026 loop status  --plan-id <id>
  taac2026 loop run     --plan-id <id> [--max-iters N] [--seed <n>] [--execute --yes]
  taac2026 loop kill    --plan-id <id>
  taac2026 loop resume  --plan-id <id>

When loop.remote_host_alias is set in taac-loop.yaml (or supplied via
--remote-host on init), \`loop run\` SSHes to that ~/.ssh/config alias
and orchestrates the remote runner contract under ~/taac-runs/<plan>/.
The alias must be present in taiji-output/state/allowed-hosts.txt;
guard-bash.sh + scripts/_allowed-hosts.mjs enforce this at two layers.

\`loop run --execute\` requires a valid train_token via
\`taac2026 review issue --kind train\` (enforced by bin/taac2026.mjs).
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
  const base = rootDir ?? ROOT;
  return {
    loopRoot: path.join(base, "taiji-output", "state", "loops"),
    eventsPath: path.join(base, "taiji-output", "state", "events.ndjson"),
  };
}

function planLoopDir(loopRoot, planId) {
  if (!/^[A-Za-z0-9_.\-]+$/.test(planId)) throw new Error(`Invalid --plan-id: ${planId}`);
  return joinSafeRelative(loopRoot, [planId]);
}

async function loadState(planDir) {
  try {
    return JSON.parse(await readFile(path.join(planDir, "loop-state.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function saveState(planDir, state, eventsPath, eventName) {
  await mkdir(planDir, { recursive: true });
  await atomicWriteJson(path.join(planDir, "loop-state.json"), state);
  if (eventName) {
    await appendEvent({
      event: eventName,
      actor: "cli:auto-loop",
      payload: { plan_id: state.plan_id, state: state.state, iter: state.current_iter ?? null },
      eventsPath,
    });
  }
}

async function loadConfig(planDir) {
  const text = await readFile(path.join(planDir, "taac-loop.yaml"), "utf8");
  return parseLoopConfig(text);
}

async function killSwitchActive(planDir) {
  try {
    await access(path.join(planDir, "KILL"));
    return true;
  } catch {
    return false;
  }
}

function transition(prev, next) {
  if (prev === next) return next;
  const allowed = ALLOWED_TRANSITIONS.get(prev) ?? [];
  if (!allowed.includes(next)) {
    throw new Error(`auto-loop: illegal transition ${prev} → ${next}`);
  }
  return next;
}

// Deterministic stub remote runner. val_auc rises ~0.005/iter with a
// shrinking ramp; once delta < threshold for `patience` iterations we
// signal early-stop by returning improved=false.
function simulateIter({ planId, iter, seed = 42 }) {
  const hash = createHash("sha256").update(`${planId}:${iter}:${seed}`).digest("hex");
  const noiseInt = parseInt(hash.slice(0, 8), 16);
  const noise = ((noiseInt / 0xffffffff) - 0.5) * 0.001; // ±0.0005
  const baseGain = 0.005 / Math.sqrt(iter + 1);
  const valAuc = 0.5 + 0.005 * iter + baseGain + noise;
  const trainAuc = valAuc + 0.01;
  const lossDelta = -0.002 / Math.sqrt(iter + 1);
  return {
    iter,
    metrics: {
      val_auc: Number(valAuc.toFixed(6)),
      train_auc: Number(trainAuc.toFixed(6)),
      train_loss_delta: Number(lossDelta.toFixed(6)),
    },
    artifacts: { ckpt: `iter-${iter}/model.pt`, log: `iter-${iter}/train.log` },
    finished_at: new Date().toISOString(),
  };
}

// ---------- subcommands ----------

export async function initLoop({ planId, configFile, gpuHost, remoteHost, rootDir }) {
  if (!planId) throw new Error("Missing --plan-id");
  const { loopRoot, eventsPath } = rootsFor({ rootDir });
  const planDir = planLoopDir(loopRoot, planId);
  await mkdir(planDir, { recursive: true });

  let config;
  if (configFile) {
    const text = await readFile(path.resolve(configFile), "utf8");
    config = parseLoopConfig(text);
    config.plan_id = planId;
  } else {
    config = defaultLoopConfig({ planId, gpuHost });
  }
  config.loop.kill_switch_path = path.join(planDir, "KILL");
  if (remoteHost) {
    config.loop.remote_host_alias = remoteHost;
  }
  await atomicWriteFile(path.join(planDir, "taac-loop.yaml"), renderLoopConfigYaml(config));

  const state = {
    plan_id: planId,
    state: "idle",
    initialised_at: new Date().toISOString(),
    current_iter: 0,
    iter_history: [],
    retry_count: 0,
    early_stop_streak: 0,
    last_error: null,
  };
  await saveState(planDir, state, eventsPath, "loop.init");
  return { plan_id: planId, plan_dir: planDir, state: state.state, config_path: path.join(planDir, "taac-loop.yaml") };
}

export async function statusLoop({ planId, rootDir }) {
  const { loopRoot } = rootsFor({ rootDir });
  const planDir = planLoopDir(loopRoot, planId);
  const state = await loadState(planDir);
  if (!state) throw new Error(`No loop state for plan ${planId} — run \`taac2026 loop init\` first.`);
  const killActive = await killSwitchActive(planDir);
  return { plan_id: planId, plan_dir: planDir, kill_active: killActive, ...state };
}

export async function killLoop({ planId, rootDir, runnerFactory = buildRemoteRunner }) {
  const { loopRoot, eventsPath } = rootsFor({ rootDir });
  const planDir = planLoopDir(loopRoot, planId);
  await mkdir(planDir, { recursive: true });
  await atomicWriteFile(path.join(planDir, "KILL"), `kill issued at ${new Date().toISOString()}\n`);

  // Mirror the KILL marker to the remote host if one is configured. Best
  // effort — local KILL is always honored regardless of remote outcome.
  let remote = { attempted: false, ok: null, error: null };
  try {
    const config = await loadConfig(planDir);
    const alias = config.loop?.remote_host_alias;
    if (alias) {
      remote.attempted = true;
      const runner = runnerFactory({ alias, controlPath: config.loop?.ssh_control_path ?? null });
      try {
        await runner.touchKill(planId);
        remote.ok = true;
      } catch (error) {
        remote.ok = false;
        remote.error = error.message ?? String(error);
      }
    }
  } catch {} // missing config = nothing to mirror

  await appendEvent({
    event: "loop.kill_requested",
    actor: "cli:auto-loop",
    payload: { plan_id: planId, remote },
    eventsPath,
  });
  return { plan_id: planId, kill_path: path.join(planDir, "KILL"), kill_issued: true, remote };
}

export async function resumeLoop({ planId, rootDir, runnerFactory = buildRemoteRunner }) {
  const { loopRoot, eventsPath } = rootsFor({ rootDir });
  const planDir = planLoopDir(loopRoot, planId);
  const state = await loadState(planDir);
  if (!state) throw new Error(`No loop state for plan ${planId}`);
  if (state.state !== "paused") {
    throw new Error(`resume only valid from 'paused' (current: ${state.state})`);
  }
  // Clear KILL marker locally and on the remote (best effort).
  try { await rm(path.join(planDir, "KILL")); } catch {}
  let remote = { attempted: false, ok: null, error: null };
  try {
    const config = await loadConfig(planDir);
    const alias = config.loop?.remote_host_alias;
    if (alias) {
      remote.attempted = true;
      const runner = runnerFactory({ alias, controlPath: config.loop?.ssh_control_path ?? null });
      try {
        await runner.clearKill(planId);
        remote.ok = true;
      } catch (error) {
        remote.ok = false;
        remote.error = error.message ?? String(error);
      }
    }
  } catch {}
  state.state = transition("paused", "queued");
  state.last_error = null;
  await saveState(planDir, state, eventsPath, "loop.resumed");
  return { plan_id: planId, state: state.state, remote };
}

export async function runLoop({
  planId, maxIters, fromIter, seed, execute = false, yes = false, rootDir,
  // Hooks for testing — let unit tests inject a fake remote runner.
  remoteIter,                          // explicit override; if omitted we choose
  remoteIterFactory = buildRealRemoteIter,
  runnerFactory = buildRemoteRunner,
  failurePlan = null,
} = {}) {
  if (!planId) throw new Error("Missing --plan-id");
  const { loopRoot, eventsPath } = rootsFor({ rootDir });
  const planDir = planLoopDir(loopRoot, planId);
  const config = await loadConfig(planDir);
  let state = await loadState(planDir);
  if (!state) throw new Error(`No loop state for plan ${planId} — run \`taac2026 loop init\` first.`);

  const cap = Number(maxIters ?? config.loop.max_iters);
  const startIter = Number(fromIter ?? state.current_iter ?? 0);
  const seedNum = Number(seed ?? 42);
  const thresholdDelta = config.loop.metric.threshold_delta;
  const maxRetry = config.loop.retry.max_per_iter;

  // Choose remote runner: explicit override > real-remote (alias configured)
  // > local simulateIter stub. Built once per loop run so the
  // ControlMaster persists across iters (CLAUDE.md r9).
  const remoteHostAlias = config.loop?.remote_host_alias;
  let chosenRemoteIter = remoteIter;
  if (!chosenRemoteIter && remoteHostAlias) {
    const runner = runnerFactory({ alias: remoteHostAlias, controlPath: config.loop?.ssh_control_path ?? null });
    chosenRemoteIter = remoteIterFactory({ runner, planDir });
  }
  if (!chosenRemoteIter) chosenRemoteIter = simulateIter;

  if (!execute) {
    return {
      mode: "dry-run",
      plan_id: planId,
      plan_dir: planDir,
      planned_iters: cap - startIter,
      from_state: state.state,
      note: "Re-run with --execute --yes to drive the in-process state machine. M4 stays local; M5 will SSH.",
    };
  }
  if (!yes) throw new Error("--execute requires --yes");

  // Prime the state machine. If we are starting fresh, walk
  // idle → planned → approved → queued. Each step is a real persisted
  // transition so a Ctrl-C mid-progress is recoverable.
  if (state.state === "idle") {
    state.state = transition(state.state, "planned");
    await saveState(planDir, state, eventsPath, "loop.transition");
  }
  if (state.state === "planned") {
    state.state = transition(state.state, "approved");
    state.approved_at = new Date().toISOString();
    await saveState(planDir, state, eventsPath, "loop.transition");
  }
  if (state.state === "approved") {
    state.state = transition(state.state, "queued");
    await saveState(planDir, state, eventsPath, "loop.transition");
  }

  for (let iter = startIter; iter < cap; iter += 1) {
    if (await killSwitchActive(planDir)) {
      state.state = transition(state.state, "killed");
      await saveState(planDir, state, eventsPath, "loop.killed");
      return summarize(planId, planDir, state);
    }

    state.state = transition(state.state, "running_iter");
    state.current_iter = iter;
    state.retry_count = 0;
    await saveState(planDir, state, eventsPath, "loop.iter.started");

    let iterResult = null;
    while (state.retry_count <= maxRetry) {
      try {
        const planned = failurePlan?.[iter];
        if (planned === "fail" || (planned === "fail-once" && state.retry_count === 0)) {
          throw new Error(`simulated failure at iter ${iter} (attempt ${state.retry_count})`);
        }
        iterResult = await chosenRemoteIter({ planId, iter, seed: seedNum });
        break;
      } catch (error) {
        state.retry_count += 1;
        state.last_error = error.message ?? String(error);
        if (state.retry_count > maxRetry) {
          state.state = transition(state.state, "failed");
          await saveState(planDir, state, eventsPath, "loop.failed");
          return summarize(planId, planDir, state);
        }
        // Stay in running_iter; retry budget still has room.
        await saveState(planDir, state, eventsPath, "loop.iter.retry");
      }
    }

    state.state = transition(state.state, "collecting_metrics");
    await saveState(planDir, state, eventsPath, "loop.transition");

    state.state = transition(state.state, "analyzing");
    const last = state.iter_history.at(-1);
    const improved = !last || (iterResult.metrics.val_auc - last.metrics.val_auc) >= thresholdDelta;
    state.early_stop_streak = improved ? 0 : state.early_stop_streak + 1;
    state.iter_history.push(iterResult);
    state.last_error = null;
    await saveState(planDir, state, eventsPath, "loop.transition");

    state.state = transition(state.state, "proposing_next");
    await saveState(planDir, state, eventsPath, "loop.transition");

    if (state.early_stop_streak >= 3) {
      state.state = transition(state.state, "completed");
      await saveState(planDir, state, eventsPath, "loop.completed");
      return summarize(planId, planDir, state);
    }

    if (await killSwitchActive(planDir)) {
      state.state = transition(state.state, "killed");
      await saveState(planDir, state, eventsPath, "loop.killed");
      return summarize(planId, planDir, state);
    }

    // Last iter inside the cap → terminate from proposing_next directly,
    // skipping a redundant proposing_next → queued → completed loop.
    if (iter + 1 >= cap) {
      state.state = transition(state.state, "completed");
      await saveState(planDir, state, eventsPath, "loop.completed");
      return summarize(planId, planDir, state);
    }

    state.state = transition(state.state, "queued");
    await saveState(planDir, state, eventsPath, "loop.transition");
  }

  // Reached only when the for-loop didn't enter (e.g. cap == startIter):
  // there's nothing to do, mark complete from the current state.
  if (state.state === "queued") {
    state.state = transition(state.state, "running_iter");
    state.state = transition(state.state, "collecting_metrics");
    state.state = transition(state.state, "analyzing");
    state.state = transition(state.state, "proposing_next");
  }
  state.state = transition(state.state, "completed");
  await saveState(planDir, state, eventsPath, "loop.completed");
  return summarize(planId, planDir, state);
}

// Real remote runner: pushes config/run.sh to ~/taac-runs/<plan-id>/iters/<iter-id>/,
// triggers run.sh, polls status.json, then pulls metrics + train.log back.
// Used when the loop config has loop.remote_host_alias set. Spawn function
// is injected by buildRemoteRunner so unit tests cover this path without
// real SSH.
export function buildRealRemoteIter({ runner, planDir, pollMs = 10_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  return async function realRemoteIter({ planId, iter, seed }) {
    const iterId = `iter-${String(iter).padStart(4, "0")}`;
    const remoteIterDir = runner.remoteIterDir(planId, iterId);
    const localIterDir = path.join(planDir, "remote", iterId);
    await mkdir(localIterDir, { recursive: true });

    // Push the iter manifest the runner contract expects. We don't ship a
    // training framework — the user supplies run.sh. We only forward the
    // iter parameters via a small JSON config the user's run.sh can read.
    const iterParams = { plan_id: planId, iter, seed, started_at: new Date().toISOString() };
    const localParams = path.join(localIterDir, "iter-params.json");
    await writeFile(localParams, JSON.stringify(iterParams, null, 2));

    await runner.exec(`mkdir -p ${remoteIterDir}`);
    await runner.copyTo(localParams, `${remoteIterDir}/iter-params.json`);

    // Try to copy the user's run.sh / config.yaml from the local plan dir
    // (taiji-output/proposals/<plan-id>/) if present. Missing files are
    // not an error — the user's remote may have a fixed run.sh.
    for (const optional of ["run.sh", "config.yaml"]) {
      const local = path.join(planDir, "..", "..", "..", "proposals", planId, optional);
      try {
        await stat(local);
        await runner.copyTo(local, `${remoteIterDir}/${optional}`);
      } catch {} // optional
    }

    // Fire run.sh inside a flock to enforce serialization. The exit code
    // of bash -lc carries through; status.json is the structured handoff
    // the user's run.sh is expected to write.
    const startCmd = [
      `cd ${remoteIterDir}`,
      `mkdir -p $(dirname ${runner.remoteLockPath(planId)})`,
      `flock -w 60 ${runner.remoteLockPath(planId)} bash -c '`,
      `  test ! -e ${runner.remoteKillPath(planId)} && bash ./run.sh > train.log 2>&1`,
      `'`,
    ].join(" && ");

    let lastStatus = null;
    const deadline = Date.now() + 6 * 60 * 60_000; // 6h default per-iter cap
    // Kick off training in the background to allow status polling.
    const startPromise = runner.exec(`(${startCmd}) >> ${remoteIterDir}/runner.log 2>&1 &`, { timeoutMs: 60_000 });
    await startPromise.catch((error) => {
      throw new Error(`remote start failed: ${error.message ?? error}`);
    });

    while (Date.now() < deadline) {
      await sleep(pollMs);
      try {
        await runner.readStatus(planId, iterId, path.join(localIterDir, "status.json"));
        const status = JSON.parse(await readFile(path.join(localIterDir, "status.json"), "utf8"));
        lastStatus = status;
        if (status.phase === "completed" || status.phase === "failed") break;
      } catch {} // status.json may not exist yet
    }
    if (!lastStatus) throw new Error(`remote iter ${iterId}: no status.json after timeout`);
    if (lastStatus.phase !== "completed") {
      throw new Error(`remote iter ${iterId} phase=${lastStatus.phase} exit_code=${lastStatus.exit_code}`);
    }

    // Pull metrics + train.log back for local audit.
    await runner.copyFrom(`${remoteIterDir}/metrics.json`, path.join(localIterDir, "metrics.json"));
    try { await runner.copyFrom(`${remoteIterDir}/train.log`, path.join(localIterDir, "train.log")); } catch {}
    const metrics = JSON.parse(await readFile(path.join(localIterDir, "metrics.json"), "utf8"));
    return {
      iter,
      metrics,
      artifacts: { remote_iter_dir: remoteIterDir, local_iter_dir: localIterDir },
      finished_at: new Date().toISOString(),
    };
  };
}

function summarize(planId, planDir, state) {
  const last = state.iter_history.at(-1);
  return {
    plan_id: planId,
    plan_dir: planDir,
    final_state: state.state,
    iters_completed: state.iter_history.length,
    last_metric: last?.metrics ?? null,
    early_stop_streak: state.early_stop_streak,
    last_error: state.last_error,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command || args.command === "--help") {
    console.log(usage());
    return;
  }

  if (args.command === "init") {
    const result = await initLoop({
      planId: args.planId,
      configFile: args.config,
      gpuHost: args.gpuHost,
      remoteHost: args.remoteHost,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === "status") {
    const result = await statusLoop({ planId: args.planId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === "kill") {
    const result = await killLoop({ planId: args.planId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === "resume") {
    const result = await resumeLoop({ planId: args.planId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === "run") {
    const result = await runLoop({
      planId: args.planId,
      maxIters: args.maxIters,
      fromIter: args.fromIter,
      seed: args.seed,
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

export { ALLOWED_TRANSITIONS, simulateIter };
