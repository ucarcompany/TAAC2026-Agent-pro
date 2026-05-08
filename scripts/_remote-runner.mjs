// SSH / SCP / RSYNC wrapper for auto-loop's real-remote runner.
//
// Two design constraints (CLAUDE.md sec, r9 — 三级等保 / SSH 节流):
//   1) Connection details NEVER appear in argv. We refuse anything but a
//      bare ~/.ssh/config alias and trust the user's ssh config to map
//      it to (HostName, Port, User, IdentityFile, ControlMaster).
//   2) Aliases must be in taiji-output/state/allowed-hosts.txt — checked
//      both here AND in the PreToolUse hook (defense in depth).
//
// All process spawning goes through the injectable `spawnFn` so unit
// tests can verify command shapes without launching real ssh.

import { spawn as defaultSpawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertHostAllowed, isValidAlias } from "./_allowed-hosts.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;

const SCRIPTS_DIR = fileURLToPath(new URL(".", import.meta.url));
const ASKPASS_PATH = process.platform === "win32"
  ? path.join(SCRIPTS_DIR, "_askpass.cmd")
  : path.join(SCRIPTS_DIR, "_askpass.sh");

function runProcess(spawnFn, command, args, { timeoutMs = DEFAULT_TIMEOUT_MS, input, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    let timer = null;
    let done = false;

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error(`remote-runner: ${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.stdout?.on?.("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on?.("data", (chunk) => { stderr += chunk.toString(); });
    child.on?.("error", (error) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on?.("close", (code) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(Object.assign(new Error(`remote-runner: ${command} exited with code ${code}: ${stderr.slice(0, 300)}`), { code, stdout, stderr }));
    });

    if (input != null) {
      child.stdin?.write?.(input);
      child.stdin?.end?.();
    }
  });
}

// Build the canonical ssh argv for an alias. By default we pass -o
// BatchMode=yes (no password prompt — fail fast if keys aren't set up)
// and -o ControlMaster=auto -o ControlPersist=10m so multiple commands
// in one loop run share a single TCP connection (CLAUDE.md r9).
//
// When `useStoredPassword` is on we drop BatchMode (incompatible with
// SSH_ASKPASS) and rely on the askpass helper + SSH_ASKPASS_REQUIRE=force
// to fetch the password from $HOME/.taac2026/host-passwords/<alias>
// without prompting the user.
function sshBaseArgs(alias, controlPath, { useStoredPassword = false } = {}) {
  const args = [];
  if (!useStoredPassword) args.push("-o", "BatchMode=yes");
  args.push(
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "StrictHostKeyChecking=accept-new",
  );
  if (controlPath) {
    args.push(
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${controlPath}`,
      "-o", "ControlPersist=10m",
    );
  }
  args.push(alias);
  return args;
}

