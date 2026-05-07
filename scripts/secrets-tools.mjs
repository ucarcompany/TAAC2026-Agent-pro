#!/usr/bin/env node
// Secrets management CLI.
// - secrets check        : reports presence/absence of expected files (no read).
// - secrets init-hmac    : generates a 32-byte hex HMAC key for review-gate.
//
// All writes default to dry-run; require --execute --yes to actually persist.
// Files land under taiji-output/secrets/, which is git-ignored.

import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_SECRETS_DIR = path.join(ROOT, "taiji-output", "secrets");

function usage() {
  return `Usage:
  taac2026 secrets check
  taac2026 secrets init-hmac [--out <file>] [--execute --yes]

Files:
  taiji-output/secrets/review.hmac.key   — 32-byte hex, used to sign review tokens.
  taiji-output/secrets/taiji.cookie.json — Taiji session cookie (you create this).

Dry-run is the default. init-hmac requires --execute --yes to write.`;
}

function parseArgs(argv) {
  const args = { command: argv[0], execute: false, yes: false };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--execute") args.execute = true;
    else if (arg === "--yes") args.yes = true;
    else if (arg === "--out" && argv[i + 1]) args.out = argv[++i];
  }
  return args;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function checkSecrets(secretsDir = DEFAULT_SECRETS_DIR) {
  const cookiePath = path.join(secretsDir, "taiji.cookie.json");
  const hmacPath = path.join(secretsDir, "review.hmac.key");
  const cookie = await fileExists(cookiePath);
  const reviewHmac = await fileExists(hmacPath);
  let hmacMode = null;
  if (reviewHmac) {
    try {
      const s = await stat(hmacPath);
      hmacMode = `0o${(s.mode & 0o777).toString(8).padStart(3, "0")}`;
    } catch {
      hmacMode = "unknown";
    }
  }
  return {
    secrets_dir: secretsDir,
    files: {
      "taiji.cookie.json": { present: cookie, path: cookiePath },
      "review.hmac.key": { present: reviewHmac, path: hmacPath, mode: hmacMode },
    },
  };
}

async function initHmac({ out, execute, yes }) {
  const target = out ? path.resolve(out) : path.join(DEFAULT_SECRETS_DIR, "review.hmac.key");
  if (await fileExists(target)) {
    throw new Error(`Refusing to overwrite existing key at ${target}. Delete it first if you really want to rotate.`);
  }
  const key = randomBytes(32).toString("hex");
  const plan = {
    mode: execute ? "execute" : "dry-run",
    target,
    bytes: 32,
    encoding: "hex",
  };
  if (!execute) return { ...plan, key: "<dry-run; would generate 32 random bytes>" };
  if (!yes) throw new Error("--execute requires --yes");

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, key, { encoding: "utf8" });
  // chmod 0o600 — effective on POSIX; on Windows NTFS the bit is honored by
  // the runtime read mask but ACLs are not adjusted. Print a clear warning.
  try {
    await chmod(target, 0o600);
  } catch {
    // ignore chmod failures (Windows may reject in some configurations)
  }
  if (process.platform === "win32") {
    console.error("warning: on Windows, NTFS ACLs are not adjusted by chmod 0o600. Restrict access manually if multi-user.");
  }
  return { ...plan, written: true };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command || args.command === "--help" || args.command === "-h") {
    console.log(usage());
    return;
  }

  if (args.command === "check") {
    const report = await checkSecrets();
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (args.command === "init-hmac") {
    const result = await initHmac(args);
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

export { checkSecrets, initHmac };
