# Changelog

All notable changes to this fork are documented here. The original
[ZhongKuang/TAAC2026-CLI](https://github.com/ZhongKuang/TAAC2026-CLI)
history is preserved as-is and is **not** re-listed below.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased] — M1 (2026-05-08)

### Added

- `taac2026 data ingest --source <hf|local> --dataset-id <id>` — produces
  `taiji-output/data/<id>/manifest.json` with per-file SHA256 and a
  license-allowlist gate (`cc-by-nc-4.0` / `mit` / `apache-2.0` / `bsd-3-clause`).
  Default is dry-run; live mode requires `--execute --yes`. Writes are sandboxed
  via `_taiji-http.mjs::joinSafeRelative` so dataset-id segments cannot escape.
- `taac2026 data profile --dataset-id <id>` — first run writes
  `taiji-output/profiling/<id>/schema.lock.json` (column order + type + cardinality
  hash); subsequent runs raise `SCHEMA_DRIFT` (exit 2) on any column add/remove/type
  change. Computes both Pearson and Spearman correlations vs the label column and
  raises `LEAKAGE_RED_FLAG` (exit 2) when |r| > 0.95.
- `.claude/skills/data-ingest/SKILL.md`, `.claude/skills/data-profile/SKILL.md`,
  `.claude/agents/data-auditor.md` — Skill / Subagent surfaces for the data
  governance workflow (audited subagent runs in `isolation: worktree` with
  WebFetch disallowed).
- Tests: `data-ingest.test.mjs`, `data-profile.test.mjs`.

---

## [Unreleased] — M0 (2026-05-08)

### Security (P0 fixes from `taiji-output/reports/code-audit-2026-05-07.md`)

- **§2.1 — cookie cross-origin leakage**: introduced `scripts/_taiji-http.mjs`
  which exposes `assertCookieHostAllowed` (host ∈ `taiji.algo.qq.com`) and
  `assertArtifactHostAllowed` (host ∈ Taiji + `*.cos.ap-guangzhou.myqcloud.com` +
  `*.myqcloud.com`). `scrape-taiji.mjs::fetchBinaryDirect` /
  `evaluation-tools.mjs::fetchBinaryDirect` now strip the cookie before any
  cross-origin artifact fetch. Playwright path also calls
  `assertArtifactHostAllowed`.
- **§2.2 — path traversal in `safeRelativeFilePath`**: `safeRelativeFilePath`
  now refuses any `.` / `..` / NUL segment, and `saveJobCodeFiles` validates the
  final absolute path through `joinSafeRelative` before the write.
- **§2.3 — `submit --execute` silent fallback**: combining `--execute --yes`
  without `--cookie-file` used to print a no-network "dry-run plan" and exit 0.
  Now throws `--execute requires --cookie-file`.

### Reliability (key P1 fixes)

- **§3.1 — fetch timeout + retries**: `fetchWithRetry` wraps every request with
  `AbortSignal.timeout(60_000)` and bounded exponential backoff (3 attempts) on
  HTTP 408 / 429 / 5xx.
- **§3.3 — `jobs.json` non-atomic write**: `scrapeAllTrainingJobs` now persists
  every 5 jobs via `atomicWriteJson` (tmp + rename); a Ctrl-C mid-run no longer
  truncates the prior good cache.
- **§3.4 — federation token reuse**: both `submit-taiji.mjs` and
  `evaluation-tools.mjs` now memoize the COS client per cookie header, so a
  multi-file submit/evaluation issues exactly one `get_federation_token/` call.
- **§3.5 — `fetchInstanceOutput` partial failures**: switched from
  `Promise.all` to `Promise.allSettled`; partial errors are reported via a new
  `partialErrors` field rather than swallowing successful metrics.
- **§3.7 — business `error.code` validation**: `_taiji-http.mjs::fetchTaijiJson`
  now rejects HTTP-200 responses whose `body.error.code` is anything other than
  `SUCCESS` / `0`. Previously submit / eval would accept quota-exceeded
  responses as success.
- **§3.8 — CSV column union**: `scrape-taiji.mjs::toCsv` now uses the union of
  keys across all rows (instance-specific metrics that only appeared in later
  rows used to be silently dropped).

### Added

- `taac2026 readiness check` (`scripts/readiness.mjs`) — writes
  `taiji-output/state/readiness.json`; status is `blocked` / `warning` / `ready`.
  CLI hard-gate refuses `submit/loop --execute` when status ≠ `ready`.
- `taac2026 secrets check` and `taac2026 secrets init-hmac --execute --yes`
  (`scripts/secrets-tools.mjs`) — generates a 32-byte hex HMAC key for the
  future review-gate token, with `chmod 0o600` on POSIX (best-effort on Windows).
- `scripts/_events.mjs::appendEvent` — append-only NDJSON event ledger
  (`taiji-output/state/events.ndjson`).
- `.claude/settings.json` — permissions deny list + PreToolUse hooks.
- `.claude/hooks/guard-bash.sh` — refuses `submit --execute` without a review
  token, blocks reads of `secrets/*`, blocks `rm -rf` against the workspace.
- `.claude/hooks/guard-webfetch.sh` — host allowlist for WebFetch
  (arxiv.org / api.github.com / raw.githubusercontent.com / serpapi.com /
  huggingface.co / taiji.algo.qq.com / *.cos.ap-guangzhou.myqcloud.com).
- `.claude/hooks/check-readiness.sh` — SubagentStart hook that fails if
  `readiness.json` is missing or status ≠ `ready`.
- Tests: `cookie-isolation.test.mjs`, `path-traversal.test.mjs`,
  `submit-execute-fallback.test.mjs`, `readiness.test.mjs`,
  `events-append.test.mjs`, `secrets.test.mjs`, `http-retry.test.mjs`.

### Changed

- `.gitignore` — keeps `taiji-output/` ignored by default but un-ignores
  `taiji-output/reports/**` so audit / design artefacts can be tracked.
- `bin/taac2026.mjs` — added `readiness`, `secrets`, `data` commands.

### Compatibility

- Pre-existing test `direct text download rejects non-2xx responses` was
  updated to assert the new "non-allowlisted host" error (the test relied on a
  127.0.0.1 fake server, which the cookie-isolation fix correctly refuses).
  Non-2xx surfacing is now covered by `http-retry.test.mjs` against an
  allowlisted host.
