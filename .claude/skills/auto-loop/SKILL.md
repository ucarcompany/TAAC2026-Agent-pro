---
name: auto-loop
description: 自动训练循环（dry-run 状态机 / 真实远端 SSH 由 M5 接入）。当用户说"开始训练""跑 N 轮""auto-loop""run training"或斜杠 /loop:run 时使用。Claude 不能自动启动训练，需 review-gate train_token 把关。
allowed-tools: Read, Glob, Grep, Bash(taac2026 loop *), Bash(taac2026 review status *), Bash(taac2026 propose status *)
disable-model-invocation: true
argument-hint: [plan-id] [max-iters]
---

# auto-loop — 自动训练循环

> **为什么 `disable-model-invocation: true`？** 启动训练（哪怕是 dry-run）会推动 `loop-state.json` 状态机，并消费 `train_token` 配额。Claude 不能自作主张推进训练；必须由真人 `/loop:run <plan-id>` 触发。

## 何时使用

- M3 已完成：`proposal.json` 已 freeze（state=`reviewed_by_compliance`）+ `train_token` 已签发并通过 verify。
- 用户键入 `/loop:run plan-...` 或要求"按方案跑训练"。

## 工作流

### 1) 校验前置

```bash
taac2026 propose status --plan-id <plan-id>
# 期望 state=reviewed_by_compliance（或更后）

taac2026 review status --plan-id <plan-id>
# 期望 train.present=true 且 plan_match=true
```

### 2) 初始化 loop

```bash
taac2026 loop init --plan-id <plan-id>
```

CLI 会写出：
- `taiji-output/state/loops/<plan-id>/loop-state.json`（state=`idle`）
- `taiji-output/state/loops/<plan-id>/taac-loop.yaml`（v2 配置，安全默认 `enable_official_submit=false`、`daily_hard_ceiling=0`、`allow_network=false`）

可选：先编辑 `taac-loop.yaml` 调整 `loop.max_iters` / `loop.metric.threshold_delta` / `loop.retry.max_per_iter`，再继续。

### 3) 跑

**先 dry-run 看一眼**：

```bash
taac2026 loop run --plan-id <plan-id>
# 输出 mode=dry-run，不推进状态
```

**真跑**：

```bash
taac2026 loop run --plan-id <plan-id> --execute --yes
```

`bin/taac2026.mjs` 会 enforce：
- readiness 必须 `ready`（M0 硬闸）
- `train_token` 必须 verify 通过（M3 硬闸）

满足后状态机依次推进：

```
idle → planned → approved → queued
       → running_iter → collecting_metrics → analyzing → proposing_next
       → (queued → ...)*  // 直到 max_iters 或 early-stop
       → completed | paused | failed | killed
```

每一步都原子写 `loop-state.json`（`tmp + rename`），中途 Ctrl-C 不会丢前 N 轮的指标历史。

> **M4 dry-run vs M5 真远端**：M4 用确定性 in-process stub 模拟 iter（val_auc 单调收敛 + bounded noise）。M5 起，如果 `taac-loop.yaml` 中 `loop.remote_host_alias` 指定了 `~/.ssh/config` 里的别名，且该别名出现在 `taiji-output/state/allowed-hosts.txt`，CLI 会通过 SSH ControlMaster 单连接编排远端 runner（`~/taac-runs/<plan-id>/iters/<iter-id>/`，详见 [`references/gpu-host-setup.md`](../../references/gpu-host-setup.md)）。**绝不接受密码 / 裸 IP / `user@host`**——guard-bash.sh + `_allowed-hosts.mjs` + `RemoteRunner` 三层拦截。

### 4) 紧急停止

```bash
taac2026 loop kill --plan-id <plan-id>
```

写 `taiji-output/state/loops/<plan-id>/KILL`。`run` 在每个 phase 的开头检查 KILL，命中即转 `killed` 状态并落盘。

### 5) 恢复

```bash
taac2026 loop resume --plan-id <plan-id>
```

仅在 `state == paused` 时合法；清 KILL marker，把状态推到 `queued` 等待下一轮。

## 关键约束

- **不可跳级**：状态机的 `ALLOWED_TRANSITIONS` 显式列出每个合法转换；试图跳跃（如 `idle → running_iter`）会抛 `illegal transition`。
- **重试预算**：`loop.retry.max_per_iter`（默认 2）是单 iter 内连续失败上限；超出即 `failed`，不会回退到 `queued`。
- **早停**：`val_auc` 连续 3 轮提升 < `metric.threshold_delta`（默认 0.001）时直接 `completed`。
- **审计**：每次状态推进都 append 一行到 `taiji-output/state/events.ndjson`，便于事后追溯。

## 不要做

- 不要手编 `loop-state.json`——状态机依赖它的内部一致性。改了会让重试 / 早停计算错乱。
- 不要在 `loop.yaml` 里偷偷把 `defaults.enable_official_submit: true`——M4 不接 submit；M6/M7 才会用，并且要走 review-gate `submit_token`。
- 不要让 Claude 自动 `/loop:run`——`disable-model-invocation: true` 已写死。
- 不要在 `running_iter` 状态下手动改 `iter_history`——`run` 在分析阶段会比对 last vs current。
