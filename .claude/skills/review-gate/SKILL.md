---
name: review-gate
description: 签发 / 验证 train_token 与 submit_token（HMAC-SHA256，TTL 24h / 2h，submit 需双人审批）。当用户说"申请训练 token""签发提交 token""审批通过""approve""issue token"或斜杠 /review:gate 时使用。
allowed-tools: Read, Glob, Bash(taac2026 review *), Bash(taac2026 propose status *)
disable-model-invocation: true
argument-hint: [kind] [plan-id]
---

# review-gate — HMAC token 签发与验证

> **为什么 `disable-model-invocation: true`？** Token 是控制 SSH 远端训练 / 真实官方提交的最后一道闸。Claude **绝不能自己签发 token**——任何 `/review:gate` 调用都必须由真人键入。

## 强约束（不可绕过）

- HMAC 密钥固定路径：`taiji-output/secrets/review.hmac.key`（32 字节 hex，POSIX 上必须 `chmod 600`）。
- `submit_token` 必须有双人审批：除了 `--approver <name>`，还要在 shell 环境里 `export TAAC2026_SECOND_APPROVER=<name2>`，否则 CLI 直接报错。
- Token 落到 `taiji-output/state/.review-token-{train,submit}`；`bin/taac2026.mjs` 启动 `submit/loop --execute` 前会调用 `review.verify` 做硬闸（HMAC + TTL + kind/plan_id 全部匹配才放行）。
- HMAC 密钥**绝不**进入 Claude 上下文：`.claude/settings.json` 已 deny `cat *secrets/review.hmac.key*`，且 guard-bash.sh 双重拦截。Claude 只能调用 CLI，CLI 在子进程里读 key。

## 工作流

### 1) train_token（启动训练用）

前置：proposal 已 freeze，状态机在 `reviewed_by_compliance`：

```bash
taac2026 propose status --plan-id plan-2026-05-08-001
# 期望: state=reviewed_by_compliance
```

签发：

```bash
taac2026 review issue \
  --kind train \
  --plan-id plan-2026-05-08-001 \
  --approver alice \
  --ttl-hours 24 \
  --execute --yes
```

输出：`taiji-output/state/.review-token-train`，TTL 24h，`allow_ssh: true`，`allow_official_submit: false`。

### 2) submit_token（真实提交官方）

**前提：必须有第二位人类审批人**。

```bash
export TAAC2026_SECOND_APPROVER=bob
taac2026 review issue \
  --kind submit \
  --plan-id plan-2026-05-08-001 \
  --approver alice \
  --ttl-hours 2 \
  --execute --yes
```

输出：`taiji-output/state/.review-token-submit`，TTL 2h（短 TTL 是设计稿 §10 的关键风险缓解），`allow_ssh: false`，`allow_official_submit: true`，`approver` 字段记录两人。

### 3) 验证（CLI 自动调，但你也可以手测）

```bash
taac2026 review verify --kind train --plan-id plan-2026-05-08-001
# 期望 ok=true
taac2026 review verify --kind submit --plan-id plan-2026-05-08-001
# 期望 ok=true
```

`bin/taac2026.mjs::enforceReviewGate` 会在每次 `submit --execute` 前调用 verify，**这是硬闸**，无 token / 篡改 / 过期 / kind 错配 / plan_id 不符任一项都立即 exit 2。

### 4) 状态查询

```bash
taac2026 review status --plan-id plan-2026-05-08-001
# 列出 train / submit 两个 token slot 的当前状态
```

## 失败处理

- **`Missing HMAC key`** → 跑一次 `taac2026 secrets init-hmac --execute --yes` 生成 key。
- **`HMAC key is not 32-byte hex`** → key 文件被改过；删除后重新生成。
- **`hmac mismatch`** → token 被篡改；**不要**简单重新签发，先排查谁动过 `.review-token-*` 文件，可能是入侵迹象。
- **`token expired`** → TTL 到了，重新走人审 + issue 流程。
- **`plan_id mismatch`** → token 是为别的 plan 签的；用对应 plan 的 token，或重新签。

## 不要做

- 不要把 token 文件传到任何远端机器或 commit 进 git（`.review-token-*` 已被 `.gitignore` 屏蔽）。
- 不要复用旧 token 跨 plan——每个 plan-id 必须有自己的 token；token 中已绑定 `proposal_sha256` / `data_manifest_sha256` / `research_index_sha256` 三套 SHA256，绑定关系无法剥离。
- 不要绕过 `enforceReviewGate`（即使 `TAAC2026_BYPASS_REVIEW_GATE=1` 也是为单测准备的，**不要**在生产环境设置）。
- 不要让 Claude 自动 `/review:gate`——`disable-model-invocation: true` 已在 frontmatter 写死，但你也别想着绕。
