#!/usr/bin/env node
// SSH_ASKPASS helper. ssh / scp / rsync invoke this when they need a
// password and the controlling terminal is unavailable (or
// SSH_ASKPASS_REQUIRE=force is set).
//
// Reads the alias from $TAAC2026_HOST_ALIAS, looks up
// $HOME/.taac2026/host-passwords/<alias>, prints the password to stdout
// (no trailing newline). On any error, exits non-zero with no output —
// ssh will then prompt the user (or fail if BatchMode is set).
//
// SECURITY NOTE: this script intentionally does not log the alias name,
// the prompt argument, or any password material to stderr. Stderr stays
// empty so it never ends up in CI logs / audit trails / shell history.

import { getHostPassword } from "./_host-password.mjs";

async function main() {
  const alias = process.env.TAAC2026_HOST_ALIAS;
  if (!alias) process.exit(1);

  const password = await getHostPassword({ alias });
  if (!password) process.exit(2);

  process.stdout.write(password);
  process.exit(0);
}

main().catch(() => process.exit(3));
