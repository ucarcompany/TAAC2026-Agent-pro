import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { appendEvent } from "../_events.mjs";

test("appendEvent writes one valid JSON line per call", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-events-"));
  const eventsPath = path.join(root, "events.ndjson");

  await appendEvent({ event: "test.first", actor: "test", payload: { n: 1 }, eventsPath });
  await appendEvent({ event: "test.second", actor: "test", payload: { n: 2 }, eventsPath });

  const text = await readFile(eventsPath, "utf8");
  const lines = text.trim().split("\n");
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const obj = JSON.parse(line);
    assert.ok(obj.ts);
    assert.equal(obj.actor, "test");
    assert.match(obj.event, /^test\./);
    assert.match(obj.sha256, /^sha256:/);
  }
});

test("appendEvent with concurrent writers does not corrupt lines", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-events-conc-"));
  const eventsPath = path.join(root, "events.ndjson");

  const N = 10;
  await Promise.all(Array.from({ length: N }, (_, i) =>
    appendEvent({ event: "test.concurrent", payload: { i }, eventsPath })));

  const text = await readFile(eventsPath, "utf8");
  const lines = text.trim().split("\n");
  assert.equal(lines.length, N);
  for (const line of lines) JSON.parse(line); // throws if corrupted
});

test("appendEvent rejects empty event names", async () => {
  await assert.rejects(appendEvent({ event: "", payload: {} }), /event name required/);
});
