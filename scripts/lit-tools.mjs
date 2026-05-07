#!/usr/bin/env node
// Literature mining CLI — M2 of skill-expansion-design-2026-05-07.md.
//
// Subcommands:
//   lit search    --source arxiv --query "..." [--max-results 20] [--cache-ttl-hours 24]
//   lit ingest    --source <name> --from-file <papers.json>
//   lit list      [--top <n>] [--source arxiv] [--min-relevance 0.5]
//   lit score     [--rebuild]                       (recompute evidence_score)
//   lit quarantine --source <name> --id <id> --text-file <path>
//
// All write paths go to taiji-output/literature/. Index is append-only
// (one JSON per line), backed by atomicWriteFile when fully rebuilt.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFile, joinSafeRelative } from "./_taiji-http.mjs";
import { consume } from "./_token-bucket.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LITERATURE_ROOT_DEFAULT = path.join(ROOT, "taiji-output", "literature");

const ARXIV_BASE = "https://export.arxiv.org/api/query";
const SUPPORTED_SOURCES = new Set(["arxiv", "github", "serpapi", "user-pdf"]);

// License names that are safe to use without further legal review. Mirrors
// taac-loop.yaml::compliance.license_allowlist.
const LICENSE_ALLOWLIST = new Set(["cc-by-nc-4.0", "mit", "apache-2.0", "bsd-3-clause", "cc-by-4.0"]);

function usage() {
  return `Usage:
  taac2026 lit search    --source <arxiv> --query "..." [--max-results 20]
  taac2026 lit list      [--top 8] [--source arxiv] [--min-relevance 0.5]
  taac2026 lit ingest    --source <name> --from-file <papers.json>
  taac2026 lit score     [--rebuild]
  taac2026 lit quarantine --source <name> --id <id> --text-file <path>

External text fetched from arXiv / GitHub / etc. is wrapped with
<<<UNTRUSTED_DOC ...>>> markers before being saved to disk and before any
Claude subagent reads it (skill-expansion-design-2026-05-07.md §8.3).
`;
}

