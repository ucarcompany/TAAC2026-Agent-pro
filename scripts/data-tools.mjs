#!/usr/bin/env node
// Data governance CLI — M1 of skill-expansion-design-2026-05-07.md.
//
// Subcommands:
//   data ingest  --source <hf|local|cos> --dataset-id <id> [--src <path>] [--license <id>] [--execute --yes]
//   data profile --dataset-id <id> [--label-column <name>] [--execute --yes]
//
// All writes default to dry-run. Live mode requires --execute --yes.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFile, atomicWriteJson, fetchTaijiBinary, joinSafeRelative } from "./_taiji-http.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_DATA_ROOT = path.join(ROOT, "taiji-output", "data");
const DEFAULT_PROFILE_ROOT = path.join(ROOT, "taiji-output", "profiling");

function resolveRoots({ rootDir, dataRoot, profileRoot }) {
  if (rootDir) {
    return {
      dataRoot: path.join(rootDir, "taiji-output", "data"),
      profileRoot: path.join(rootDir, "taiji-output", "profiling"),
    };
  }
  return {
    dataRoot: dataRoot ?? DEFAULT_DATA_ROOT,
    profileRoot: profileRoot ?? DEFAULT_PROFILE_ROOT,
  };
}

const DEFAULT_HF_REPO = "TAAC2026/data_sample_1000";
const DEFAULT_HF_REVISION = "main";
const DEFAULT_HF_FILES = ["train.parquet"];

const LICENSE_ALLOWLIST = new Set(["cc-by-nc-4.0", "mit", "apache-2.0", "bsd-3-clause"]);

function usage() {
  return `Usage:
  taac2026 data ingest  --source <hf|local|cos> --dataset-id <id> [options]
  taac2026 data profile --dataset-id <id> [options]

Common options:
  --execute --yes        Required to actually write files.
  --out <dir>            Override output directory (under taiji-output/).

ingest options:
  --src <path>           Required for --source local. Directory of files to import.
  --license <id>         License id to record in manifest.json. Default: cc-by-nc-4.0.
  --hf-repo <repo>       For --source hf. Default: ${DEFAULT_HF_REPO}.
  --hf-revision <rev>    For --source hf. Default: ${DEFAULT_HF_REVISION}.
  --files <a,b,c>        Comma-separated file list for hf/cos. Default: ${DEFAULT_HF_FILES.join(",")}.

profile options:
  --label-column <name>  Column treated as binary label. Default: label.
  --max-rows <n>         Cap rows scanned for leakage stats. Default: 100000.
`;
}

