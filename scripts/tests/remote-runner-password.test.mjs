import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { appendAllowedHost } from "../_allowed-hosts.mjs";
import { RemoteRunner, buildAskpassEnv } from "../_remote-runner.mjs";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = { write() {}, end() {} };
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }
  start() { setImmediate(() => this.emit("close", 0)); }
}

function makeFakeSpawn(handler) {
  return (command, args, options = {}) => {
    handler({ command, args, options });
    const child = new FakeChild();
    child.start();
    return child;
  };
}

async function makeAllowlist({ aliases = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-pw-runner-"));
  const allowlistPath = path.join(root, "allowed-hosts.txt");
  for (const alias of aliases) await appendAllowedHost(alias, allowlistPath);
  return { root, allowlistPath };
}

test("buildAskpassEnv returns null when useStoredPassword is false", () => {
  const env = buildAskpassEnv({ alias: "x", useStoredPassword: false, baseEnv: { HOME: "/h" } });
  assert.equal(env, null);
});

test("buildAskpassEnv injects SSH_ASKPASS, SSH_ASKPASS_REQUIRE, DISPLAY, alias", () => {
  const env = buildAskpassEnv({ alias: "taac2026-gpu", useStoredPassword: true, baseEnv: { HOME: "/h" } });
  assert.match(env.SSH_ASKPASS, /_askpass\.(cmd|sh)$/);
  assert.equal(env.SSH_ASKPASS_REQUIRE, "force");
  assert.equal(env.DISPLAY, ":0");
  assert.equal(env.TAAC2026_HOST_ALIAS, "taac2026-gpu");
  assert.equal(env.HOME, "/h");
});

test("buildAskpassEnv preserves an existing DISPLAY value if present", () => {
  const env = buildAskpassEnv({ alias: "x", useStoredPassword: true, baseEnv: { HOME: "/h", DISPLAY: ":99" } });
  assert.equal(env.DISPLAY, ":99");
});

test("RemoteRunner without useStoredPassword keeps BatchMode=yes in argv", async () => {
  const { allowlistPath } = await makeAllowlist({ aliases: ["taac2026-gpu"] });
  let captured;
  const spawnFn = makeFakeSpawn((info) => { captured = info; });
  const runner = new RemoteRunner({ alias: "taac2026-gpu", spawnFn, allowlistPath });
  await runner.exec("echo hi");
  assert.ok(captured.args.includes("BatchMode=yes"), `argv must include BatchMode=yes; got ${JSON.stringify(captured.args)}`);
  // No askpass env when key auth is used (RemoteRunner passes null so the
  // child inherits the ambient env unchanged).
  assert.equal(captured.options.env, null);
});

test("RemoteRunner with useStoredPassword=true drops BatchMode and sets askpass env", async () => {
  const { allowlistPath } = await makeAllowlist({ aliases: ["taac2026-gpu"] });
  let captured;
  const spawnFn = makeFakeSpawn((info) => { captured = info; });
  const runner = new RemoteRunner({
    alias: "taac2026-gpu",
    spawnFn,
    allowlistPath,
    useStoredPassword: true,
    baseEnv: { HOME: "/h" },
  });
  await runner.exec("echo hi");
  assert.ok(!captured.args.includes("BatchMode=yes"), "BatchMode=yes must NOT appear when password auth");
  assert.match(captured.options.env.SSH_ASKPASS, /_askpass\.(cmd|sh)$/);
  assert.equal(captured.options.env.SSH_ASKPASS_REQUIRE, "force");
  assert.equal(captured.options.env.TAAC2026_HOST_ALIAS, "taac2026-gpu");
});

test("scp argv mirrors the same BatchMode-vs-askpass split", async () => {
  const { allowlistPath } = await makeAllowlist({ aliases: ["taac2026-gpu"] });
  let captured;
  const spawnFn = makeFakeSpawn((info) => { captured = info; });
  const runner = new RemoteRunner({ alias: "taac2026-gpu", spawnFn, allowlistPath, useStoredPassword: true });
  await runner.copyTo("/local/file", "~/remote/file");
  assert.equal(captured.command, "scp");
  assert.ok(!captured.args.includes("BatchMode=yes"));
  assert.match(captured.options.env.SSH_ASKPASS, /_askpass\.(cmd|sh)$/);
});

test("StrictHostKeyChecking=accept-new is set in both modes (M5.5)", async () => {
  const { allowlistPath } = await makeAllowlist({ aliases: ["x"] });
  for (const useStoredPassword of [false, true]) {
    let captured;
    const spawnFn = makeFakeSpawn((info) => { captured = info; });
    const runner = new RemoteRunner({ alias: "x", spawnFn, allowlistPath, useStoredPassword });
    await runner.exec("ls");
    assert.ok(captured.args.includes("StrictHostKeyChecking=accept-new"),
      `mode useStoredPassword=${useStoredPassword} must include accept-new`);
  }
});
