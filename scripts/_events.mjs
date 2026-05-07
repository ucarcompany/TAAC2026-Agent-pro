// Append-only NDJSON event ledger (skill-expansion-design-2026-05-07.md §16).
// One line = one event. Truncation / out-of-order writes will be caught by a
// future PostToolUse hook; for now we just guarantee O_APPEND + flock-by-rename.

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_EVENTS_PATH = path.join(ROOT, "taiji-output", "state", "events.ndjson");

function payloadHash(payload) {
  const json = JSON.stringify(payload, Object.keys(payload).sort());
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

export async function appendEvent({ event, actor, payload = {}, eventsPath = DEFAULT_EVENTS_PATH }) {
  if (!event || typeof event !== "string") throw new Error("appendEvent: event name required");
  const ts = new Date().toISOString();
  const record = {
    ts,
    actor: actor ?? "cli",
    event,
    sha256: payloadHash(payload),
    ...payload,
  };
  const line = `${JSON.stringify(record)}\n`;
  // O_APPEND so concurrent writers cannot interleave within a line on POSIX
  // / NTFS. The Node fs/promises wrapper opens with the right flag.
  const handle = await open(eventsPath, "a");
  try {
    await handle.write(line, null, "utf8");
  } finally {
    await handle.close();
  }
  return record;
}
