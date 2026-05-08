// Local-machine password store for SSH host aliases.
//
// Why outside the repo? The user's design constraint (M5.5):
//   - Passwords MUST NOT enter GitHub. Period.
//   - Passwords MUST be retrievable by the AI without interactive prompts
//     (autonomous nighttime training is a core design objective).
//
// Storage path: $HOME/.taac2026/host-passwords/<alias>
//   - $HOME is os.homedir() — outside the project tree, so:
//     * It is not in TAAC2026-Agent-pro.
//     * It is not in taiji-output/ (which is itself listed in .gitignore).
//     * It is not transferred via scp/rsync (we never copy ~/.taac2026).
//   - File mode 0o600 on POSIX (best-effort on Windows; NTFS ACLs are not
//     adjusted by chmod, but the per-user $HOME path already restricts).
//
// alias must match the same regex as _allowed-hosts.mjs to keep filenames
// safe and align with the SSH alias allowlist semantics.

import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isValidAlias } from "./_allowed-hosts.mjs";

const STORE_DIR_DEFAULT = path.join(os.homedir(), ".taac2026", "host-passwords");

export function passwordStorePath({ alias, storeDir = STORE_DIR_DEFAULT } = {}) {
  if (!isValidAlias(alias)) {
    throw new Error(`Invalid alias '${alias}': must match /^[A-Za-z0-9_.\-]+$/ and contain no '@'.`);
  }
  return path.join(storeDir, alias);
}

export async function setHostPassword({ alias, password, storeDir = STORE_DIR_DEFAULT }) {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("setHostPassword: password must be a non-empty string");
  }
  const target = passwordStorePath({ alias, storeDir });
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, password, { encoding: "utf8" });
  try {
    await chmod(target, 0o600);
  } catch {
    // Windows / non-POSIX — ignore. The store dir is under $HOME so the
    // OS-level user isolation already restricts access.
  }
  return { stored: true, path: target };
}

export async function hasHostPassword({ alias, storeDir = STORE_DIR_DEFAULT }) {
  try {
    await stat(passwordStorePath({ alias, storeDir }));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function getHostPassword({ alias, storeDir = STORE_DIR_DEFAULT }) {
  // No-throw on ENOENT so callers can probe; throws on every other I/O
  // error so a misconfigured permission surfaces loudly.
  try {
    const text = await readFile(passwordStorePath({ alias, storeDir }), "utf8");
    return text.replace(/\r?\n$/, "");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function removeHostPassword({ alias, storeDir = STORE_DIR_DEFAULT }) {
  try {
    await rm(passwordStorePath({ alias, storeDir }));
    return { removed: true };
  } catch (error) {
    if (error.code === "ENOENT") return { removed: false, reason: "not_present" };
    throw error;
  }
}

export async function listHostPasswords({ storeDir = STORE_DIR_DEFAULT } = {}) {
  let entries;
  try {
    entries = await readdir(storeDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const aliases = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isValidAlias(entry.name)) continue;
    let mode = null;
    try {
      const s = await stat(path.join(storeDir, entry.name));
      mode = `0o${(s.mode & 0o777).toString(8).padStart(3, "0")}`;
    } catch {}
    aliases.push({ alias: entry.name, mode });
  }
  return aliases.sort((a, b) => a.alias.localeCompare(b.alias));
}

export { STORE_DIR_DEFAULT };
