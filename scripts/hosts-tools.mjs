#!/usr/bin/env node
// Host alias / password management CLI.
//
// Subcommands:
//   hosts list                       — list aliases that have stored passwords
//   hosts has-password   --alias <name>
//   hosts set-password   --alias <name> [--password <str>] [--from-stdin]
//   hosts remove-password --alias <name> --execute --yes
//   hosts allow         --alias <name>     # append to allowed-hosts.txt
//
// Passwords land in $HOME/.taac2026/host-passwords/<alias> — outside the
// repo, not in taiji-output, never copied to GPU. The .gitignore
// machinery isn't needed because the file is in $HOME, not under the
// project root.
//
// `set-password` accepts either an interactive hidden prompt or
// `--password <str>` for AI / automation use. `--from-stdin` reads one
// line from stdin (useful when piping from a CI secret store).

import { read } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { appendAllowedHost, isValidAlias, readAllowedHosts } from "./_allowed-hosts.mjs";
import {
  STORE_DIR_DEFAULT,
  hasHostPassword,
  listHostPasswords,
  removeHostPassword,
  setHostPassword,
} from "./_host-password.mjs";

function usage() {
  return `Usage:
  taac2026 hosts list
  taac2026 hosts has-password   --alias <name>
  taac2026 hosts set-password   --alias <name> [--password <str>] [--from-stdin]
  taac2026 hosts remove-password --alias <name> --execute --yes
  taac2026 hosts allow          --alias <name>

Passwords are stored under $HOME/.taac2026/host-passwords/<alias> (outside
the repo, never copied to the remote). For autonomous-loop scenarios,
prefer --password or --from-stdin so no interactive TTY is required.
`;
}

function parseArgs(argv) {
  const args = { command: argv[0], execute: false, yes: false };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--execute") args.execute = true;
    else if (arg === "--yes") args.yes = true;
    else if (arg === "--from-stdin") args.fromStdin = true;
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

async function readStdinLine() {
  return await new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end", () => resolve(buf.replace(/\r?\n$/, "")));
    process.stdin.on("error", reject);
  });
}

async function promptHidden(prompt) {
  // Minimal hidden-input prompt: write prompt, set raw stdin, accumulate
  // until Enter. No echo — even '*' chars are skipped to avoid leaking
  // password length into screen recordings.
  if (!process.stdin.isTTY) {
    throw new Error("hidden prompt requires a TTY; use --password or --from-stdin instead");
  }
  process.stdout.write(prompt);
  return await new Promise((resolve, reject) => {
    const onData = (key) => {
      const ch = key.toString("utf8");
      if (ch === "\r" || ch === "\n" || ch === "\x04") {
        process.stdin.setRawMode(false);
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(buf);
      } else if (ch === "") { // Ctrl-C
        process.stdin.setRawMode(false);
        process.stdin.removeListener("data", onData);
        reject(new Error("aborted"));
      } else if (ch === "\x7f" || ch === "\b") { // backspace
        if (buf.length > 0) buf = buf.slice(0, -1);
      } else {
        buf += ch;
      }
    };
    let buf = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command || args.command === "--help") {
    console.log(usage());
    return;
  }

  if (args.command === "list") {
    const list = await listHostPasswords();
    const allowed = await readAllowedHosts();
    console.log(JSON.stringify({
      store_dir: STORE_DIR_DEFAULT,
      allowlist_aliases: allowed,
      with_password: list,
    }, null, 2));
    return;
  }

  if (args.command === "has-password") {
    if (!isValidAlias(args.alias)) throw new Error("Missing or invalid --alias");
    const present = await hasHostPassword({ alias: args.alias });
    console.log(JSON.stringify({ alias: args.alias, has_password: present }, null, 2));
    process.exitCode = present ? 0 : 1;
    return;
  }

  if (args.command === "set-password") {
    if (!isValidAlias(args.alias)) throw new Error("Missing or invalid --alias");
    let password = args.password;
    if (!password && args.fromStdin) password = await readStdinLine();
    if (!password) password = await promptHidden(`Password for ${args.alias}: `);
    if (!password) throw new Error("set-password: empty password");
    const result = await setHostPassword({ alias: args.alias, password });
    console.log(JSON.stringify({ alias: args.alias, stored: true, path: result.path }, null, 2));
    return;
  }

  if (args.command === "remove-password") {
    if (!isValidAlias(args.alias)) throw new Error("Missing or invalid --alias");
    if (!args.execute) {
      console.log(JSON.stringify({ alias: args.alias, mode: "dry-run" }, null, 2));
      return;
    }
    if (!args.yes) throw new Error("--execute requires --yes");
    const result = await removeHostPassword({ alias: args.alias });
    console.log(JSON.stringify({ alias: args.alias, ...result }, null, 2));
    return;
  }

  if (args.command === "allow") {
    if (!isValidAlias(args.alias)) throw new Error("Missing or invalid --alias");
    const result = await appendAllowedHost(args.alias);
    console.log(JSON.stringify({ alias: args.alias, ...result }, null, 2));
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
