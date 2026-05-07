import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { initLoop, killLoop, resumeLoop, runLoop } from "../auto-loop.mjs";

// A minimal in-memory remote runner shaped like RemoteRunner. Records all
// invocations so tests can assert on the call sequence; never spawns a
// real ssh process.
class FakeRunner {
  constructor() { this.calls = []; this.killTouched = false; }
  remoteRunDir(p) { return `/remote/${p}`; }
  remoteIterDir(p, i) { return `/remote/${p}/iters/${i}`; }
  remoteKillPath(p) { return `/remote/${p}/KILL`; }
  remoteLockPath(p) { return `/remote/${p}/gpu.lock`; }
  async exec(cmd) { this.calls.push({ kind: "exec", cmd }); return { code: 0, stdout: "", stderr: "" }; }
  async copyTo(local, remote) { this.calls.push({ kind: "copyTo", local, remote }); return { code: 0 }; }
  async copyFrom(remote, local) {
    this.calls.push({ kind: "copyFrom", remote, local });
    if (remote.endsWith("/status.json")) {
      await writeFile(local, JSON.stringify({ phase: "completed", exit_code: 0 }));
    } else if (remote.endsWith("/metrics.json")) {
      // Each iter returns slightly higher val_auc so the loop completes.
      const iter = Number(remote.match(/iter-(\d+)/)?.[1] ?? 0);
      await writeFile(local, JSON.stringify({ val_auc: 0.5 + 0.05 * iter, train_auc: 0.6 }));
    }
    return { code: 0 };
  }
  async touchKill(p) { this.killTouched = true; this.calls.push({ kind: "touchKill", p }); return { code: 0 }; }
  async clearKill(p) { this.killTouched = false; this.calls.push({ kind: "clearKill", p }); return { code: 0 }; }
  async readStatus(p, iterId, local) { return await this.copyFrom(`${this.remoteIterDir(p, iterId)}/status.json`, local); }
}

test("loop init --remote-host writes remote_host_alias to taac-loop.yaml", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-loop-remote-"));
  const r = await initLoop({ planId: "plan-r1", remoteHost: "taac2026-gpu", rootDir: root });
  const cfg = await readFile(path.join(r.plan_dir, "taac-loop.yaml"), "utf8");
  assert.match(cfg, /remote_host_alias:\s*taac2026-gpu/);
});

test("loop run with remote_host_alias drives via real-remote stub end-to-end", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-loop-remote-run-"));
  await initLoop({ planId: "plan-r2", remoteHost: "taac2026-gpu", rootDir: root });
  const fakeRunner = new FakeRunner();

  const summary = await runLoop({
    planId: "plan-r2",
    rootDir: root,
    execute: true,
    yes: true,
    maxIters: 3,
    remoteIterFactory: ({ runner, planDir }) => async ({ planId, iter, seed }) => {
      // We emulate just enough of the real factory: 1 exec + 1 copyTo +
      // 1 readStatus + 2 copyFroms (status + metrics).
      const iterId = `iter-${String(iter).padStart(4, "0")}`;
      await runner.exec(`mkdir -p ${runner.remoteIterDir(planId, iterId)}`);
      await runner.copyTo("local-params", `${runner.remoteIterDir(planId, iterId)}/iter-params.json`);
      const localStatus = path.join(planDir, "remote", iterId, "status.json");
      await mkdir(path.dirname(localStatus), { recursive: true });
      await runner.readStatus(planId, iterId, localStatus);
      const localMetrics = path.join(planDir, "remote", iterId, "metrics.json");
      await runner.copyFrom(`${runner.remoteIterDir(planId, iterId)}/metrics.json`, localMetrics);
      const metrics = JSON.parse(await readFile(localMetrics, "utf8"));
      return { iter, metrics, artifacts: { remote_iter_dir: runner.remoteIterDir(planId, iterId) }, finished_at: new Date().toISOString() };
    },
    runnerFactory: () => fakeRunner,
  });
  assert.equal(summary.final_state, "completed");
  assert.equal(summary.iters_completed, 3);
  // We expect at least one exec + one copyTo + one copyFrom per iter.
  const execs = fakeRunner.calls.filter((c) => c.kind === "exec").length;
  const copyTos = fakeRunner.calls.filter((c) => c.kind === "copyTo").length;
  const copyFroms = fakeRunner.calls.filter((c) => c.kind === "copyFrom").length;
  assert.ok(execs >= 3, `execs >= 3, got ${execs}`);
  assert.ok(copyTos >= 3, `copyTos >= 3, got ${copyTos}`);
  assert.ok(copyFroms >= 6, `copyFroms (status+metrics per iter) >= 6, got ${copyFroms}`);
});

test("loop kill mirrors the KILL marker to the remote runner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-loop-kill-remote-"));
  await initLoop({ planId: "plan-r3", remoteHost: "taac2026-gpu", rootDir: root });
  const fakeRunner = new FakeRunner();
  const result = await killLoop({
    planId: "plan-r3",
    rootDir: root,
    runnerFactory: () => fakeRunner,
  });
  assert.equal(result.kill_issued, true);
  assert.equal(result.remote.attempted, true);
  assert.equal(result.remote.ok, true);
  assert.ok(fakeRunner.killTouched);
});

test("loop kill records remote failure but still issues local KILL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-loop-kill-remote-fail-"));
  await initLoop({ planId: "plan-r4", remoteHost: "taac2026-gpu", rootDir: root });
  class FailingRunner extends FakeRunner {
    async touchKill() { throw new Error("ssh: unreachable"); }
  }
  const result = await killLoop({
    planId: "plan-r4",
    rootDir: root,
    runnerFactory: () => new FailingRunner(),
  });
  assert.equal(result.kill_issued, true);
  assert.equal(result.remote.ok, false);
  assert.match(result.remote.error, /unreachable/);
});

test("loop resume from paused clears both local and remote KILL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-loop-resume-remote-"));
  const r = await initLoop({ planId: "plan-r5", remoteHost: "taac2026-gpu", rootDir: root });
  // Force paused state directly so resume is legal.
  const stateText = await readFile(path.join(r.plan_dir, "loop-state.json"), "utf8");
  const state = JSON.parse(stateText);
  state.state = "paused";
  await writeFile(path.join(r.plan_dir, "loop-state.json"), JSON.stringify(state));
  await writeFile(path.join(r.plan_dir, "KILL"), "stale");

  const fakeRunner = new FakeRunner();
  fakeRunner.killTouched = true;
  const result = await resumeLoop({
    planId: "plan-r5",
    rootDir: root,
    runnerFactory: () => fakeRunner,
  });
  assert.equal(result.state, "queued");
  assert.equal(result.remote.ok, true);
  assert.equal(fakeRunner.killTouched, false);
});

test("loop without remote_host_alias still runs via the local simulateIter stub", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-loop-local-"));
  await initLoop({ planId: "plan-local", rootDir: root });
  const summary = await runLoop({
    planId: "plan-local", rootDir: root, execute: true, yes: true, maxIters: 2,
  });
  assert.equal(summary.final_state, "completed");
  assert.equal(summary.iters_completed, 2);
});