function scpBaseArgs(controlPath, { useStoredPassword = false } = {}) {
  const args = [];
  if (!useStoredPassword) args.push("-o", "BatchMode=yes");
  args.push("-o", "StrictHostKeyChecking=accept-new");
  if (controlPath) {
    args.push(
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${controlPath}`,
      "-o", "ControlPersist=10m",
    );
  }
  return args;
}

// Build the env vars that drive SSH_ASKPASS-based password retrieval.
// When useStoredPassword is false we return null so the spawn inherits
// the ambient environment.
export function buildAskpassEnv({ alias, useStoredPassword, baseEnv = process.env }) {
  if (!useStoredPassword) return null;
  return {
    ...baseEnv,
    SSH_ASKPASS: ASKPASS_PATH,
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: baseEnv.DISPLAY ?? ":0",
    TAAC2026_HOST_ALIAS: alias,
  };
}

export class RemoteRunner {
  constructor({
    alias,
    controlPath,
    spawnFn = defaultSpawn,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    allowlistPath,
    useStoredPassword = false,
    baseEnv = process.env,
  } = {}) {
    if (!isValidAlias(alias)) {
      throw new Error(`RemoteRunner: invalid alias '${alias}'. Must match /^[A-Za-z0-9_.\-]+$/ and contain no '@'.`);
    }
    this.alias = alias;
    this.controlPath = controlPath ?? null;
    this.spawnFn = spawnFn;
    this.timeoutMs = timeoutMs;
    this.allowlistPath = allowlistPath;
    this.useStoredPassword = Boolean(useStoredPassword);
    this.baseEnv = baseEnv;
    this._verified = false;
  }

  _spawnEnv() {
    return buildAskpassEnv({ alias: this.alias, useStoredPassword: this.useStoredPassword, baseEnv: this.baseEnv });
  }

  async _ensureAllowed() {
    if (this._verified) return;
    await assertHostAllowed(this.alias, this.allowlistPath);
    this._verified = true;
  }

  // Run `bash -lc <command>` on the remote host. The command string is
  // single-quoted; embedded single quotes are escaped via the standard
  // '"'"' trick. Caller should still avoid passing untrusted text.
  async exec(remoteCommand, { timeoutMs } = {}) {
    await this._ensureAllowed();
    const args = sshBaseArgs(this.alias, this.controlPath, { useStoredPassword: this.useStoredPassword });
    const escaped = `'${String(remoteCommand).replaceAll("'", "'\"'\"'")}'`;
    args.push("--", "bash", "-lc", escaped);
    return await runProcess(this.spawnFn, "ssh", args, { timeoutMs: timeoutMs ?? this.timeoutMs, env: this._spawnEnv() });
  }

  // Push a local file to <alias>:<remotePath>. Uses scp; for directories
  // call copyTreeTo instead.
  async copyTo(localPath, remotePath, { timeoutMs } = {}) {
    await this._ensureAllowed();
    const args = scpBaseArgs(this.controlPath, { useStoredPassword: this.useStoredPassword });
    args.push(localPath, `${this.alias}:${remotePath}`);
    return await runProcess(this.spawnFn, "scp", args, { timeoutMs: timeoutMs ?? this.timeoutMs, env: this._spawnEnv() });
  }

  async copyFrom(remotePath, localPath, { timeoutMs } = {}) {
    await this._ensureAllowed();
    const args = scpBaseArgs(this.controlPath, { useStoredPassword: this.useStoredPassword });
    args.push(`${this.alias}:${remotePath}`, localPath);
    return await runProcess(this.spawnFn, "scp", args, { timeoutMs: timeoutMs ?? this.timeoutMs, env: this._spawnEnv() });
  }

  async copyTreeTo(localDir, remoteDir, { timeoutMs } = {}) {
    await this._ensureAllowed();
    const args = scpBaseArgs(this.controlPath, { useStoredPassword: this.useStoredPassword });
    args.push("-r", localDir, `${this.alias}:${remoteDir}`);
    return await runProcess(this.spawnFn, "scp", args, { timeoutMs: timeoutMs ?? this.timeoutMs, env: this._spawnEnv() });
  }

  async syncFrom(remoteDir, localDir, { timeoutMs } = {}) {
    await this._ensureAllowed();
    await mkdir(localDir, { recursive: true });
    const sshOptParts = [];
    if (!this.useStoredPassword) sshOptParts.push("-o BatchMode=yes");
    sshOptParts.push("-o StrictHostKeyChecking=accept-new");
    if (this.controlPath) sshOptParts.push(`-o ControlPath=${this.controlPath}`);
    const args = [
      "-az",
      "--delete",
      "-e",
      `ssh ${sshOptParts.join(" ")}`,
      `${this.alias}:${remoteDir.replace(/\/?$/, "/")}`,
      localDir.replace(/\/?$/, "/"),
    ];
    return await runProcess(this.spawnFn, "rsync", args, { timeoutMs: timeoutMs ?? this.timeoutMs, env: this._spawnEnv() });
  }

  // Verify the persistent control connection is alive without sending any
  // command. Returns true if the master is up. Wraps `ssh -O check`.
  async checkControlMaster() {
    await this._ensureAllowed();
    const args = sshBaseArgs(this.alias, this.controlPath, { useStoredPassword: this.useStoredPassword });
    args.splice(args.indexOf(this.alias), 0, "-O", "check");
    try {
      await runProcess(this.spawnFn, "ssh", args, { timeoutMs: 5_000, env: this._spawnEnv() });
      return true;
    } catch {
      return false;
    }
  }

  // Convenience helpers for the runner contract.
  remoteRunDir(planId) {
    return `~/taac-runs/${planId}`;
  }
  remoteIterDir(planId, iterId) {
    return `${this.remoteRunDir(planId)}/iters/${iterId}`;
  }
  remoteKillPath(planId) {
    return `${this.remoteRunDir(planId)}/KILL`;
  }
  remoteLockPath(planId) {
    return `${this.remoteRunDir(planId)}/gpu.lock`;
  }

  async touchKill(planId) {
    return await this.exec(`mkdir -p ${this.remoteRunDir(planId)} && : > ${this.remoteKillPath(planId)}`);
  }
  async clearKill(planId) {
    return await this.exec(`rm -f ${this.remoteKillPath(planId)}`);
  }
  async readStatus(planId, iterId, localPath) {
    return await this.copyFrom(`${this.remoteIterDir(planId, iterId)}/status.json`, localPath);
  }
}

export function buildRemoteRunner(options) {
  return new RemoteRunner(options);
}

export { sshBaseArgs, scpBaseArgs };
