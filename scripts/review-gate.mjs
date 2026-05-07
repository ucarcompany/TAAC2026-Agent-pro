#!/usr/bin/env node
// review-gate CLI — M3 of skill-expansion-design-2026-05-07.md §10.
//
// Subcommands:
//   review issue   --kind train|submit --plan-id <id> --approver <name>
//                  [--ttl-hours 24] [--token-out <path>] --execute --yes
//   review verify  --kind train|submit [--token-file <path>] [--plan-id <id>]
//   review status  [--plan-id <id>]
//
// HMAC key path is fixed: taiji-output/secrets/review.hmac.key (32-byte hex).
// Generate it with: taac2026 secrets init-hmac --execute --yes
//
// Tokens land in:
//   taiji-output/state/.review-token-train  (24h default TTL)
//   taiji-output/state/.review-token-submit (2h default TTL, requires
//                                            TAAC2026_SECOND_APPROVER env)

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteJson, joinSafeRelative } from "./_taiji-http.mjs";
import { buildTokenPayload, signPayload, verifyToken } from "./_hmac.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_SECRETS_DIR = path.join(ROOT, "taiji-output", "secrets");
const DEFAULT_STATE_DIR = path.join(ROOT, "taiji-output", "state");
const DEFAULT_PROPOSALS_ROOT = path.join(ROOT, "taiji-output", "proposals");

const VALID_KINDS = new Set(["train", "submit"]);
const DEFAULT_TTL_BY_KIND = { train: 24, submit: 2 };
const TOKEN_FILENAME_BY_KIND = { train: ".review-token-train", submit: ".review-token-submit" };

function usage() {
  return `Usage:
  taac2026 review issue   --kind <train|submit> --plan-id <id> --approver <name>
                          [--ttl-hours <n>] [--token-out <path>] --execute --yes
  taac2026 review verify  --kind <train|submit> [--token-file <path>] [--plan-id <id>]
  taac2026 review status  [--plan-id <id>]

Submit tokens additionally require the TAAC2026_SECOND_APPROVER environment
variable (a second human approver, design §10) when issuing.
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

function rootsFor({ rootDir }) {
  if (rootDir) {
    return {
      secretsDir: path.join(rootDir, "taiji-output", "secrets"),
      stateDir: path.join(rootDir, "taiji-output", "state"),
      proposalsRoot: path.join(rootDir, "taiji-output", "proposals"),
    };
  }
  return {
    secretsDir: DEFAULT_SECRETS_DIR,
    stateDir: DEFAULT_STATE_DIR,
    proposalsRoot: DEFAULT_PROPOSALS_ROOT,
  };
}

async function readHmacKey(secretsDir) {
  const keyPath = path.join(secretsDir, "review.hmac.key");
  try {
    const s = await stat(keyPath);
    if (process.platform !== "win32" && (s.mode & 0o077) !== 0) {
      console.warn(`warning: ${keyPath} is too permissive (mode 0o${(s.mode & 0o777).toString(8)}). Run \`chmod 600\`.`);
    }
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Missing HMAC key at ${keyPath}. Run \`taac2026 secrets init-hmac --execute --yes\`.`);
    throw error;
  }
  const text = (await readFile(keyPath, "utf8")).trim();
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw new Error(`HMAC key at ${keyPath} is not 32-byte hex (got ${text.length} chars)`);
  }
  return text;
}

async function readProposalShas({ proposalsRoot, planId }) {
  if (!planId) return { proposalSha256: null, dataManifestSha256: null, researchIndexSha256: null };
  const dir = joinSafeRelative(proposalsRoot, [planId]);
  try {
    const proposalJson = JSON.parse(await readFile(path.join(dir, "proposal.json"), "utf8"));
    return {
      proposalSha256: proposalJson.proposal_sha256 ?? null,
      dataManifestSha256: proposalJson.data_manifest_sha256 ?? null,
      researchIndexSha256: proposalJson.research_index_sha256 ?? null,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`No proposal.json at ${dir}. Run \`taac2026 propose freeze --plan-id ${planId} --execute --yes\` first.`);
    }
    throw error;
  }
}

