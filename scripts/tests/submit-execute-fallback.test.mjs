import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const submitScript = fileURLToPath(new URL("../submit-taiji.mjs", import.meta.url));
const toolDir = fileURLToPath(new URL("../..", import.meta.url));

async function makeBundle(root) {
  const bundleDir = path.join(root, "bundle");
  await mkdir(bundleDir, { recursive: true });
  await writeFile(path.join(bundleDir, "code.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  await writeFile(path.join(bundleDir, "config.yaml"), "image: hub.example/foo\n");
  const manifest = {
    job: { name: "exp_test", description: "" },
    runAfterSubmit: false,
    files: {
      codeZip: { preparedPath: "code.zip" },
      config: { preparedPath: "config.yaml" },
    },
    templateJobUrl: "https://taiji.algo.qq.com/training/x/12345",
  };
  await writeFile(path.join(bundleDir, "manifest.json"), JSON.stringify(manifest));
  return bundleDir;
}

test("submit --execute --yes without --cookie-file fails loudly", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "taac2026-submit-exec-"));
  const bundleDir = await makeBundle(tempRoot);
  const outDir = path.join(tempRoot, "out");

  let captured = null;
  try {
    await execFileAsync(process.execPath, [
      submitScript,
      "--bundle", bundleDir,
      "--template-job-internal-id", "12345",
      "--out", outDir,
      "--execute",
      "--yes",
    ], { cwd: toolDir });
    t.diagnostic("expected non-zero exit");
    assert.fail("submit-taiji.mjs did not error");
  } catch (error) {
    captured = error;
  }

  assert.ok(captured, "expected submit to throw");
  assert.match(String(captured.stderr ?? captured.message), /--execute requires --cookie-file/);
});

test("submit without --execute and without --cookie-file still writes a dry-run plan", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "taac2026-submit-dry-"));
  const bundleDir = await makeBundle(tempRoot);
  const outDir = path.join(tempRoot, "out");

  const { stdout } = await execFileAsync(process.execPath, [
    submitScript,
    "--bundle", bundleDir,
    "--template-job-internal-id", "12345",
    "--out", outDir,
  ], { cwd: toolDir });

  assert.match(stdout, /dry-run plan/);
});
