// Error fingerprinting for the M8 error-doctor / KB pipeline.
//
// Goal: produce a stable sha256 signature for "the same root cause"
// even when timestamps, PIDs, paths and tensor shapes vary across runs.
// Same incident -> same sig -> KB hit on the second occurrence.
//
// Layer is one of: gpu / data / model / optimizer / submit-api /
// eval-api / cos / network / quota / auth. Heuristics live here so
// downstream code can stay simple.

import { createHash } from "node:crypto";

const NORM_RULES = [
  // tensor shapes: [1, 32, 64, 64] -> <SHAPE>
  [/\[\s*\d+(?:\s*,\s*\d+)+\s*\]/g, "<SHAPE>"],
  // hex addresses: 0x7f8a2c0e1100 -> <ADDR>
  [/0x[0-9a-fA-F]{6,}/g, "<ADDR>"],
  // memory amounts: 12345 MiB / 12.3 GiB / 12345 bytes -> <MEM>
  [/\b\d+(?:\.\d+)?\s*(?:bytes|B|KB|KiB|MB|MiB|GB|GiB|TB)\b/gi, "<MEM>"],
  // device indices: GPU 0 / cuda:3 / device 1 -> <DEV>
  [/\b(GPU|cuda:|device)\s*\d+\b/gi, "$1<DEV>"],
  // PID / batch / iter / epoch / seed N (small numbers that vary across runs)
  [/\b(pid|PID|batch|iter|epoch|seed)\s+\d+\b/g, "$1 <N>"],
  // ISO timestamps: 2026-05-08T14:23:45.123Z -> <TS>
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+\-]\d{2}:?\d{2})?\b/g, "<TS>"],
  // bare timestamps: 14:23:45 -> <TIME>
  [/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<TIME>"],
  // quoted abs paths: '/some/abs/path/x.py' -> '<PATH>'
  [/(['"])(?:[A-Za-z]:[\\\/]|\/)[^'"]*\.(py|mjs|js|json|yaml|yml|sh|log)\1/g, '"<PATH>"'],
  // bare abs paths
  [/(?:[A-Za-z]:[\\\/]|\/)[^\s'"]*\.(py|mjs|js|json|yaml|yml|sh|log)/g, "<PATH>"],
  // PID-ish numbers in brackets: [pid 12345] -> [pid <PID>]
  [/\[(pid|PID)\s+\d+\]/g, "[$1 <PID>]"],
  // line numbers: line 123 -> line <N>
  [/\bline\s+\d+\b/gi, "line <N>"],
  // long numeric runs (>=4 digits) -> <NUM>; keep small numbers (e.g.
  // "epoch 3", "batch 32") so message intent is preserved.
  [/\b\d{4,}\b/g, "<NUM>"],
  // hex blobs (sha-like, >=20 hex chars) -> <HEX>
  [/\b[0-9a-fA-F]{20,}\b/g, "<HEX>"],
  // IP addresses
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<IP>"],
];

export function normalizeMessage(text) {
  let out = String(text ?? "").trim();
  // Collapse runs of whitespace inside the line so different terminals
  // don't yield different sigs.
  out = out.replace(/\s+/g, " ");
  for (const [re, repl] of NORM_RULES) out = out.replace(re, repl);
  return out;
}

// Heuristic layer detection from the normalized message + status.json.
// Order matters: more specific transport-level signals (auth / quota /
// network) must win over URL-pattern signals (submit-api / eval-api),
// because a 5xx on /taskmanagement is a network-side failure even
// though the URL mentions taskmanagement.
const LAYER_RULES = [
  { layer: "auth",       re: /\b(401|403|Unauthorized|Forbidden|Permission denied \(publickey|cookie expired)/i },
  { layer: "quota",      re: /\b(429|rate limit|daily limit reached|quota[ _]exceeded)/i },
  { layer: "network",    re: /\b(ECONNRESET|ETIMEDOUT|ENETUNREACH|HTTP 5\d\d|fetch failed|getaddrinfo|TLS handshake|DNS lookup)/i },
  { layer: "gpu",        re: /\b(CUDA|cudaError|cudnn|out of memory|OOM|nvidia-smi|RuntimeError: CUDA)/i },
  { layer: "cos",        re: /\b(cos-nodejs-sdk|federation_token|cos:\/\/|myqcloud\.com)/i },
  { layer: "submit-api", re: /\b(taskmanagement\/api|webtasks\/external|prepare-taiji-submit|submit-taiji|HTTP 4\d\d|trainFiles\[)/i },
  { layer: "eval-api",   re: /\b(evaluation_tasks|eval scrape|aide\/api\/external)/i },
  { layer: "data",       re: /\b(DataLoader|Dataset|num_workers|parquet|csv|h5py|RecordIO|TFRecord|null label|missing column)/i },
  { layer: "model",      re: /\b(forward\(|backward\(|nn\.Module|torch\.nn|tensor shape|dimension mismatch|cannot broadcast)/i },
  { layer: "optimizer",  re: /\b(loss\.backward|optim|Adam|AdamW|grad_norm|NaN loss|Inf loss|GradScaler)/i },
];

export function detectLayer(normalizedMessage, statusJson) {
  if (statusJson?.layer) return String(statusJson.layer);
  for (const { layer, re } of LAYER_RULES) {
    if (re.test(normalizedMessage)) return layer;
  }
  return "unknown";
}

// Top-3 stack frames, normalized: drop absolute paths and line numbers,
// keep "module.function".
export function normalizeStackTrace(trace, { topN = 3 } = {}) {
  const text = String(trace ?? "");
  // Python style: "  File "<path>", line N, in func\n    code"
  const py = [];
  const pyRe = /File\s+"([^"]+)",\s+line\s+\d+,\s+in\s+(\S+)/g;
  let m;
  while ((m = pyRe.exec(text)) !== null && py.length < topN) {
    const file = m[1].split(/[\\/]/).pop().replace(/\.py$/, "");
    py.push(`${file}.${m[2]}`);
  }
  if (py.length > 0) return py;

  // Node style: "    at moduleName.func (/path/to/file.js:12:34)"
  const node = [];
  const nodeRe = /at\s+(?:async\s+)?([^\s]+)\s+\(/g;
  let n;
  while ((n = nodeRe.exec(text)) !== null && node.length < topN) {
    node.push(n[1]);
  }
  if (node.length > 0) return node;

  return [];
}

// Build the fingerprint object. The sig (sha256 hex) is the canonical
// cross-run identifier; the rest is human-debug payload.
export function buildFingerprint({ rawText = "", statusJson = null, exceptionClass = null } = {}) {
  const lines = String(rawText).split(/\r?\n/);
  // Use the LAST non-empty line as the message (errors usually cap the log).
  const lastNonEmpty = [...lines].reverse().find((line) => line.trim().length > 0) ?? "";
  const normalizedMessage = normalizeMessage(lastNonEmpty);

  // exception_class: "RuntimeError" / "TypeError" / etc. — first token of "Foo: ..." in the last line.
  const explicit = exceptionClass
    ?? statusJson?.exception_class
    ?? (lastNonEmpty.match(/\b([A-Z][A-Za-z0-9_]*Error|[A-Z][A-Za-z0-9_]*Exception)\b/) ?? [])[1]
    ?? null;

  const top3 = normalizeStackTrace(rawText);
  // Layer detection: scan the whole log (normalized) so a transport-level
  // signal (e.g. ETIMEDOUT on line 1) wins over a URL pattern (e.g. a
  // /taskmanagement 5xx on the last line).
  const wholeNormalized = normalizeMessage(rawText.replace(/\r?\n/g, " "));
  const layer = detectLayer(wholeNormalized, statusJson);

  const components = [
    layer,
    explicit ?? "<no-exception-class>",
    normalizedMessage,
    top3.join("|"),
  ];
  const sig = `sha256:${createHash("sha256").update(components.join("\n")).digest("hex")}`;
  return {
    sig,
    layer,
    exception_class: explicit,
    normalized_message: normalizedMessage,
    top3_stack_frames_normalized: top3,
  };
}

export { LAYER_RULES, NORM_RULES };