export async function issueToken({
  kind, planId, approver, ttlHours, tokenOut, execute = false, yes = false, rootDir,
  secondApprover = process.env.TAAC2026_SECOND_APPROVER,
}) {
  if (!VALID_KINDS.has(kind)) throw new Error("--kind must be 'train' or 'submit'");
  if (!planId) throw new Error("Missing --plan-id");
  if (!approver) throw new Error("Missing --approver");
  if (kind === "submit" && !secondApprover) {
    throw new Error("submit token requires a second human approver via env TAAC2026_SECOND_APPROVER");
  }

  const { secretsDir, stateDir, proposalsRoot } = rootsFor({ rootDir });
  const key = await readHmacKey(secretsDir);
  const shas = await readProposalShas({ proposalsRoot, planId });

  const ttl = Number(ttlHours ?? DEFAULT_TTL_BY_KIND[kind]);
  const payload = buildTokenPayload({
    kind,
    planId,
    proposalSha256: shas.proposalSha256,
    dataManifestSha256: shas.dataManifestSha256,
    researchIndexSha256: shas.researchIndexSha256,
    approvedIters: kind === "train" ? 12 : 0,
    approvedWindow: "00:00-08:00 Asia/Shanghai",
    maxOfficialSubmits: kind === "submit" ? 1 : 0,
    allowSsh: kind === "train",
    allowOfficialSubmit: kind === "submit",
    nonEnsembleAck: true,
    latencyBudgetAck: true,
    approver: kind === "submit" ? `human:${approver}+human:${secondApprover}` : `human:${approver}`,
    ttlHours: ttl,
  });
  const signed = signPayload(payload, key);

  if (!execute) {
    return { mode: "dry-run", planned_target: tokenOut ?? path.join(stateDir, TOKEN_FILENAME_BY_KIND[kind]), payload_preview: { ...payload, hmac: "<would-be-computed>" } };
  }
  if (!yes) throw new Error("--execute requires --yes");

  const target = tokenOut ? path.resolve(tokenOut) : path.join(stateDir, TOKEN_FILENAME_BY_KIND[kind]);
  await atomicWriteJson(target, signed);
  return { mode: "execute", target, kind, plan_id: planId, expires_at: payload.expires_at };
}

export async function verify({ kind, tokenFile, planId, rootDir, now = () => new Date() }) {
  const { secretsDir, stateDir } = rootsFor({ rootDir });
  const target = tokenFile ? path.resolve(tokenFile) : path.join(stateDir, TOKEN_FILENAME_BY_KIND[kind]);
  let token;
  try {
    token = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { ok: false, reason: `token file missing: ${target}`, target };
    return { ok: false, reason: `token file unparseable: ${error.message}`, target };
  }

  const key = await readHmacKey(secretsDir);
  const result = verifyToken(token, key, { now });
  if (!result.ok) return { ok: false, reason: result.reason, target };

  if (kind && token.kind !== kind) {
    return { ok: false, reason: `kind mismatch: token=${token.kind} expected=${kind}`, target };
  }
  if (planId && token.plan_id !== planId) {
    return { ok: false, reason: `plan_id mismatch: token=${token.plan_id} expected=${planId}`, target };
  }
  return { ok: true, target, payload: token };
}

export async function status({ planId, rootDir }) {
  const { stateDir } = rootsFor({ rootDir });
  const out = {};
  for (const k of ["train", "submit"]) {
    const target = path.join(stateDir, TOKEN_FILENAME_BY_KIND[k]);
    try {
      const token = JSON.parse(await readFile(target, "utf8"));
      const matchesPlan = !planId || token.plan_id === planId;
      out[k] = {
        present: true,
        path: target,
        plan_id: token.plan_id,
        approver: token.approver,
        issued_at: token.issued_at,
        expires_at: token.expires_at,
        plan_match: matchesPlan,
      };
    } catch (error) {
      out[k] = { present: false, path: target };
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command || args.command === "--help") {
    console.log(usage());
    return;
  }

  if (args.command === "issue") {
    const result = await issueToken({
      kind: args.kind,
      planId: args.planId,
      approver: args.approver,
      ttlHours: args.ttlHours,
      tokenOut: args.tokenOut,
      execute: args.execute,
      yes: args.yes,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === "verify") {
    const result = await verify({ kind: args.kind, tokenFile: args.tokenFile, planId: args.planId });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  if (args.command === "status") {
    const result = await status({ planId: args.planId });
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