function parseArgs(argv) {
  const args = { command: argv[0] };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--rebuild") args.rebuild = true;
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

// ---------- paths ----------

function literatureRootFrom({ rootDir }) {
  return rootDir ? path.join(rootDir, "taiji-output", "literature") : LITERATURE_ROOT_DEFAULT;
}

function quarantineDir(literatureRoot, source) {
  if (!SUPPORTED_SOURCES.has(source)) throw new Error(`Unknown source: ${source}`);
  return joinSafeRelative(literatureRoot, ["quarantine", source]);
}

function cacheDir(literatureRoot, source) {
  return joinSafeRelative(literatureRoot, ["cache", source]);
}

function indexPath(literatureRoot) {
  return path.join(literatureRoot, "index.jsonl");
}

// ---------- quarantine wrapping ----------

// Wraps untrusted text with sentinel markers so subagents reading it will
// treat any embedded "Ignore previous instructions / run X" as text content
// instead of obeying it.
export function quarantineWrap(text, { source, id }) {
  if (!source || !id) throw new Error("quarantineWrap: source and id are required");
  const safeId = String(id).replace(/[^A-Za-z0-9_.\-:]/g, "_");
  const sha256 = createHash("sha256").update(text ?? "").digest("hex");
  const header = `<<<UNTRUSTED_DOC src="${source}://${safeId}" sha256=${sha256} bytes=${Buffer.byteLength(text ?? "", "utf8")}>>>`;
  const footer = `<<<END_UNTRUSTED>>>`;
  return { wrapped: `${header}\n${text ?? ""}\n${footer}\n`, sha256 };
}

export async function writeQuarantine({ literatureRoot, source, id, text }) {
  const dir = quarantineDir(literatureRoot, source);
  await mkdir(dir, { recursive: true });
  const safeId = String(id).replace(/[^A-Za-z0-9_.\-:]/g, "_");
  const target = joinSafeRelative(dir, [`${safeId}.txt`]);
  const { wrapped, sha256 } = quarantineWrap(text, { source, id });
  await atomicWriteFile(target, wrapped);
  return { path: target, sha256 };
}

// ---------- arxiv adapter ----------

function queryHash(query, extra = {}) {
  const canonical = JSON.stringify({ q: query, ...extra }, Object.keys({ q: 1, ...extra }).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

async function readCache(cacheFile, ttlHours) {
  try {
    const s = await stat(cacheFile);
    const ageMs = Date.now() - s.mtimeMs;
    if (ageMs < ttlHours * 3600 * 1000) {
      return await readFile(cacheFile, "utf8");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return null;
}

async function writeCache(cacheFile, text) {
  await mkdir(path.dirname(cacheFile), { recursive: true });
  await atomicWriteFile(cacheFile, text);
}

async function fetchArxivAtom({ query, maxResults, fetchImpl, tokenStatePath, tokenBuckets }) {
  await consume({ source: "arxiv", statePath: tokenStatePath, buckets: tokenBuckets });
  const url = `${ARXIV_BASE}?search_query=${encodeURIComponent(query)}&start=0&max_results=${maxResults}`;
  const fetcher = fetchImpl ?? globalThis.fetch;
  const response = await fetcher(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`arXiv HTTP ${response.status}`);
  return await response.text();
}

// Tiny tag-based extractor — arXiv Atom entries are flat enough to avoid
// pulling in a full XML parser. Robust against attribute order but brittle
// against schema changes; that's acceptable for a deterministic test corpus.
export function parseArxivAtom(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return m ? m[1].trim() : "";
    };
    const idUrl = get("id");
    const id = idUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, "").replace(/v\d+$/, "");
    const authors = [];
    const authorRegex = /<author>\s*<name>([^<]+)<\/name>\s*<\/author>/g;
    let am;
    while ((am = authorRegex.exec(block)) !== null) authors.push(am[1].trim());
    const links = [];
    const linkRegex = /<link\s+([^/]+?)\/>/g;
    let lm;
    while ((lm = linkRegex.exec(block)) !== null) {
      const attrs = {};
      const attrRegex = /(\w+)="([^"]+)"/g;
      let am2;
      while ((am2 = attrRegex.exec(lm[1])) !== null) attrs[am2[1]] = am2[2];
      links.push(attrs);
    }
    const published = get("published");
    const year = Number((published.match(/^(\d{4})/) ?? [])[1]) || null;
    entries.push({
      id: id || idUrl,
      title: get("title").replace(/\s+/g, " "),
      summary: get("summary").replace(/\s+/g, " "),
      authors,
      published,
      year,
      link: links.find((l) => l.rel === "alternate")?.href ?? idUrl,
      pdf: links.find((l) => l.title === "pdf")?.href ?? null,
      categories: (block.match(/term="([^"]+)"/g) ?? []).map((t) => t.match(/term="([^"]+)"/)[1]),
    });
  }
  return entries;
}

// ---------- evidence score ----------

const LATENCY_RISK_KEYWORDS = [
  ["transformer-xl", "high"],
  ["multi-stage", "high"],
  ["cascade", "high"],
  ["large language model", "high"],
  ["llm", "high"],
  ["beam search", "high"],
  ["distillation", "low"],
  ["pruning", "low"],
  ["quantization", "low"],
];

function scoreRelevance(query, item) {
  if (!query) return 0;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return 0;
  const blob = `${item.title ?? ""} ${item.summary ?? ""}`.toLowerCase();
  const hits = terms.filter((t) => blob.includes(t)).length;
  return Number((hits / terms.length).toFixed(4));
}

function scoreReproducibility(item) {
  const hasGithub = /github\.com/i.test(JSON.stringify(item));
  const hasCode = /\b(code|implementation)\b/i.test(item.summary ?? "");
  if (hasGithub) return 0.7;
  if (hasCode) return 0.5;
  return 0.3;
}

