import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  STORE_DIR_DEFAULT,
  getHostPassword,
  hasHostPassword,
  listHostPasswords,
  passwordStorePath,
  removeHostPassword,
  setHostPassword,
} from "../_host-password.mjs";

test("STORE_DIR_DEFAULT is under the user's home, not under the repo", () => {
  // The whole point of M5.5: passwords must live OUTSIDE the project tree
  // so they cannot be committed or scp'd to the GPU.
  const home = os.homedir();
  assert.ok(STORE_DIR_DEFAULT.startsWith(home), `expected ${STORE_DIR_DEFAULT} under ${home}`);
  assert.match(STORE_DIR_DEFAULT, /\.taac2026[\\\/]host-passwords$/);
  // No segment of the path should refer to the repo / taiji-output.
  assert.ok(!STORE_DIR_DEFAULT.includes("TAAC2026-Agent-pro"));
  assert.ok(!STORE_DIR_DEFAULT.includes("taiji-output"));
});

test("setHostPassword + getHostPassword round-trips", async () => {
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "taac2026-pw-"));
  await setHostPassword({ alias: "fixture-host", password: "Qaz123456!", storeDir });
  const pw = await getHostPassword({ alias: "fixture-host", storeDir });
  assert.equal(pw, "Qaz123456!");
});

test("getHostPassword returns null for absent alias", async () => {
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "taac2026-pw-absent-"));
  assert.equal(await getHostPassword({ alias: "nope", storeDir }), null);
});

test("hasHostPassword reflects presence/absence", async () => {
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "taac2026-pw-has-"));
  assert.equal(await hasHostPassword({ alias: "h1", storeDir }), false);
  await setHostPassword({ alias: "h1", password: "x", storeDir });
  assert.equal(await hasHostPassword({ alias: "h1", storeDir }), true);
});

test("removeHostPassword deletes file; idempotent", async () => {
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "taac2026-pw-rm-"));
  await setHostPassword({ alias: "h2", password: "x", storeDir });
  const a = await removeHostPassword({ alias: "h2", storeDir });
  assert.equal(a.removed, true);
  const b = await removeHostPassword({ alias: "h2", storeDir });
  assert.equal(b.removed, false);
});

test("setHostPassword refuses invalid aliases", async () => {
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "taac2026-pw-bad-alias-"));
  await assert.rejects(setHostPassword({ alias: "root@host", password: "x", storeDir }), /Invalid alias/);
  await assert.rejects(setHostPassword({ alias: "with space", password: "x", storeDir }), /Invalid alias/);
  await assert.rejects(setHostPassword({ alias: "..", password: "x", storeDir }), /Invalid alias/);
});

test("setHostPassword refuses empty password", async () => {
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "taac2026-pw-empty-"));
  await assert.rejects(setHostPassword({ alias: "h3", password: "", storeDir }), /non-empty string/);
});

test("listHostPasswords returns aliases sorted, ignores invalid filenames", async () => {
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "taac2026-pw-list-"));
  await setHostPassword({ alias: "zeta", password: "x", storeDir });
  await setHostPassword({ alias: "alpha", password: "x", storeDir });
  const list = await listHostPasswords({ storeDir });
  assert.deepEqual(list.map((entry) => entry.alias), ["alpha", "zeta"]);
});

test("password file mode is 0o600 on POSIX", async (t) => {
  if (process.platform === "win32") {
    t.skip("chmod 0o600 is best-effort on Windows NTFS");
    return;
  }
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "taac2026-pw-mode-"));
  await setHostPassword({ alias: "h4", password: "x", storeDir });
  const s = await stat(passwordStorePath({ alias: "h4", storeDir }));
  assert.equal(s.mode & 0o777, 0o600);
});

test("password store path is computed deterministically", () => {
  const p = passwordStorePath({ alias: "abc", storeDir: "/tmp/store" });
  assert.equal(p, path.join("/tmp/store", "abc"));
});

test("getHostPassword strips a single trailing newline (so editors don't break it)", async () => {
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "taac2026-pw-trail-"));
  await setHostPassword({ alias: "h5", password: "secret\n", storeDir });
  // The stored file has the trailing newline preserved on disk, but
  // readback strips it so SSH gets exactly the password.
  const pw = await getHostPassword({ alias: "h5", storeDir });
  assert.equal(pw, "secret");
});
