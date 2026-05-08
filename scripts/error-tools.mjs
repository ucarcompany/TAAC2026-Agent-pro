#!/usr/bin/env node
// error-doctor / KB CLI — M8 of skill-expansion-design-2026-05-07.md §15.
//
// Subcommands:
//   errors ingest --event-id <id> --raw <path> [--source train|taiji-api]
//                 [--plan-id <id>] [--iter-id <id>]
//   errors triage --event-id <id>
//   errors apply-patch --event-id <id> [--from-kb <sig>]
//                      [--config-overrides <json>] [--retry-only]
//                      --execute --yes
//   errors list   [--layer gpu] [--since 7d]
//   errors verify --event-id <id> --val-auc-delta <n> --latency-p95-delta-ms <n>
//                 [--passed-iter-id <id>] --execute --yes

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFile, atomicWriteJson, joinSafeRelative } from "./_taiji-http.mjs";
import { appendEvent } from "./_events.mjs";
import { buildFingerprint } from "./_error-fingerprint.mjs";
import { errorRoots, getKbEntry, listKbEntries, setVerification, upsertKbEntry } from "./_error-kb.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function usage() {
  return `Usage:
  taac2026 errors ingest --event-id <id> --raw <path> [--source train|taiji-api]
                         [--plan-id <id>] [--iter-id <id>]
  taac2026 errors triage --event-id <id>
  taac2026 errors apply-patch --event-id <id> [--from-kb <sig>]
                              [--config-overrides <json>] [--retry-only]
                              --execute --yes
  taac2026 errors list   [--layer <name>] [--since <iso|Nd>]
  taac2026 errors verify --event-id <id> --val-auc-delta <n>
                         --latency-p95-delta-ms <n>
                         [--passed-iter-id <id>] --execute --yes

Workflow: training/submit failure -> ingest raw log -> triage (KB hit
returns ready-made fix; miss flags for error-doctor subagent) ->
apply-patch records the patch in KB (HMAC-signed) -> verify after a
later successful iter to record val_auc / latency deltas.
`;
}