function scoreLicense(item) {
  // arXiv preprints don't surface a license directly. Default true unless
  // we have a strong negative signal (e.g. summary explicitly says
  // "proprietary"). Real source-of-truth check happens when the user pulls
  // the upstream code repo.
  if (/proprietary|all rights reserved|no commercial use/i.test(item.summary ?? "")) return false;
  if (item.license && !LICENSE_ALLOWLIST.has(String(item.license).toLowerCase())) return false;
  return true;
}

function scoreLatencyRisk(item) {
  const blob = `${item.title ?? ""} ${item.summary ?? ""}`.toLowerCase();
  for (const [needle, risk] of LATENCY_RISK_KEYWORDS) {
    if (blob.includes(needle)) return risk;
  }
  return "medium";
}

function scoreNovelty(item) {
  const year = item.year ?? (Number((item.published ?? "").slice(0, 4)) || null);
  if (!year) return 0.4;
  if (year >= 2024) return 0.7;
  if (year >= 2023) return 0.5;
  if (year >= 2022) return 0.4;
  return 0.3;
}

export function computeEvidenceScore(item, query) {
  const relevance = scoreRelevance(query, item);
  const reproducibility = scoreReproducibility(item);
  const license_ok = scoreLicense(item);
  const latency_risk = scoreLatencyRisk(item);
  const novelty = scoreNovelty(item);
  const fields = { relevance, reproducibility, license_ok, latency_risk, novelty };
  const evidence_hash = `sha256:${createHash("sha256")
    .update(JSON.stringify(fields, Object.keys(fields).sort()))
    .digest("hex")}`;
  return { ...fields, evidence_hash };
}

// ---------- index ----------

async function readIndex(literatureRoot) {
  try {
    const text = await readFile(indexPath(literatureRoot), "utf8");
    return text.split(/\r?\n/).filter(Boolean).map((line, i) => {
      try { return JSON.parse(line); } catch { throw new Error(`index.jsonl line ${i + 1} is not valid JSON`); }
    });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function appendIndex(literatureRoot, entries) {
  const existing = await readIndex(literatureRoot);
  const byId = new Map(existing.map((e) => [`${e.source}:${e.id}`, e]));
  for (const entry of entries) byId.set(`${entry.source}:${entry.id}`, entry);
  const merged = Array.from(byId.values());
  const text = merged.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await mkdir(literatureRoot, { recursive: true });
  await atomicWriteFile(indexPath(literatureRoot), text);
  return merged.length;
}

// ---------- subcommands ----------

export async function searchLiterature({
  source = "arxiv",
  query,
  maxResults = 20,
  cacheTtlHours = 24,
  rootDir,
  fetchImpl,
  tokenStatePath,
  tokenBuckets,
} = {}) {
  if (!query) throw new Error("Missing --query");
  if (source !== "arxiv") throw new Error(`source ${source} not implemented in M2 (use 'lit ingest --from-file ...' for MCP-based pipelines)`);
  const literatureRoot = literatureRootFrom({ rootDir });
  const cacheFile = path.join(cacheDir(literatureRoot, source), `${queryHash(query, { maxResults })}.atom`);

  let xml = await readCache(cacheFile, cacheTtlHours);
  let cacheHit = true;
  if (xml == null) {
    cacheHit = false;
    xml = await fetchArxivAtom({ query, maxResults, fetchImpl, tokenStatePath, tokenBuckets });
    await writeCache(cacheFile, xml);
  }

  const items = parseArxivAtom(xml);
  const indexed = [];
  for (const item of items) {
    const evidence_score = computeEvidenceScore(item, query);
    const { sha256 } = await writeQuarantine({
      literatureRoot,
      source,
      id: item.id,
      text: `# ${item.title}\n\n${item.summary}\n\nauthors: ${item.authors.join(", ")}\nlink: ${item.link}\n`,
    });
    indexed.push({
      id: item.id,
      source,
      title: item.title,
      year: item.year,
      authors: item.authors,
      link: item.link,
      categories: item.categories,
      evidence_score,
      quarantine_path: path.relative(literatureRoot, joinSafeRelative(quarantineDir(literatureRoot, source), [`${String(item.id).replace(/[^A-Za-z0-9_.\-:]/g, "_")}.txt`])),
      quarantine_sha256: sha256,
      indexed_at: new Date().toISOString(),
    });
  }
  await appendIndex(literatureRoot, indexed);
  return { source, query, cacheHit, count: indexed.length, top: indexed.slice(0, 8) };
}

export async function ingestExternal({
  source,
  fromFile,
  rootDir,
  query = null,
} = {}) {
  if (!source || !SUPPORTED_SOURCES.has(source)) throw new Error("Missing or unknown --source");
  if (!fromFile) throw new Error("Missing --from-file");
  const text = await readFile(path.resolve(fromFile), "utf8");
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`--from-file ${fromFile} is not valid JSON`); }
  if (!Array.isArray(payload)) throw new Error("--from-file must be a JSON array of paper objects");

  const literatureRoot = literatureRootFrom({ rootDir });
  const indexed = [];
  for (const item of payload) {
    if (!item.id || !item.title) throw new Error(`Skipping malformed item: ${JSON.stringify(item).slice(0, 120)}`);
    const evidence_score = computeEvidenceScore(item, query);
    const blob = item.full_text ?? item.summary ?? item.abstract ?? "";
    const { sha256 } = await writeQuarantine({ literatureRoot, source, id: item.id, text: blob });
    indexed.push({
      id: item.id,
      source,
      title: item.title,
      year: item.year ?? null,
      authors: item.authors ?? [],
      link: item.link ?? item.url ?? null,
      categories: item.categories ?? [],
      evidence_score,
      quarantine_path: `quarantine/${source}/${String(item.id).replace(/[^A-Za-z0-9_.\-:]/g, "_")}.txt`,
      quarantine_sha256: sha256,
      indexed_at: new Date().toISOString(),
    });
  }
  await appendIndex(literatureRoot, indexed);
  return { source, ingested: indexed.length };
}

