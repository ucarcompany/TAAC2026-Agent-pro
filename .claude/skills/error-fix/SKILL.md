---
name: error-fix
description: 把 error-doctor 产出的 patch.diff / config_overrides 通过 CLI 落到 KB（HMAC 签名）和下一轮 loop 配置。当用户说"应用修复""apply patch""落 patch""ack 修复"或斜杠 /errors:fix 时使用。Claude 不能自动跑——必须真人 ack。
allowed-tools: Read, Glob, Grep, Bash(taac2026 errors apply-patch *), Bash(taac2026 errors verify *)
disable-model-invocation: true
argument-hint: [event-id]
---

# error-fix — 应用修复 + KB upsert

> **为什么 `disable-model-invocation: true`？** apply-patch 会修改 KB（HMAC 签名）并把 `config_overrides` 合入下一轮训练配置。Claude 不能自作主张落 patch——必须真人 `/errors:fix <event-id>` 触发。

## 工作流

### 1) 复核

确认 `taiji-output/errors/reports/<event-id>/` 下有：
- `error-report.md` — 你看过 5 Whys / 证据链（`raw/<event-id>/...:L<n>` 引用）
- `error-report.json` — `verdict: PASS-with-fix`，`fix.kind` 与 `summary` 合理
- `patch.diff` — 仅当 `fix.kind: code` 时才需要；最小变更，未引入新依赖

如果 verdict 是 `insufficient-evidence` → **不要 apply**，回去补日志或重新 ingest。

### 2) Apply

依据 `fix.kind` 选命令：

**config 改动**（最常见，KISS 优先）：
```bash
taac2026 errors apply-patch \
  --event-id <event-id> \
  --config-overrides '{"train.amp": true, "train.batch_size": 3072}' \
  --execute --yes
```

**code 改动**（patch.diff）：
```bash
# 1. 先人工 review patch.diff（用 git diff / VSCode 都行）
cat taiji-output/errors/reports/<event-id>/patch.diff

# 2. 主会话用 Edit/Write 工具落 patch（不要让 CLI git apply）

# 3. CLI 记录到 KB
taac2026 errors apply-patch --event-id <event-id> --execute --yes
```

**retry-only**（瞬态故障，无需改任何东西）：
```bash
taac2026 errors apply-patch --event-id <event-id> --retry-only --execute --yes
```

CLI 会：
- upsert `taiji-output/errors/kb/<sig-suffix>.json`（HMAC 签名，防篡改）
- append `events.ndjson` 一条 `errors.patch.applied`
- 累计 `occurrences`

### 3) Verify（patch 在后续成功 iter 之后）

应用 patch 后，重新跑训练。如果下一轮 `loop run` 跑通了：

```bash
taac2026 errors verify \
  --event-id <event-id> \
  --val-auc-delta -0.0006 \
  --latency-p95-delta-ms 1.2 \
  --passed-iter-id iter-2026-05-08-04 \
  --execute --yes
```

CLI 会更新 KB 的 `verification` 字段（重新签 HMAC），表示这个 fix 在真实 iter 上验证过、副作用可量化。

## 强约束

- **从 KB 命中的 patch 必须人工二次确认**——即使是历史已验证的 fix，新场景可能不适用（设计稿 §15.2 的"避免历史 patch 被新场景误用"）。
- **副作用提醒**：如果 `error-report.json.retry_plan.requires_rebuild=true` 或 `expected_iter_delta>0`，主会话需要在调用前**显式提示**用户重启 loop。
- **不要绕过 `--execute --yes`**——确保用户看到完整 fix 摘要后再确认。
- **HMAC 篡改时拒用**：如果 `apply-patch --from-kb` 触发 KB tamper 错误，**不要**重新签发；那是入侵痕迹，必须人工排查。
- **不要让 Claude 自动 `/errors:fix`**——`disable-model-invocation: true` 已写死。
