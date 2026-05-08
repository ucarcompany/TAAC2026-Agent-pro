import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  applyPatch,
  ingestError,
  listErrors,
  triageError,
  verifyError,
} from "../error-tools.mjs";

const KEY = "0".repeat(64);

const CUDA_OOM_LOG = `
2026-05-08T03:14:01.123Z [pid 12345] starting iter 4
allocating 4096 MiB on GPU 0 ...
Traceback (most recent call last):
  File "/var/run/code/train.py", line 142, in train_step
    out = model(x.cuda())
  File "/var/run/code/model.py", line 88, in forward
    return self.tower(x)
RuntimeError: CUDA out of memory. Tried to allocate 2048.00 MiB (GPU 0; 24.00 GiB total capacity)
`;

async function makeRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-errtools-"));
  await mkdir(path.join(root, "taiji-output", "secrets"), { recursive: true });
  await writeFile(path.join(root, "taiji-output", "secrets", "review.hmac.key"), KEY);
  return root;
}

async function dropRawLog(root, name) {
  const logPath = path.join(root, name);
  await writeFile(logPath, CUDA_OOM_LOG);
  return logPath;
}

test("ingestError writes raw + context + fingerprint files", async () => {
  const root = await makeRoot();
  const logPath = await dropRawLog(root, "train.log");
  const r = await ingestError({ eventId: "evt-1", rawPath: logPath, planId: "plan-1", iterId: "iter-3", rootDir: root });
  assert.equal(r.fingerprint.layer, "gpu");
  const ctxPath = path.join(root, "taiji-output", "errors", "raw", "evt-1", "context.json");
  const fpPath = path.join(root, "taiji-output", "errors", "raw", "evt-1", "fingerprint.json");
  const ctx = JSON.parse(await readFile(ctxPath, "utf8"));
  const fp = JSON.parse(await readFile(fpPath, "utf8"));
  assert.equal(ctx.plan_id, "plan-1");
  assert.equal(fp.exception_class, "RuntimeError");
});

test("ingest of two events with the same root cause produces matching sigs", async () => {
  const root = await makeRoot();
  const log1 = await dropRawLog(root, "train1.log");
  const log2 = await dropRawLog(root, "train2.log");
  const a = await ingestError({ eventId: "evt-A", rawPath: log1, rootDir: root });
  const b = await ingestError({ eventId: "evt-B", rawPath: log2, rootDir: root });
  assert.equal(a.fingerprint.sig, b.fingerprint.sig);
});

test("triage on a fresh sig returns kb_hit=false with instructions", async () => {
  const root = await makeRoot();
  await ingestError({ eventId: "evt-miss", rawPath: await dropRawLog(root, "x.log"), rootDir: root });
  const r = await triageError({ eventId: "evt-miss", rootDir: root });
  assert.equal(r.kb_hit, false);
  assert.match(r.instructions, /error-doctor/);
});

test("apply-patch with --retry-only --execute --yes upserts a KB entry", async () => {
  const root = await makeRoot();
  await ingestError({ eventId: "evt-retry", rawPath: await dropRawLog(root, "x.log"), planId: "plan-r", rootDir: root });
  const r = await applyPatch({ eventId: "evt-retry", retryOnly: true, execute: true, yes: true, rootDir: root });
  assert.equal(r.kind, "retry-only");
  assert.equal(r.kb_mode, "created");
  assert.equal(r.occurrences, 1);
});

test("after apply-patch, a fresh ingest of the same root cause hits the KB", async () => {
  const root = await makeRoot();
  await ingestError({ eventId: "evt-1", rawPath: await dropRawLog(root, "a.log"), rootDir: root });
  await applyPatch({
    eventId: "evt-1", retryOnly: false, execute: true, yes: true, rootDir: root,
    configOverrides: '{"train.amp": true, "train.batch_size": 3072}',
  });
  await ingestError({ eventId: "evt-2", rawPath: await dropRawLog(root, "b.log"), rootDir: root });
  const r = await triageError({ eventId: "evt-2", rootDir: root });
  assert.equal(r.kb_hit, true);
  assert.equal(r.kb_entry.fix.kind, "config");
});

test("apply-patch dry-run does not touch KB", async () => {
  const root = await makeRoot();
  await ingestError({ eventId: "evt-d", rawPath: await dropRawLog(root, "x.log"), rootDir: root });
  const r = await applyPatch({ eventId: "evt-d", retryOnly: true, rootDir: root });
  assert.equal(r.mode, "dry-run");
  const list = await listErrors({ rootDir: root });
  assert.equal(list.length, 0);
});

test("apply-patch --execute requires --yes", async () => {
  const root = await makeRoot();
  await ingestError({ eventId: "evt-y", rawPath: await dropRawLog(root, "x.log"), rootDir: root });
  await assert.rejects(
    applyPatch({ eventId: "evt-y", retryOnly: true, execute: true, yes: false, rootDir: root }),
    /--execute requires --yes/,
  );
});

test("listErrors filters by layer", async () => {
  const root = await makeRoot();
  await ingestError({ eventId: "evt-gpu", rawPath: await dropRawLog(root, "g.log"), rootDir: root });
  await applyPatch({ eventId: "evt-gpu", retryOnly: true, execute: true, yes: true, rootDir: root });
  // Synthesise a submit-api event by ingesting a different log.
  const submitLog = path.join(root, "submit.log");
  await writeFile(submitLog, `HTTP 422 /taskmanagement/api/v1/webtasks/external/task: {"error":{"code":"INVALID_TRAINFILE","message":"size mismatch"}}`);
  await ingestError({ eventId: "evt-sub", rawPath: submitLog, rootDir: root });
  await applyPatch({ eventId: "evt-sub", retryOnly: true, execute: true, yes: true, rootDir: root });

  const gpuOnly = await listErrors({ rootDir: root, layer: "gpu" });
  assert.equal(gpuOnly.length, 1);
  assert.equal(gpuOnly[0].layer, "gpu");
});

test("verifyError --execute --yes records val_auc_delta + latency on the KB entry", async () => {
  const root = await makeRoot();
  await ingestError({ eventId: "evt-v", rawPath: await dropRawLog(root, "x.log"), rootDir: root });
  await applyPatch({ eventId: "evt-v", retryOnly: true, execute: true, yes: true, rootDir: root });
  const r = await verifyError({
    eventId: "evt-v",
    valAucDelta: -0.0006,
    latencyP95DeltaMs: 1.2,
    passedIterId: "iter-9",
    execute: true, yes: true,
    rootDir: root,
  });
  assert.equal(r.verification.val_auc_delta, -0.0006);
  assert.equal(r.verification.passed_iter_id, "iter-9");
});

test("triage detects KB tamper and refuses to fall back to 'miss'", async () => {
  const root = await makeRoot();
  await ingestError({ eventId: "evt-t", rawPath: await dropRawLog(root, "x.log"), rootDir: root });
  await applyPatch({ eventId: "evt-t", retryOnly: true, execute: true, yes: true, rootDir: root });
  // Tamper with the KB file.
  const fp = JSON.parse(await readFile(path.join(root, "taiji-output", "errors", "raw", "evt-t", "fingerprint.json"), "utf8"));
  const sigSuffix = fp.sig.replace("sha256:", "");
  const kbFile = path.join(root, "taiji-output", "errors", "kb", `${sigSuffix}.json`);
  const entry = JSON.parse(await readFile(kbFile, "utf8"));
  entry.fix = { kind: "code", summary: "evil" };
  await writeFile(kbFile, JSON.stringify(entry));
  await assert.rejects(triageError({ eventId: "evt-t", rootDir: root }), /tampered/);
});
