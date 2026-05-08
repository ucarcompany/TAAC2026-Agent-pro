// Knowledge-base read/write for the M8 error-doctor pipeline.
//
// KB layout (skill-expansion-design-2026-05-07.md §15.4):
//   taiji-output/errors/
//     raw/<event-id>/                     # original log snapshots
//     reports/<event-id>/                 # error-doctor outputs
//     kb/<sig-suffix>.json                # one entry per fingerprint
//     index.ndjson                        # append-only event ledger
//
// Each kb entry carries an HMAC field so Claude/subagent edits to it
// are immediately detectable. Only this module writes kb/ — subagents
// are denied via .claude hooks (M8 design §15.8).

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFile, atomicWriteJson } from "./_taiji-http.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_ERRORS_ROOT = path.join(ROOT, "taiji-output", "errors");
const DEFAULT_HMAC_KEY_PATH = path.join(ROOT, "taiji-output", "secrets", "review.hmac.key");

export function errorRoots({ rootDir, errorsRoot, hmacKeyPath } = {}) {
  if (rootDir) {
    return {
      errorsRoot: path.join(rootDir, "taiji-output", "errors"),
      hmacKeyPath: path.join(rootDir, "taiji-output", "secrets", "review.hmac.key"),
    };
  }
  return {
    errorsRoot: errorsRoot ?? DEFAULT_ERRORS_ROOT,
    hmacKeyPath: hmacKeyPath ?? DEFAULT_HMAC_KEY_PATH,
  };
}

function sigSuffix(sig) {
  // "sha256:abc..." -> "abc...". 64 hex chars are filename-safe.
  return String(sig ?? "").replace(/^sha256:/, "");
}

function kbPath(errorsRoot, sig) {
  const suffix = sigSuffix(sig);
  if (!/^[0-9a-f]{64}$/.test(suffix)) throw new Error(`invalid sig: ${sig}`);
  return path.join(errorsRoot, "kb", `${suffix}.json`);
}

// Canonical JSON for HMAC: same approach as _hmac.mjs but local copy
// keeps the dependency surface tight.
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export function computeKbHmac(entry, key) {
  if (!key) throw new Error("computeKbHmac: hmac key required");
  const { hmac: _ignored, ...rest } = entry;
  return createHmac("sha256", Buffer.from(key, "hex")).update(canonicalJson(rest)).digest("hex");
}

export async function readHmacKey(hmacKeyPath) {
  const text = (await readFile(hmacKeyPath, "utf8")).trim();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`hmac key at ${hmacKeyPath} is not 32-byte hex`);
  return text;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function appendIndex(errorsRoot, record) {
  const indexPath = path.join(errorsRoot, "index.ndjson");
  await mkdir(path.dirname(indexPath), { recursive: true });
  const handle = await open(indexPath, "a");
  try {
    await handle.write(JSON.stringify(record) + "\n", null, "utf8");
  } finally {
    await handle.close();
  }
}