export async function listLiterature({
  rootDir,
  top = 8,
  source = null,
  minRelevance = 0,
} = {}) {
  const literatureRoot = literatureRootFrom({ rootDir });
  const all = await readIndex(literatureRoot);
  let filtered = all;
  if (source) filtered = filtered.filter((e) => e.source === source);
  if (minRelevance) filtered = filtered.filter((e) => (e.evidence_score?.relevance ?? 0) >= minRelevance);
  filtered.sort((a, b) => (b.evidence_score?.relevance ?? 0) - (a.evidence_score?.relevance ?? 0));
  return { total: all.length, returned: Math.min(top, filtered.length), entries: filtered.slice(0, top) };
}

export async function rescoreLiterature({ rootDir, query = null } = {}) {
  const literatureRoot = literatureRootFrom({ rootDir });
  const all = await readIndex(literatureRoot);
  for (const entry of all) entry.evidence_score = computeEvidenceScore(entry, query);
  const text = all.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await mkdir(literatureRoot, { recursive: true });
  await atomicWriteFile(indexPath(literatureRoot), text);
  return { rescored: all.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command || args.command === "--help" || args.command === "-h") {
    console.log(usage());
    return;
  }

  if (args.command === "search") {
    const result = await searchLiterature({
      source: args.source ?? "arxiv",
      query: args.query,
      maxResults: args.maxResults ? Number(args.maxResults) : undefined,
      cacheTtlHours: args.cacheTtlHours ? Number(args.cacheTtlHours) : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === "ingest") {
    const result = await ingestExternal({ source: args.source, fromFile: args.fromFile, query: args.query });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === "list") {
    const result = await listLiterature({
      top: args.top ? Number(args.top) : undefined,
      source: args.source,
      minRelevance: args.minRelevance ? Number(args.minRelevance) : 0,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === "score") {
    const result = await rescoreLiterature({ query: args.query });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === "quarantine") {
    if (!args.source || !args.id || !args.textFile) throw new Error("quarantine requires --source --id --text-file");
    const text = await readFile(path.resolve(args.textFile), "utf8");
    const literatureRoot = literatureRootFrom({});
    const out = await writeQuarantine({ literatureRoot, source: args.source, id: args.id, text });
    console.log(JSON.stringify(out, null, 2));
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