function parseArgs(argv) {
  const args = { command: argv[0], execute: false, yes: false };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--execute") args.execute = true;
    else if (arg === "--yes") args.yes = true;
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

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function listLocalFiles(srcDir) {
  const entries = await readdir(srcDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(srcDir, entry.name);
    const s = await stat(full);
    files.push({ name: entry.name, srcPath: full, bytes: s.size });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

function dataDirFor(datasetId, dataRoot = DEFAULT_DATA_ROOT) {
  return joinSafeRelative(dataRoot, [datasetId]);
}

function profileDirFor(datasetId, profileRoot = DEFAULT_PROFILE_ROOT) {
  return joinSafeRelative(profileRoot, [datasetId]);
}

export async function ingestLocal({ datasetId, src, licenseId = "cc-by-nc-4.0", execute = false, yes = false, rootDir }) {
  if (!datasetId) throw new Error("Missing --dataset-id");
  if (!src) throw new Error("--source local requires --src <path>");
  if (String(src).split(/[\\/]/).includes("..")) {
    throw new Error("Refusing to ingest from a path that contains '..'");
  }
  const srcAbs = path.resolve(src);
  const sourceFiles = await listLocalFiles(srcAbs);
  if (!sourceFiles.length) throw new Error(`No regular files under ${srcAbs}`);

  if (!LICENSE_ALLOWLIST.has(licenseId)) {
    throw new Error(`License '${licenseId}' is not in the allowlist (${[...LICENSE_ALLOWLIST].join(", ")}).`);
  }

  const manifest = {
    version: 1,
    dataset_id: datasetId,
    source: { type: "local", uri: srcAbs },
    license: { id: licenseId, commercial_use: licenseId !== "cc-by-nc-4.0" },
    fetched_at: new Date().toISOString(),
    ingest_dry_run: !execute,
    files: [],
  };

  const { dataRoot } = resolveRoots({ rootDir });
  const targetDir = dataDirFor(datasetId, dataRoot);

  if (!execute) {
    for (const file of sourceFiles) {
      manifest.files.push({
        path: file.name,
        bytes: file.bytes,
        sha256: "<dry-run>",
      });
    }
    return { manifest, planned_target: targetDir, written: false };
  }
  if (!yes) throw new Error("--execute requires --yes");

  await mkdir(targetDir, { recursive: true });
  for (const file of sourceFiles) {
    const dest = joinSafeRelative(targetDir, [file.name]);
    const buf = await readFile(file.srcPath);
    await writeFile(dest, buf);
    manifest.files.push({
      path: file.name,
      bytes: buf.length,
      sha256: sha256Buffer(buf),
    });
  }

  await atomicWriteJson(path.join(targetDir, "manifest.json"), manifest);
  return { manifest, target: targetDir, written: true };
}

export async function ingestHf({ datasetId, hfRepo = DEFAULT_HF_REPO, hfRevision = DEFAULT_HF_REVISION, files: filesCsv, licenseId = "cc-by-nc-4.0", execute = false, yes = false, fetchImpl, rootDir }) {
  if (!datasetId) throw new Error("Missing --dataset-id");
  const fileList = filesCsv ? filesCsv.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_HF_FILES;
  if (!LICENSE_ALLOWLIST.has(licenseId)) {
    throw new Error(`License '${licenseId}' is not in the allowlist`);
  }

  const manifest = {
    version: 1,
    dataset_id: datasetId,
    source: { type: "hf", uri: `datasets/${hfRepo}@${hfRevision}` },
    license: { id: licenseId, commercial_use: licenseId !== "cc-by-nc-4.0" },
    fetched_at: new Date().toISOString(),
    ingest_dry_run: !execute,
    files: [],
  };
  const { dataRoot } = resolveRoots({ rootDir });
  const targetDir = dataDirFor(datasetId, dataRoot);

  if (!execute) {
    for (const name of fileList) manifest.files.push({ path: name, bytes: null, sha256: "<dry-run>" });
    return { manifest, planned_target: targetDir, written: false };
  }
  if (!yes) throw new Error("--execute requires --yes");

  await mkdir(targetDir, { recursive: true });
  const fetcher = fetchImpl ?? defaultHfFetch;
  for (const name of fileList) {
    const url = `https://huggingface.co/datasets/${hfRepo}/resolve/${hfRevision}/${name}`;
    const buffer = await fetcher(url);
    const dest = joinSafeRelative(targetDir, [name]);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, buffer);
    manifest.files.push({ path: name, bytes: buffer.length, sha256: sha256Buffer(buffer) });
  }
  await atomicWriteJson(path.join(targetDir, "manifest.json"), manifest);
  return { manifest, target: targetDir, written: true };
}

async function defaultHfFetch(url) {
  // HuggingFace dataset CDN is not in the Taiji cookie allowlist, so we
  // fetch anonymously with a manual timeout. Keep this function tiny — full
  // retry/backoff lives in scripts/_taiji-http.mjs for Taiji-only paths.
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`HF fetch failed: HTTP ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

// ---------- profile ----------

function detectFormat(name) {
  if (name.endsWith(".csv")) return "csv";
  if (name.endsWith(".tsv")) return "tsv";
  if (name.endsWith(".parquet")) return "parquet";
  return "unknown";
}

function parseCsv(text, sep = ",") {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (!lines.length) return { columns: [], rows: [] };
  const splitLine = (line) => {
    const out = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (inQuote) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
        else if (ch === '"') { inQuote = false; }
        else cur += ch;
      } else if (ch === '"') {
        inQuote = true;
      } else if (ch === sep) {
        out.push(cur); cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  };
  const columns = splitLine(lines[0]);
  const rows = lines.slice(1).map(splitLine);
  return { columns, rows };
}

function inferColumnType(values) {
  let allInt = true;
  let allNum = true;
  for (const v of values) {
    if (v === "" || v == null) continue;
    if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(String(v))) { allNum = false; allInt = false; break; }
    if (!/^-?\d+$/.test(String(v))) allInt = false;
  }
  if (allInt) return "int";
  if (allNum) return "float";
  return "string";
}

function rankArray(values) {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => (a.v - b.v));
  const ranks = new Array(values.length);
  for (let i = 0; i < indexed.length;) {
    let j = i;
    while (j < indexed.length - 1 && indexed[j + 1].v === indexed[i].v) j += 1;
    const avg = (i + j + 2) / 2; // 1-based average rank
    for (let k = i; k <= j; k += 1) ranks[indexed[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i += 1) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, dxx = 0, dyy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dxx += dx * dx; dyy += dy * dy;
  }
  if (dxx === 0 || dyy === 0) return 0;
  return num / Math.sqrt(dxx * dyy);
}

function spearmanFromValues(xs, ys) {
  return pearson(rankArray(xs), rankArray(ys));
}

function buildSchemaLock(columns, rows) {
  const lock = {
    version: 1,
    columns: columns.map((name, idx) => {
      const values = rows.map((r) => r[idx]).filter((v) => v !== "" && v != null);
      const sample = values.slice(0, 10000);
      const uniqueSorted = Array.from(new Set(sample)).sort();
      return {
        name,
        index: idx,
        type: inferColumnType(values),
        cardinality_hash: createHash("sha256").update(uniqueSorted.join("")).digest("hex").slice(0, 16),
      };
    }),
  };
  return lock;
}

// Detects "this column is essentially the label" using both Pearson and
// Spearman. Spearman alone has a ceiling of ~sqrt(p*(1-p)) for binary
// labels (~0.866 at 50/50 balance), which would silently miss obvious
// leakage. We trigger on whichever |coefficient| is larger; for
// continuous-vs-binary that's typically Pearson (~point-biserial).
function detectLeakageRedFlags(columns, rows, labelColumn) {
  const labelIdx = columns.indexOf(labelColumn);
  const flags = [];
  if (labelIdx === -1) return { labelColumn, flags };

  for (let c = 0; c < columns.length; c += 1) {
    if (c === labelIdx) continue;
    const colName = columns[c];
    const xs = [];
    const ys = [];
    for (let r = 0; r < rows.length; r += 1) {
      const xv = Number(rows[r][c]);
      const yv = Number(rows[r][labelIdx]);
      if (Number.isFinite(xv) && Number.isFinite(yv)) { xs.push(xv); ys.push(yv); }
    }
    if (xs.length < 50) continue;
    const r1 = pearson(xs, ys);
    const r2 = spearmanFromValues(xs, ys);
    const useR = Math.abs(r1) >= Math.abs(r2) ? r1 : r2;
    const stat = useR === r1 ? "pearson" : "spearman";
    if (Math.abs(useR) > 0.95) {
      flags.push({
        column: colName,
        statistic: stat,
        value: Number(useR.toFixed(4)),
        threshold: 0.95,
        kind: "label_correlation",
      });
    }
  }
  return { labelColumn, flags };
}

export async function profileDataset({ datasetId, labelColumn = "label", maxRows = 100_000, execute = false, yes = false, rootDir }) {
  if (!datasetId) throw new Error("Missing --dataset-id");
  const { dataRoot, profileRoot } = resolveRoots({ rootDir });
  const dataDir = dataDirFor(datasetId, dataRoot);
  const manifestPath = path.join(dataDir, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read manifest at ${manifestPath}: ${error.message}`);
  }

  const csvFile = manifest.files.find((file) => detectFormat(file.path) === "csv" || detectFormat(file.path) === "tsv");
  if (!csvFile) {
    throw new Error("data profile currently supports csv/tsv only; got: " + manifest.files.map((f) => f.path).join(", "));
  }

  const filePath = joinSafeRelative(dataDir, [csvFile.path]);
  const text = await readFile(filePath, "utf8");
  const sep = csvFile.path.endsWith(".tsv") ? "\t" : ",";
  const { columns, rows } = parseCsv(text, sep);
  const sampledRows = rows.slice(0, maxRows);

  const profileDir = profileDirFor(datasetId, profileRoot);
  const lockPath = path.join(profileDir, "schema.lock.json");
  const newLock = buildSchemaLock(columns, sampledRows);

  let lockStatus = "fresh";
  let schemaDiff = null;
  try {
    const prev = JSON.parse(await readFile(lockPath, "utf8"));
    schemaDiff = compareSchemaLock(prev, newLock);
    lockStatus = schemaDiff.changed ? "drift" : "stable";
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const { flags } = detectLeakageRedFlags(columns, sampledRows, labelColumn);

  const profile = {
    version: 1,
    dataset_id: datasetId,
    profiled_at: new Date().toISOString(),
    rows_total: rows.length,
    rows_scanned: sampledRows.length,
    columns_total: columns.length,
    schema_lock_status: lockStatus,
    schema_diff: schemaDiff,
    leakage_red_flags: flags,
    label_column: labelColumn,
    profile_dry_run: !execute,
  };

  if (!execute) {
    return { profile, planned_target: profileDir, written: false };
  }
  if (!yes) throw new Error("--execute requires --yes");

  await mkdir(profileDir, { recursive: true });
  if (lockStatus === "fresh") {
    await atomicWriteJson(lockPath, newLock);
  }
  await atomicWriteJson(path.join(profileDir, "profile.json"), profile);
  await atomicWriteFile(path.join(profileDir, "profile.md"), renderProfileMarkdown(profile));

  if (lockStatus === "drift") {
    const error = new Error(`Schema drift detected for dataset '${datasetId}'. Inspect ${path.join(profileDir, "profile.json")}.`);
    error.code = "SCHEMA_DRIFT";
    throw error;
  }
  if (flags.length) {
    const error = new Error(`Leakage red flag(s) detected: ${flags.map((f) => f.column).join(", ")}.`);
    error.code = "LEAKAGE_RED_FLAG";
    throw error;
  }

  return { profile, target: profileDir, written: true };
}

function compareSchemaLock(prev, next) {
  const prevByName = new Map(prev.columns.map((c) => [c.name, c]));
  const nextByName = new Map(next.columns.map((c) => [c.name, c]));
  const added = next.columns.filter((c) => !prevByName.has(c.name)).map((c) => c.name);
  const removed = prev.columns.filter((c) => !nextByName.has(c.name)).map((c) => c.name);
  const typeChanged = [];
  const cardinalityChanged = [];
  for (const col of next.columns) {
    const old = prevByName.get(col.name);
    if (!old) continue;
    if (old.type !== col.type) typeChanged.push({ name: col.name, from: old.type, to: col.type });
    if (old.cardinality_hash !== col.cardinality_hash) cardinalityChanged.push(col.name);
  }
  const orderChanged = !arraysEqual(prev.columns.map((c) => c.name), next.columns.map((c) => c.name));
  const changed = added.length > 0 || removed.length > 0 || typeChanged.length > 0 || orderChanged;
  return { changed, added, removed, typeChanged, cardinalityChanged, orderChanged };
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function renderProfileMarkdown(profile) {
  const lines = [];
  lines.push(`# Profile — ${profile.dataset_id}`);
  lines.push("");
  lines.push(`- profiled_at: ${profile.profiled_at}`);
  lines.push(`- rows_total: ${profile.rows_total}`);
  lines.push(`- columns_total: ${profile.columns_total}`);
  lines.push(`- schema_lock_status: **${profile.schema_lock_status}**`);
  if (profile.schema_diff?.changed) {
    lines.push("");
    lines.push("## Schema diff");
    lines.push(`- added: ${profile.schema_diff.added.join(", ") || "(none)"}`);
    lines.push(`- removed: ${profile.schema_diff.removed.join(", ") || "(none)"}`);
    lines.push(`- type changes: ${profile.schema_diff.typeChanged.map((t) => `${t.name}:${t.from}→${t.to}`).join(", ") || "(none)"}`);
    lines.push(`- order changed: ${profile.schema_diff.orderChanged}`);
  }
  lines.push("");
  lines.push("## Leakage red flags");
  if (!profile.leakage_red_flags.length) {
    lines.push("(none)");
  } else {
    for (const flag of profile.leakage_red_flags) {
      lines.push(`- **${flag.column}** — ${flag.statistic}=${flag.value} (threshold ${flag.threshold}, kind=${flag.kind})`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command || args.command === "--help" || args.command === "-h") {
    console.log(usage());
    return;
  }

  if (args.command === "ingest") {
    if (!args.source) throw new Error("--source <hf|local|cos> is required");
    let result;
    if (args.source === "local") {
      result = await ingestLocal({
        datasetId: args.datasetId,
        src: args.src,
        licenseId: args.license,
        execute: args.execute,
        yes: args.yes,
      });
    } else if (args.source === "hf") {
      result = await ingestHf({
        datasetId: args.datasetId,
        hfRepo: args.hfRepo,
        hfRevision: args.hfRevision,
        files: args.files,
        licenseId: args.license,
        execute: args.execute,
        yes: args.yes,
      });
    } else if (args.source === "cos") {
      throw new Error("--source cos requires a configured cookie + COS prefix; not implemented in M1");
    } else {
      throw new Error(`Unknown --source ${args.source}`);
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === "profile") {
    const result = await profileDataset({
      datasetId: args.datasetId,
      labelColumn: args.labelColumn,
      maxRows: args.maxRows ? Number(args.maxRows) : undefined,
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
    if (error.code === "SCHEMA_DRIFT" || error.code === "LEAKAGE_RED_FLAG") process.exitCode = 2;
    else process.exitCode = 1;
  });
}
