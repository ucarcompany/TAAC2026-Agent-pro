import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { appendAllowedHost, isHostAllowed, isValidAlias, readAllowedHosts } from "../_allowed-hosts.mjs";
import { RemoteRunner } from "../_remote-runner.mjs";

class FakeChild extends EventEmitter {
  constructor({ exitCode = 0, stdout = "", stderr = "" } = {}) {
    super();
    this.stdin = { write() {}, end() {} };
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this._exitCode = exitCode;
    this._stdout = stdout;
    this._stderr = stderr;
  }
  start() {
    setImmediate(() => {
      if (this._stdout) this.stdout.emit("data", Buffer.from(this._stdout));
      if (this._stderr) this.stderr.emit("data", Buffer.from(this._stderr));
      this.emit("close", this._exitCode);
    });
  }
  kill() { this.killed = true; this.emit("close", -1); }
}

function makeFakeSpawn(handler) {
  // Each call to spawnFn returns a child immediately; handler decides
  // exitCode / stdout based on (command, args).
  return (command, args) => {
    const { exitCode = 0, stdout = "", stderr = "" } = handler({ command, args }) ?? {};
    const child = new FakeChild({ exitCode, stdout, stderr });
    child.start();
    return child;
  };
}

async function makeAllowlist({ aliases = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "taac2026-allowed-hosts-"));
  const allowlistPath = path.join(root, "allowed-hosts.txt");
  for (const alias of aliases) await appendAllowedHost(alias, allowlistPath);
  return { root, allowlistPath };
}

test("isValidAlias accepts simple aliases and rejects user@host shapes", () => {
  assert.equal(isValidAlias("taac2026-gpu"), true);
  assert.equal(isValidAlias("gpu_01.lan"), true);
  assert.equal(isValidAlias("root@host"), false);
  assert.equal(isValidAlias("117.50.48.78"), true);  // valid form, but allowlist gates the literal-IP shape
  assert.equal(isValidAlias(""), false);
  assert.equal(isValidAlias("with space"), false);
  assert.equal(isValidAlias("$(whoami)"), false);
});

test("appendAllowedHost is idempotent and renders a deterministic file", async () => {
  const { allowlistPath } = await makeAllowlist();
  const a = await appendAllowedHost("alpha", allowlistPath);
  assert.equal(a.added, true);
  const b = await appendAllowedHost("alpha", allowlistPath);
  assert.equal(b.added, false);
  await appendAllowedHost("beta", allowlistPath);
  const list = await readAllowedHosts(allowlistPath);
  assert.deepEqual(list, ["alpha", "beta"]);
});

test("appendAllowedHost rejects invalid aliases", async () => {
  const { allowlistPath } = await makeAllowlist();
  await assert.rejects(appendAllowedHost("root@1.2.3.4", allowlistPath), /Invalid alias/);
});

test("isHostAllowed returns false for unlisted aliases", async () => {
  const { allowlistPath } = await makeAllowlist({ aliases: ["alpha"] });
  assert.equal(await isHostAllowed("alpha", allowlistPath), true);
  assert.equal(await isHostAllowed("beta", allowlistPath), false);
});

test("RemoteRunner constructor refuses an alias with '@'", () => {
  assert.throws(() => new RemoteRunner({ alias: "root@1.2.3.4" }), /invalid alias/);
});

test("RemoteRunner.exec emits a canonical ssh argv (BatchMode + ControlMaster)", async () => {
  const { allowlistPath } = await makeAllowlist({ aliases: ["taac2026-gpu"] });
  const captured = [];
  const spawnFn = makeFakeSpawn(({ command, args }) => {
    captured.push({ command, args });
    return { exitCode: 0, stdout: "ok\n" };
  });
  const runner = new RemoteRunner({
    alias: "taac2026-gpu",
    controlPath: "/tmp/cm-%C",
    spawnFn,
    allowlistPath,
  });
  const result = await runner.exec("echo hello");
  assert.equal(result.code, 0);
  assert.equal(captured[0].command, "ssh");
  assert.ok(captured[0].args.includes("-o"));
  assert.ok(captured[0].args.includes("BatchMode=yes"));
  assert.ok(captured[0].args.includes("ControlMaster=auto"));
  // Alias must appear, but never user@host.
  assert.ok(captured[0].args.includes("taac2026-gpu"));
  assert.ok(!captured[0].args.some((a) => a.includes("@")));
});

