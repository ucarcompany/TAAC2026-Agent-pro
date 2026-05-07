import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ingestLocal, profileDataset } from "../data-tools.mjs";

async function makeCsvDataset({ leakage, dirHint = "" }) {
  const root = await mkdtemp(path.join(os.tmpdir(), `taac2026-profile-${dirHint}-`));
  const src = path.join(root, "src");
  await mkdir(src, { recursive: true });
  const lines = ["id,feature,leak,label"];
  for (let i = 0; i < 200; i += 1) {
    const label = i % 2;
    const feature = Math.random();
    // When `leakage` is true, "leak" column is essentially the label.
    const leak = leakage ? label + (Math.random() - 0.5) * 1e-3 : Math.random();
    lines.push(`${i},${feature.toFixed(4)},${leak.toFixed(6)},${label}`);
  }
  await writeFile(path.join(src, "train.csv"), `${lines.join("\n")}\n`);
  return { root, src };
}

test("profile detects leakage and exits with LEAKAGE_RED_FLAG", async () => {
  const { root, src } = await makeCsvDataset({ leakage: true, dirHint: "leak" });
  await ingestLocal({ datasetId: "leak-fixture", src, execute: true, yes: true, rootDir: root });

  await assert.rejects(
    profileDataset({ datasetId: "leak-fixture", labelColumn: "label", execute: true, yes: true, rootDir: root }),
    (error) => {
      assert.equal(error.code, "LEAKAGE_RED_FLAG");
      return true;
    },
  );
});

test("profile of clean data passes and writes schema.lock + profile.md", async () => {
  const { root, src } = await makeCsvDataset({ leakage: false, dirHint: "clean" });
  await ingestLocal({ datasetId: "clean-fixture", src, execute: true, yes: true, rootDir: root });

  const result = await profileDataset({ datasetId: "clean-fixture", labelColumn: "label", execute: true, yes: true, rootDir: root });
  assert.equal(result.written, true);
  assert.equal(result.profile.schema_lock_status, "fresh");
  assert.equal(result.profile.leakage_red_flags.length, 0);
  const md = await readFile(path.join(result.target, "profile.md"), "utf8");
  assert.match(md, /Profile — clean-fixture/);
});

test("profile dry-run does not throw on leakage; just reports it", async () => {
  const { root, src } = await makeCsvDataset({ leakage: true, dirHint: "dryleak" });
  await ingestLocal({ datasetId: "dry-leak-fixture", src, execute: true, yes: true, rootDir: root });
  const result = await profileDataset({ datasetId: "dry-leak-fixture", labelColumn: "label", execute: false, rootDir: root });
  assert.equal(result.written, false);
  assert.ok(result.profile.leakage_red_flags.length > 0);
});

test("profile detects schema drift on a second run", async () => {
  // First, ingest a clean dataset and profile it (writes schema.lock).
  const first = await makeCsvDataset({ leakage: false, dirHint: "drift" });
  await ingestLocal({ datasetId: "drift-fixture", src: first.src, execute: true, yes: true, rootDir: first.root });
  await profileDataset({ datasetId: "drift-fixture", labelColumn: "label", execute: true, yes: true, rootDir: first.root });

  // Now overwrite the dataset with a different schema (column renamed).
  const driftedRoot = await mkdtemp(path.join(os.tmpdir(), "taac2026-drift-"));
  const driftedSrc = path.join(driftedRoot, "src");
  await mkdir(driftedSrc, { recursive: true });
  const lines = ["id,feature,renamed_leak,label"];
  for (let i = 0; i < 50; i += 1) lines.push(`${i},${Math.random()},${Math.random()},${i % 2}`);
  await writeFile(path.join(driftedSrc, "train.csv"), `${lines.join("\n")}\n`);
  // Re-ingest into the same dataset id (and same rootDir!) to overwrite the data file.
  await ingestLocal({ datasetId: "drift-fixture", src: driftedSrc, execute: true, yes: true, rootDir: first.root });

  await assert.rejects(
    profileDataset({ datasetId: "drift-fixture", labelColumn: "label", execute: true, yes: true, rootDir: first.root }),
    (error) => {
      assert.equal(error.code, "SCHEMA_DRIFT");
      return true;
    },
  );
});
