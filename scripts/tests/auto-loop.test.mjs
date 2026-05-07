import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ALLOWED_TRANSITIONS,
  initLoop,
  killLoop,
  resumeLoop,
  runLoop,
  STATES,
  statusLoop,
} from "../auto-loop.mjs";

async function makeRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "taac2026-loop-"));
}

test("init writes loop-state.json (state=idle) and taac-loop.yaml", async () => {
  const root = await makeRoot();
  const r = await initLoop({ planId: "plan-init-1", rootDir: root });
  assert.equal(r.state, "idle");
  const stateText = await readFile(path.join(r.plan_dir, "loop-state.json"), "utf8");
  const state = JSON.parse(stateText);
  assert.equal(state.state, "idle");
  assert.equal(state.iter_history.length, 0);
  // taac-loop.yaml exists.
  await stat(path.join(r.plan_dir, "taac-loop.yaml"));
});

test("status reflects whether KILL is active", async () => {
  const root = await makeRoot();
  const r = await initLoop({ planId: "plan-kill-1", rootDir: root });
  let s = await statusLoop({ planId: "plan-kill-1", rootDir: root });
  assert.equal(s.kill_active, false);
  await killLoop({ planId: "plan-kill-1", rootDir: root });
  s = await statusLoop({ planId: "plan-kill-1", rootDir: root });
  assert.equal(s.kill_active, true);
});

test("run --execute --yes drives through all stages and reaches completed", async () => {
  const root = await makeRoot();
  await initLoop({ planId: "plan-happy", rootDir: root });
  // Force a small max_iters so we don't burn time.
  const summary = await runLoop({
    planId: "plan-happy", rootDir: root, execute: true, yes: true, maxIters: 4,
    // Custom remoteIter to guarantee monotonic improvement so we hit max_iters,
    // then completed.
    remoteIter: async ({ planId, iter }) => ({
      iter,
      metrics: { val_auc: 0.5 + 0.05 * iter, train_auc: 0.6, train_loss_delta: -0.01 },
      artifacts: {},
      finished_at: new Date().toISOString(),
    }),
  });
  assert.equal(summary.final_state, "completed");
  assert.equal(summary.iters_completed, 4);
});

test("run --execute hits early-stop after 3 stagnant iters", async () => {
  const root = await makeRoot();
  await initLoop({ planId: "plan-earlystop", rootDir: root });
  const summary = await runLoop({
    planId: "plan-earlystop", rootDir: root, execute: true, yes: true, maxIters: 20,
    remoteIter: async ({ iter }) => ({
      iter,
      metrics: { val_auc: iter < 2 ? 0.5 + 0.05 * iter : 0.6, train_auc: 0.6, train_loss_delta: 0 },
      artifacts: {},
      finished_at: new Date().toISOString(),
    }),
  });
  assert.equal(summary.final_state, "completed");
  // First 2 iters improve (0 and 1), iter 2 vs 1 is +0.05 (still improves),
  // iter 3 stagnant (streak=1), iter 4 (streak=2), iter 5 (streak=3 → stop).
  assert.equal(summary.iters_completed, 6);
});

test("run respects KILL file when activated mid-run", async () => {
  const root = await makeRoot();
  const r = await initLoop({ planId: "plan-kill-mid", rootDir: root });
  let calls = 0;
  const summary = await runLoop({
    planId: "plan-kill-mid", rootDir: root, execute: true, yes: true, maxIters: 10,
    remoteIter: async ({ iter }) => {
      calls += 1;
      if (calls === 2) {
        await writeFile(path.join(r.plan_dir, "KILL"), "kill");
      }
      return {
        iter,
        metrics: { val_auc: 0.5 + 0.05 * iter, train_auc: 0.6, train_loss_delta: 0 },
        artifacts: {},
        finished_at: new Date().toISOString(),
      };
    },
  });
  assert.equal(summary.final_state, "killed");
  assert.ok(summary.iters_completed >= 1);
  assert.ok(summary.iters_completed <= 3);
});

test("run retries up to max_per_iter then fails", async () => {
  const root = await makeRoot();
  await initLoop({ planId: "plan-retry", rootDir: root });
  // failurePlan[2] = "fail" → permanent failure at iter 2. retry budget = 2,
  // so attempts: 1+2 retries = 3 total, all fail → state=failed.
  const summary = await runLoop({
    planId: "plan-retry", rootDir: root, execute: true, yes: true, maxIters: 5,
    failurePlan: { 2: "fail" },
  });
  assert.equal(summary.final_state, "failed");
  assert.equal(summary.iters_completed, 2);
  assert.match(summary.last_error, /simulated failure/);
});

test("run recovers after a single transient failure (fail-once)", async () => {
  const root = await makeRoot();
  await initLoop({ planId: "plan-flake", rootDir: root });
  const summary = await runLoop({
    planId: "plan-flake", rootDir: root, execute: true, yes: true, maxIters: 3,
    failurePlan: { 1: "fail-once" },
    remoteIter: async ({ iter }) => ({
      iter,
      metrics: { val_auc: 0.5 + 0.05 * iter, train_auc: 0.6, train_loss_delta: 0 },
      artifacts: {},
      finished_at: new Date().toISOString(),
    }),
  });
  assert.equal(summary.final_state, "completed");
  assert.equal(summary.iters_completed, 3);
});

test("run dry-run (no --execute) does not advance state", async () => {
  const root = await makeRoot();
  await initLoop({ planId: "plan-dryrun", rootDir: root });
  const result = await runLoop({ planId: "plan-dryrun", rootDir: root, maxIters: 2 });
  assert.equal(result.mode, "dry-run");
  const s = await statusLoop({ planId: "plan-dryrun", rootDir: root });
  assert.equal(s.state, "idle");
});

test("kill marker can be cleared by resume from paused", async () => {
  const root = await makeRoot();
  const r = await initLoop({ planId: "plan-resume", rootDir: root });
  // Manually set state to paused.
  const stateText = await readFile(path.join(r.plan_dir, "loop-state.json"), "utf8");
  const state = JSON.parse(stateText);
  state.state = "paused";
  await writeFile(path.join(r.plan_dir, "loop-state.json"), JSON.stringify(state));
  await writeFile(path.join(r.plan_dir, "KILL"), "stale");

  const result = await resumeLoop({ planId: "plan-resume", rootDir: root });
  assert.equal(result.state, "queued");
  const s = await statusLoop({ planId: "plan-resume", rootDir: root });
  assert.equal(s.kill_active, false);
});

test("resume from non-paused state is rejected", async () => {
  const root = await makeRoot();
  await initLoop({ planId: "plan-resume-bad", rootDir: root });
  await assert.rejects(resumeLoop({ planId: "plan-resume-bad", rootDir: root }), /resume only valid from 'paused'/);
});

test("ALLOWED_TRANSITIONS covers every defined state and rejects illegal jumps", () => {
  for (const s of STATES) assert.ok(ALLOWED_TRANSITIONS.has(s));
  // 'idle' cannot jump straight to 'running_iter'.
  const fromIdle = ALLOWED_TRANSITIONS.get("idle");
  assert.ok(!fromIdle.includes("running_iter"));
});