test("RemoteRunner.exec refuses to run when alias is not in allowlist", async () => {
  const { allowlistPath } = await makeAllowlist({ aliases: ["other-host"] });
  const spawnFn = makeFakeSpawn(() => ({ exitCode: 0 }));
  const runner = new RemoteRunner({ alias: "taac2026-gpu", spawnFn, allowlistPath });
  await assert.rejects(runner.exec("ls"), /not in/);
});

test("RemoteRunner.copyTo / copyFrom build alias:remote scp args", async () => {
  const { allowlistPath } = await makeAllowlist({ aliases: ["taac2026-gpu"] });
  const captured = [];
  const spawnFn = makeFakeSpawn(({ command, args }) => {
    captured.push({ command, args });
    return { exitCode: 0 };
  });
  const runner = new RemoteRunner({ alias: "taac2026-gpu", spawnFn, allowlistPath });
  await runner.copyTo("/tmp/local.txt", "~/remote.txt");
  await runner.copyFrom("~/remote/metrics.json", "/tmp/metrics.json");
  assert.equal(captured.length, 2);
  assert.equal(captured[0].command, "scp");
  assert.deepEqual(captured[0].args.slice(-2), ["/tmp/local.txt", "taac2026-gpu:~/remote.txt"]);
  assert.deepEqual(captured[1].args.slice(-2), ["taac2026-gpu:~/remote/metrics.json", "/tmp/metrics.json"]);
});

test("RemoteRunner.touchKill / clearKill compose the expected remote shell", async () => {
  const { allowlistPath } = await makeAllowlist({ aliases: ["taac2026-gpu"] });
  const captured = [];
  const spawnFn = makeFakeSpawn(({ command, args }) => {
    captured.push({ command, args });
    return { exitCode: 0 };
  });
  const runner = new RemoteRunner({ alias: "taac2026-gpu", spawnFn, allowlistPath });
  await runner.touchKill("plan-1");
  const argv = captured[0].args.join(" ");
  assert.match(argv, /mkdir -p ~\/taac-runs\/plan-1/);
  assert.match(argv, /~\/taac-runs\/plan-1\/KILL/);

  captured.length = 0;
  await runner.clearKill("plan-1");
  assert.match(captured[0].args.join(" "), /rm -f ~\/taac-runs\/plan-1\/KILL/);
});

test("RemoteRunner surfaces non-zero exit codes as errors", async () => {
  const { allowlistPath } = await makeAllowlist({ aliases: ["taac2026-gpu"] });
  const spawnFn = makeFakeSpawn(() => ({ exitCode: 7, stderr: "permission denied" }));
  const runner = new RemoteRunner({ alias: "taac2026-gpu", spawnFn, allowlistPath });
  await assert.rejects(runner.exec("oops"), /exited with code 7.*permission denied/);
});

test("RemoteRunner times out long-running commands and kills the child", async () => {
  const { allowlistPath } = await makeAllowlist({ aliases: ["taac2026-gpu"] });
  // Spawn a child that NEVER emits 'close' on its own.
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdin = { write() {}, end() {} };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { /* swallow — main test will assert on rejection */ };
    return child;
  };
  const runner = new RemoteRunner({ alias: "taac2026-gpu", spawnFn, allowlistPath, timeoutMs: 30 });
  await assert.rejects(runner.exec("forever"), /timed out/);
});