function parseArgs(argv) {
  const args = { command: argv[0], execute: false, yes: false, retryOnly: false };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--execute") args.execute = true;
    else if (arg === "--yes") args.yes = true;
    else if (arg === "--retry-only") args.retryOnly = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

function rootsFor({ rootDir }) {
  const errs = errorRoots({ rootDir });
  return {
    ...errs,
    eventsPath: rootDir
      ? path.join(rootDir, "taiji-output", "state", "events.ndjson")
      : path.join(ROOT, "taiji-output", "state", "events.ndjson"),
  };
}

function eventDir(errorsRoot, kind, eventId) {
  if (!/^[A-Za-z0-9_.\-]+$/.test(eventId)) throw new Error(`Invalid --event-id: ${eventId}`);
  return joinSafeRelative(errorsRoot, [kind, eventId]);
}

function parseSinceArg(since) {
  if (!since) return null;
  const m = String(since).match(/^(\d+)d$/);
  if (m) return new Date(Date.now() - Number(m[1]) * 86400_000).toISOString();
  return since;
}

// ---------- ingest ----------

export async function ingestError({
  eventId, rawPath, source = "train", planId = null, iterId = null,
  rootDir,
}) {
  if (!eventId) throw new Error("Missing --event-id");
  if (!rawPath) throw new Error("Missing --raw");
  const { errorsRoot, eventsPath } = rootsFor({ rootDir });
  const targetDir = eventDir(errorsRoot, "raw", eventId);
  await mkdir(targetDir, { recursive: true });

  const rawText = await readFile(path.resolve(rawPath), "utf8");
  // Try to parse as JSON first (status.json / submit-response.json shape);
  // otherwise treat as plain text (train.log).
  let statusJson = null;
  try { statusJson = JSON.parse(rawText); } catch {}

  const inputBase = path.basename(rawPath);
  await writeFile(path.join(targetDir, inputBase), rawText, "utf8");
  const context = {
    event_id: eventId,
    source,
    plan_id: planId,
    iter_id: iterId,
    ingested_at: new Date().toISOString(),
    raw_filename: inputBase,
  };
  await atomicWriteJson(path.join(targetDir, "context.json"), context);

  const fp = buildFingerprint({ rawText, statusJson });
  await atomicWriteJson(path.join(targetDir, "fingerprint.json"), fp);
  await appendEvent({
    event: "errors.ingested",
    actor: "cli:errors",
    payload: { event_id: eventId, sig: fp.sig, layer: fp.layer, plan_id: planId },
    eventsPath,
  });
  return { event_id: eventId, dir: targetDir, fingerprint: fp };
}

// ---------- triage ----------

export async function triageError({ eventId, rootDir }) {
  if (!eventId) throw new Error("Missing --event-id");
  const { errorsRoot, eventsPath } = rootsFor({ rootDir });
  const targetDir = eventDir(errorsRoot, "raw", eventId);
  let fp;
  try { fp = JSON.parse(await readFile(path.join(targetDir, "fingerprint.json"), "utf8")); }
  catch (error) { throw new Error(`No ingested event '${eventId}': ${error.message}`); }

  let kb;
  try { kb = await getKbEntry({ sig: fp.sig, rootDir }); }
  catch (error) {
    // HMAC tamper -> escalate, do not fall back to "miss"
    await appendEvent({ event: "errors.kb.tamper_detected", actor: "cli:errors", payload: { sig: fp.sig, error: error.message }, eventsPath });
    throw error;
  }

  // Drop a placeholder in reports/<event-id>/ either way so the user
  // has one obvious path to follow.
  const reportDir = eventDir(errorsRoot, "reports", eventId);
  await mkdir(reportDir, { recursive: true });

  if (kb) {
    await atomicWriteJson(path.join(reportDir, "triage.json"), {
      event_id: eventId,
      sig: fp.sig,
      kb_hit: true,
      kb_entry: { ...kb, hmac: undefined },
      recommendation: "apply-patch --from-kb <sig> --execute --yes (after human ack)",
    });
    await appendEvent({ event: "errors.triage.kb_hit", actor: "cli:errors", payload: { event_id: eventId, sig: fp.sig, occurrences: kb.occurrences }, eventsPath });
    return { event_id: eventId, sig: fp.sig, kb_hit: true, kb_entry: kb };
  }

  // KB miss: produce a stub for error-doctor subagent to fill.
  const stub = {
    event_id: eventId,
    sig: fp.sig,
    layer: fp.layer,
    kb_hit: false,
    instructions: "error-doctor subagent should read raw/<event-id>/ + this triage.json, then write reports/<event-id>/error-report.{md,json} + patch.diff + retry_plan.json. CLI then runs `errors apply-patch` to upsert KB.",
    fingerprint: fp,
  };
  await atomicWriteJson(path.join(reportDir, "triage.json"), stub);
  await appendEvent({ event: "errors.triage.kb_miss", actor: "cli:errors", payload: { event_id: eventId, sig: fp.sig, layer: fp.layer }, eventsPath });
  return stub;
}

// ---------- apply-patch ----------

// Reads the report directory's patch.diff / retry_plan.json (written by
// error-doctor subagent or the user), then upserts the KB entry. We do
// NOT git-apply the patch here — that's the user's call. We only record
// it.
export async function applyPatch({
  eventId, fromKb = null, configOverrides = null, retryOnly = false,
  execute = false, yes = false, rootDir,
}) {
  if (!eventId) throw new Error("Missing --event-id");
  const { errorsRoot, eventsPath } = rootsFor({ rootDir });
  const rawDir = eventDir(errorsRoot, "raw", eventId);
  const reportDir = eventDir(errorsRoot, "reports", eventId);
  const fp = JSON.parse(await readFile(path.join(rawDir, "fingerprint.json"), "utf8"));
  const sig = fromKb ?? fp.sig;
  let context = {};
  try { context = JSON.parse(await readFile(path.join(rawDir, "context.json"), "utf8")); } catch {}

  let kind = "retry-only";
  let patchRef = null;
  let summary = "";
  let configOverridesObj = null;

  if (configOverrides) {
    try { configOverridesObj = JSON.parse(configOverrides); }
    catch (error) { throw new Error(`--config-overrides must be JSON: ${error.message}`); }
    kind = "config";
    summary = `config overrides: ${Object.keys(configOverridesObj).join(", ")}`;
  }

  // Detect a patch.diff file in the report dir.
  try {
    await readFile(path.join(reportDir, "patch.diff"));
    patchRef = path.relative(errorsRoot, path.join(reportDir, "patch.diff"));
    kind = "code";
    summary = summary || "code patch via patch.diff";
  } catch {}

  if (retryOnly && !configOverridesObj && !patchRef) {
    kind = "retry-only";
    summary = "transient — retry only, no patch needed";
  }

  if (!execute) {
    return { mode: "dry-run", event_id: eventId, sig, kind, summary, patch_ref: patchRef, config_overrides: configOverridesObj };
  }
  if (!yes) throw new Error("--execute requires --yes");

  const fix = { kind, summary, patch_ref: patchRef, config_overrides: configOverridesObj };
  const { entry, mode } = await upsertKbEntry({
    sig,
    layer: fp.layer,
    title: fp.normalized_message.slice(0, 120),
    rootCause: kind === "retry-only" ? "transient (retry-only)" : "see reports/<event-id>/error-report.{md,json}",
    fix,
    planId: context.plan_id,
    rootDir,
  });
  await appendEvent({
    event: "errors.patch.applied",
    actor: "cli:errors",
    payload: { event_id: eventId, sig, kind, plan_id: context.plan_id, kb_mode: mode },
    eventsPath,
  });
  return { event_id: eventId, sig, kind, kb_mode: mode, occurrences: entry.occurrences };
}

// ---------- list ----------

export async function listErrors({ rootDir, layer = null, since = null }) {
  const sinceIso = parseSinceArg(since);
  return await listKbEntries({ rootDir, layer, since: sinceIso });
}

// ---------- verify ----------

export async function verifyError({
  eventId, valAucDelta, latencyP95DeltaMs, passedIterId = null,
  execute = false, yes = false, rootDir,
}) {
  if (!eventId) throw new Error("Missing --event-id");
  const { errorsRoot, eventsPath } = rootsFor({ rootDir });
  const rawDir = eventDir(errorsRoot, "raw", eventId);
  const fp = JSON.parse(await readFile(path.join(rawDir, "fingerprint.json"), "utf8"));

  if (!execute) {
    return { mode: "dry-run", event_id: eventId, sig: fp.sig };
  }
  if (!yes) throw new Error("--execute requires --yes");

  const verification = {
    passed_iter_id: passedIterId,
    val_auc_delta: valAucDelta == null ? null : Number(valAucDelta),
    latency_p95_delta_ms: latencyP95DeltaMs == null ? null : Number(latencyP95DeltaMs),
    verified_at: new Date().toISOString(),
  };
  await setVerification({ sig: fp.sig, verification, rootDir });
  await appendEvent({ event: "errors.verified", actor: "cli:errors", payload: { event_id: eventId, sig: fp.sig, ...verification }, eventsPath });
  return { event_id: eventId, sig: fp.sig, verification };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command || args.command === "--help") {
    console.log(usage());
    return;
  }

  if (args.command === "ingest") {
    const result = await ingestError({
      eventId: args.eventId,
      rawPath: args.raw,
      source: args.source,
      planId: args.planId,
      iterId: args.iterId,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === "triage") {
    const result = await triageError({ eventId: args.eventId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === "apply-patch") {
    const result = await applyPatch({
      eventId: args.eventId,
      fromKb: args.fromKb,
      configOverrides: args.configOverrides,
      retryOnly: args.retryOnly,
      execute: args.execute,
      yes: args.yes,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === "list") {
    const result = await listErrors({ layer: args.layer, since: args.since });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === "verify") {
    const result = await verifyError({
      eventId: args.eventId,
      valAucDelta: args.valAucDelta,
      latencyP95DeltaMs: args.latencyP95DeltaMs,
      passedIterId: args.passedIterId,
      execute: args.execute,
      yes: args.yes,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error(`Unknown subcommand: ${args.command}`);
  console.error(usage());
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
