import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ingestHf, ingestLocal } from "../data-tools.mjs";

async function makeFixtureDir() {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-ingest-"));
  const src = path.join(root, "src");
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, "train.csv"), "id,label\n1,0\n2,1\n");
  await writeFile(path.join(src, "schema.json"), JSON.stringify({ rows: 2 }));
  return { root, src };
}

test("ingestLocal dry-run does not write files", async () => {
  const { root, src } = await makeFixtureDir();
  const result = await ingestLocal({ datasetId: "dry-run-test", src, execute: false, rootDir: root });
  assert.equal(result.written, false);
  assert.equal(result.manifest.ingest_dry_run, true);
  for (const file of result.manifest.files) assert.equal(file.sha256, "<dry-run>");
});

test("ingestLocal --execute --yes writes manifest with real SHA256", async () => {
  const { root, src } = await makeFixtureDir();
  const result = await ingestLocal({ datasetId: "live-ingest-test", src, execute: true, yes: true, rootDir: root });
  assert.equal(result.written, true);
  const manifest = JSON.parse(await readFile(path.join(result.target, "manifest.json"), "utf8"));
  assert.equal(manifest.ingest_dry_run, false);
  for (const file of manifest.files) assert.match(file.sha256, /^[0-9a-f]{64}$/);
});

test("ingestLocal rejects unknown license", async () => {
  const { root, src } = await makeFixtureDir();
  await assert.rejects(
    ingestLocal({ datasetId: "bad-license", src, licenseId: "totally-fake", execute: false, rootDir: root }),
    /not in the allowlist/,
  );
});

test("ingestLocal rejects src path containing '..'", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-ingest-bad-"));
  await assert.rejects(
    ingestLocal({ datasetId: "bad-src", src: "fixtures/../escape", execute: false, rootDir: root }),
    /contains '\.\.'/,
  );
});

test("ingestLocal --execute requires --yes", async () => {
  const { root, src } = await makeFixtureDir();
  await assert.rejects(
    ingestLocal({ datasetId: "noyes", src, execute: true, yes: false, rootDir: root }),
    /--execute requires --yes/,
  );
});

test("ingestHf dry-run reports planned files only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-ingest-hf-dry-"));
  const result = await ingestHf({ datasetId: "hf-dry", files: "train.parquet,test.parquet", execute: false, rootDir: root });
  assert.equal(result.written, false);
  assert.equal(result.manifest.files.length, 2);
});

test("ingestHf --execute --yes calls the injected fetcher and stores SHA256", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-ingest-hf-live-"));
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    return Buffer.from(`payload-for:${url}`);
  };
  const result = await ingestHf({
    datasetId: "hf-live",
    files: "train.parquet",
    execute: true,
    yes: true,
    fetchImpl: fetcher,
    rootDir: root,
  });
  assert.equal(result.written, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /datasets\/TAAC2026\/data_sample_1000\/resolve\/main\/train\.parquet$/);
  const manifest = JSON.parse(await readFile(path.join(result.target, "manifest.json"), "utf8"));
  assert.match(manifest.files[0].sha256, /^[0-9a-f]{64}$/);
});
