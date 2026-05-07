import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runReadinessCheck } from "../readiness.mjs";

async function buildFixtureRoot({ withFixes }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-readiness-"));
  const scripts = path.join(root, "scripts");
  await mkdir(scripts, { recursive: true });
  await mkdir(path.join(root, "taiji-output", "secrets"), { recursive: true });

  await writeFile(path.join(scripts, "_taiji-http.mjs"),
    withFixes
      ? `assertCookieHostAllowed; AbortSignal.timeout; Taiji error.code=`
      : "// no fixes",
  );
  await writeFile(path.join(scripts, "scrape-taiji.mjs"),
    withFixes
      ? `assertArtifactHostAllowed; joinSafeRelative; Unsafe path segment; atomicWriteJson; persistAllJobsArtifacts; Promise.allSettled; partialErrors`
      : "// no fixes",
  );
  await writeFile(path.join(scripts, "submit-taiji.mjs"),
    withFixes
      ? `--execute requires --cookie-file; COS_CLIENT_CACHE`
      : "// no fixes",
  );
  return root;
}

test("readiness: missing fixes => blocked", async () => {
  const root = await buildFixtureRoot({ withFixes: false });
  const report = await runReadinessCheck({ rootDir: root, secretsDir: path.join(root, "taiji-output", "secrets") });
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("p0_cookie_isolation"));
  assert.ok(report.blockers.includes("p0_path_traversal"));
  assert.ok(report.blockers.includes("p0_submit_silent_fallback"));
});

test("readiness: fixes present but secrets missing => warning", async () => {
  const root = await buildFixtureRoot({ withFixes: true });
  const report = await runReadinessCheck({ rootDir: root, secretsDir: path.join(root, "taiji-output", "secrets") });
  assert.equal(report.status, "warning");
  assert.deepEqual(report.blockers, []);
  assert.ok(report.warnings.some((w) => w.startsWith("secrets.")));
});

test("readiness: fixes present and secrets present => ready", async () => {
  const root = await buildFixtureRoot({ withFixes: true });
  await writeFile(path.join(root, "taiji-output", "secrets", "taiji.cookie.json"), "{}");
  await writeFile(path.join(root, "taiji-output", "secrets", "review.hmac.key"), "abc");
  const report = await runReadinessCheck({ rootDir: root, secretsDir: path.join(root, "taiji-output", "secrets") });
  assert.equal(report.status, "ready");
});
