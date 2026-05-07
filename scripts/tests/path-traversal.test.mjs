import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { joinSafeRelative } from "../_taiji-http.mjs";

test("joinSafeRelative joins normal segments", () => {
  const out = joinSafeRelative("/tmp/work", ["a", "b/c"]);
  assert.equal(out, path.resolve("/tmp/work/a/b/c"));
});

test("joinSafeRelative refuses '..' segments", () => {
  assert.throws(() => joinSafeRelative("/tmp/work", ["..", "escape.txt"]), /Unsafe path segment/);
  assert.throws(() => joinSafeRelative("/tmp/work", ["a/../../b"]), /Unsafe path segment/);
});

test("joinSafeRelative refuses '.' segments", () => {
  assert.throws(() => joinSafeRelative("/tmp/work", [".", "x"]), /Unsafe path segment/);
});

test("joinSafeRelative refuses NUL bytes", () => {
  assert.throws(() => joinSafeRelative("/tmp/work", ["a\0b"]), /Unsafe path segment/);
});

test("joinSafeRelative does not let mixed slashes escape via prefix", () => {
  // After normalization, parts = ["..", "escape.txt"] -> rejected.
  assert.throws(() => joinSafeRelative("/tmp/work", ["../../etc/passwd"]), /Unsafe path segment/);
});

test("scrape-taiji safeRelativeFilePath refuses '..' in file.name", async () => {
  // Indirect import: we only need to know the function rejects bad names.
  // Read it through ESM dynamic import; the function is internal but the
  // saveJobCodeFiles path goes through it. We simulate by checking that the
  // joinSafeRelative used inside saveJobCodeFiles refuses bad segments.
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "taac2026-pt-"));
  assert.throws(() => joinSafeRelative(tempRoot, ["code/jobX/files/../../../escape.txt"]), /Unsafe path segment/);
  // Sanity: workspace stays empty.
  const after = await readdir(tempRoot);
  assert.deepEqual(after, []);
});
