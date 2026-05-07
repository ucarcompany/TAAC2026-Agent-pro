// HMAC-SHA256 sign / verify for review-gate tokens.
// Tokens are JSON; the canonical bytes signed are the JSON-stringified
// payload with object keys recursively sorted (so hmac is stable across
// Node versions and platforms). The hmac field itself is excluded from
// the signed bytes.
//
// Token shape (skill-expansion-design-2026-05-07.md §10.2):
//   {
//     "kind": "train" | "submit",
//     "plan_id": "plan-...",
//     "proposal_sha256": "...",
//     "data_manifest_sha256": "...",
//     "research_index_sha256": "...",
//     "approved_iters": 12,
//     "approved_window": "00:00-08:00 Asia/Shanghai",
//     "max_official_submits": 0,
//     "allow_ssh": true,
//     "allow_official_submit": false,
//     "non_ensemble_ack": true,
//     "latency_budget_ack": true,
//     "issued_at": "...", "expires_at": "...",
//     "approver": "human:alice",
//     "hmac": "sha256(...)"
//   }

import { createHmac, timingSafeEqual } from "node:crypto";

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export function signPayload(payload, key) {
  if (!key) throw new Error("signPayload: key (hex string) is required");
  const { hmac: _ignored, ...rest } = payload;
  const canonical = canonicalJson(rest);
  const hmac = createHmac("sha256", Buffer.from(key, "hex")).update(canonical).digest("hex");
  return { ...rest, hmac };
}

export function verifyToken(token, key, { now = () => new Date() } = {}) {
  if (!token || typeof token !== "object") return { ok: false, reason: "token is not an object" };
  if (!key) return { ok: false, reason: "missing hmac key" };
  if (!token.hmac) return { ok: false, reason: "token missing hmac field" };

  const { hmac: provided, ...rest } = token;
  const canonical = canonicalJson(rest);
  const expected = createHmac("sha256", Buffer.from(key, "hex")).update(canonical).digest("hex");

  let bufA, bufB;
  try {
    bufA = Buffer.from(provided, "hex");
    bufB = Buffer.from(expected, "hex");
  } catch {
    return { ok: false, reason: "hmac is not hex" };
  }
  if (bufA.length !== bufB.length) return { ok: false, reason: "hmac length mismatch" };
  if (!timingSafeEqual(bufA, bufB)) return { ok: false, reason: "hmac mismatch" };

  // TTL check
  if (token.expires_at) {
    const expires = new Date(token.expires_at);
    if (Number.isNaN(expires.getTime())) return { ok: false, reason: "expires_at is not a valid ISO timestamp" };
    if (now() > expires) return { ok: false, reason: "token expired" };
  }
  return { ok: true, payload: rest };
}

// Convenience: builds a payload with issued_at / expires_at filled in.
export function buildTokenPayload({
  kind, planId, proposalSha256, dataManifestSha256, researchIndexSha256,
  approvedIters = 0, approvedWindow = "", maxOfficialSubmits = 0,
  allowSsh = false, allowOfficialSubmit = false,
  nonEnsembleAck = true, latencyBudgetAck = true,
  approver,
  ttlHours = 24,
  now = () => new Date(),
}) {
  if (!kind) throw new Error("kind is required");
  if (!planId) throw new Error("planId is required");
  if (!approver) throw new Error("approver is required");
  const issuedAt = now();
  const expiresAt = new Date(issuedAt.getTime() + ttlHours * 3600_000);
  return {
    kind,
    plan_id: planId,
    proposal_sha256: proposalSha256 ?? null,
    data_manifest_sha256: dataManifestSha256 ?? null,
    research_index_sha256: researchIndexSha256 ?? null,
    approved_iters: approvedIters,
    approved_window: approvedWindow,
    max_official_submits: maxOfficialSubmits,
    allow_ssh: allowSsh,
    allow_official_submit: allowOfficialSubmit,
    non_ensemble_ack: nonEnsembleAck,
    latency_budget_ack: latencyBudgetAck,
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    approver,
  };
}