// Look up an entry. Returns null if absent. Throws if HMAC fails — that
// means the file was tampered with and the caller MUST stop.
export async function getKbEntry({ sig, rootDir, errorsRoot, hmacKeyPath } = {}) {
  const r = errorRoots({ rootDir, errorsRoot, hmacKeyPath });
  let entry;
  try {
    entry = await readJson(kbPath(r.errorsRoot, sig));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const key = await readHmacKey(r.hmacKeyPath);
  if (!entry.hmac) throw new Error(`KB tampered: ${sig} missing hmac field`);
  const expected = computeKbHmac(entry, key);
  const a = Buffer.from(entry.hmac, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error(`KB tampered: ${sig} hmac mismatch — refusing to use entry`);
  }
  return entry;
}

// Upsert a KB entry. Increments occurrences if it exists; sets
// first_seen + last_seen; recomputes HMAC. Returns { entry, mode }.
export async function upsertKbEntry({
  sig,
  layer,
  title,
  rootCause = null,
  fix = null,
  doNotApplyWhen = [],
  author = "cli",
  planId = null,
  rootDir, errorsRoot, hmacKeyPath,
  now = () => new Date(),
}) {
  if (!sig) throw new Error("upsertKbEntry: sig required");
  if (!layer) throw new Error("upsertKbEntry: layer required");
  const r = errorRoots({ rootDir, errorsRoot, hmacKeyPath });
  const key = await readHmacKey(r.hmacKeyPath);
  const target = kbPath(r.errorsRoot, sig);

  let prior = null;
  try { prior = await readJson(target); } catch (error) { if (error.code !== "ENOENT") throw error; }

  const ts = now().toISOString();
  const next = prior ? { ...prior } : {
    version: 1,
    sig,
    layer,
    title: title ?? "",
    first_seen: ts,
    last_seen: ts,
    occurrences: 0,
    plans_affected: [],
    root_cause: rootCause ?? "",
    fix: fix ?? null,
    verification: null,
    do_not_apply_when: doNotApplyWhen,
    author,
  };
  next.last_seen = ts;
  next.occurrences = (prior?.occurrences ?? 0) + 1;
  if (planId && !next.plans_affected.includes(planId)) next.plans_affected.push(planId);
  if (title && !prior?.title) next.title = title;
  if (rootCause) next.root_cause = rootCause;
  if (fix) next.fix = fix;
  if (doNotApplyWhen?.length) next.do_not_apply_when = doNotApplyWhen;
  // Layer can change if heuristics improve; trust the caller.
  next.layer = layer;
  delete next.hmac;
  next.hmac = computeKbHmac(next, key);

  await mkdir(path.dirname(target), { recursive: true });
  await atomicWriteJson(target, next);
  await appendIndex(r.errorsRoot, { ts, event: prior ? "errors.kb.updated" : "errors.kb.created", sig, layer: next.layer, occurrences: next.occurrences });
  return { entry: next, mode: prior ? "updated" : "created" };
}

export async function listKbEntries({ rootDir, errorsRoot, layer = null, since = null } = {}) {
  const r = errorRoots({ rootDir, errorsRoot });
  let entries;
  try {
    entries = await readdir(path.join(r.errorsRoot, "kb"), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const sinceMs = since ? Date.parse(since) : null;
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".json")) continue;
    let parsed;
    try { parsed = await readJson(path.join(r.errorsRoot, "kb", entry.name)); } catch { continue; }
    if (layer && parsed.layer !== layer) continue;
    if (sinceMs && Date.parse(parsed.last_seen ?? 0) < sinceMs) continue;
    out.push({
      sig: parsed.sig,
      layer: parsed.layer,
      title: parsed.title,
      occurrences: parsed.occurrences,
      first_seen: parsed.first_seen,
      last_seen: parsed.last_seen,
      plans_affected: parsed.plans_affected,
      verification: parsed.verification,
    });
  }
  return out.sort((a, b) => Date.parse(b.last_seen ?? 0) - Date.parse(a.last_seen ?? 0));
}

// Set verification subfield (called by `errors verify` after a patch
// has been confirmed in a subsequent successful iter).
export async function setVerification({ sig, verification, rootDir, errorsRoot, hmacKeyPath, now = () => new Date() }) {
  const r = errorRoots({ rootDir, errorsRoot, hmacKeyPath });
  const key = await readHmacKey(r.hmacKeyPath);
  const target = kbPath(r.errorsRoot, sig);
  const entry = await readJson(target);
  // Re-verify HMAC before mutating (don't trust a tampered base entry).
  const expected = computeKbHmac(entry, key);
  const a = Buffer.from(entry.hmac, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error(`KB tampered: ${sig} — refusing to set verification`);
  }
  entry.verification = verification;
  delete entry.hmac;
  entry.hmac = computeKbHmac(entry, key);
  await atomicWriteJson(target, entry);
  await appendIndex(r.errorsRoot, { ts: now().toISOString(), event: "errors.kb.verified", sig });
  return entry;
}

export { kbPath };
