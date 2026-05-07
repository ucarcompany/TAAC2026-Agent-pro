import assert from "node:assert/strict";
import { access, mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { checkSecrets, initHmac } from "../secrets-tools.mjs";

test("secrets check reports presence and absence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-secrets-"));
  const report = await checkSecrets(root);
  assert.equal(report.files["review.hmac.key"].present, false);
  assert.equal(report.files["taiji.cookie.json"].present, false);
});

test("init-hmac dry-run does not write a file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-secrets-dryrun-"));
  const target = path.join(root, "review.hmac.key");
  const result = await initHmac({ out: target, execute: false });
  assert.equal(result.mode, "dry-run");
  assert.equal(result.target, target);
  await assert.rejects(access(target), /ENOENT|no such/);
});

test("init-hmac --execute --yes writes a 32-byte hex key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-secrets-live-"));
  const target = path.join(root, "review.hmac.key");
  const result = await initHmac({ out: target, execute: true, yes: true });
  assert.equal(result.written, true);
  const content = await readFile(target, "utf8");
  assert.equal(content.length, 64); // 32 bytes hex
  assert.match(content, /^[0-9a-f]{64}$/);
});

test("init-hmac refuses to overwrite existing key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-secrets-noov-"));
  const target = path.join(root, "review.hmac.key");
  await initHmac({ out: target, execute: true, yes: true });
  await assert.rejects(initHmac({ out: target, execute: true, yes: true }), /Refusing to overwrite/);
});

test("init-hmac --execute without --yes is rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-secrets-noyes-"));
  const target = path.join(root, "review.hmac.key");
  await assert.rejects(initHmac({ out: target, execute: true, yes: false }), /--execute requires --yes/);
});

test("init-hmac on POSIX yields 0o600 permissions", async (t) => {
  if (process.platform === "win32") {
    t.skip("chmod 0o600 is best-effort on Windows NTFS");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-secrets-mode-"));
  const target = path.join(root, "review.hmac.key");
  await initHmac({ out: target, execute: true, yes: true });
  const s = await stat(target);
  assert.equal(s.mode & 0o777, 0o600);
});
