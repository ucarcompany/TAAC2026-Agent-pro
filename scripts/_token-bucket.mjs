// File-backed token bucket for outbound rate-limited APIs.
// Each source ("arxiv", "github", "serpapi") has its own bucket persisted to
// taiji-output/state/token-buckets.json so consecutive CLI invocations
// share the same budget. Concurrent invocations within a single process are
// serialized via an in-memory mutex; cross-process serialization relies on
// rename-based atomic write of the state file (best-effort).
//
// Defaults follow the upstream API limits documented in
// taiji-output/reports/skill-expansion-design-2026-05-07.md §8.5:
//   arxiv      :  1 token / 3s     (== 20/min)
//   github     :  30 tokens / 60s  (search REST)
//   github_code:  10 tokens / 60s  (code search REST)
//   serpapi    :  monthly quota — handled at a higher layer

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_STATE = path.join(ROOT, "taiji-output", "state", "token-buckets.json");

export const DEFAULT_BUCKETS = {
  arxiv: { capacity: 20, refillPerSec: 1 / 3, label: "arXiv API (1 req/3s)" },
  github: { capacity: 30, refillPerSec: 30 / 60, label: "GitHub Search (30/min)" },
  github_code: { capacity: 10, refillPerSec: 10 / 60, label: "GitHub Code Search (10/min)" },
  serpapi: { capacity: 60, refillPerSec: 60 / 60, label: "SerpAPI (60/min nominal)" },
};

const inProcessLocks = new Map();

async function acquireLock(key) {
  const prev = inProcessLocks.get(key);
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  inProcessLocks.set(key, prev ? prev.then(() => next) : next);
  if (prev) await prev;
  return release;
}

async function readState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeStateAtomic(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, statePath);
}

function refill(bucket, config, nowMs) {
  const elapsedSec = Math.max(0, (nowMs - bucket.last_refill_ms) / 1000);
  const refillAmount = elapsedSec * config.refillPerSec;
  bucket.tokens = Math.min(config.capacity, bucket.tokens + refillAmount);
  bucket.last_refill_ms = nowMs;
}

function timeUntilReady(bucket, config, n) {
  if (bucket.tokens >= n) return 0;
  const deficit = n - bucket.tokens;
  return Math.ceil((deficit / config.refillPerSec) * 1000);
}

export async function consume({
  source,
  n = 1,
  statePath = DEFAULT_STATE,
  buckets = DEFAULT_BUCKETS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxWaitMs = 5 * 60_000,
} = {}) {
  if (!source) throw new Error("token-bucket consume: source is required");
  const config = buckets[source];
  if (!config) throw new Error(`token-bucket consume: unknown source ${source}`);
  if (n > config.capacity) throw new Error(`token-bucket consume: n=${n} exceeds capacity=${config.capacity}`);

  const release = await acquireLock(statePath);
  try {
    let totalWait = 0;
    while (true) {
      const state = await readState(statePath);
      const bucket = state[source] ?? { tokens: config.capacity, last_refill_ms: now() };
      refill(bucket, config, now());

      if (bucket.tokens >= n) {
        bucket.tokens -= n;
        state[source] = bucket;
        await writeStateAtomic(statePath, state);
        return { consumed: n, waited_ms: totalWait, remaining: bucket.tokens };
      }

      const wait = timeUntilReady(bucket, config, n);
      // Persist the refilled-but-not-consumed state so concurrent waiters
      // see the same picture.
      state[source] = bucket;
      await writeStateAtomic(statePath, state);
      totalWait += wait;
      if (totalWait > maxWaitMs) {
        throw new Error(`token-bucket consume: ${source} budget exhausted (waited ${totalWait}ms)`);
      }
      await sleep(wait);
    }
  } finally {
    release();
  }
}

export async function inspect({ statePath = DEFAULT_STATE, buckets = DEFAULT_BUCKETS, now = () => Date.now() } = {}) {
  const state = await readState(statePath);
  const out = {};
  for (const [source, config] of Object.entries(buckets)) {
    const bucket = state[source] ?? { tokens: config.capacity, last_refill_ms: now() };
    refill(bucket, config, now());
    out[source] = { ...bucket, capacity: config.capacity, refillPerSec: config.refillPerSec, label: config.label };
  }
  return out;
}
