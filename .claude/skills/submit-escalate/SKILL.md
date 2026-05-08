---
name: submit-escalate
description: 把候选 submit-bundle 推过 5 道闸（local / compliance / quota / human / dry-run）到达 submit_dry_run_verified。当用户说"提交模型""提交评估""推到 submit""走提交流程""advance gate"或斜杠 /submit:escalate 时使用。Claude 不能自动推进闸 — 必须人触发，且 dry-run 后真实提交是 M7（独立 PR）。
allowed-tools: Read, Glob, Grep, Bash(taac2026 submit-escalate *), Bash(taac2026 review status *), Bash(taac2026 review verify *), Bash(taac2026 propose status *)
disable-model-invocation: true
argument-hint: [plan-id] [candidate-bundle]
---

# submit-escalate — 提交配额状态机

> **为什么 `disable-model-invocation: true`？** 推动这个状态机会推动配额计算，而每个 plan-id 关联的 daily_hard_ceiling 是用来限制真实官方提交（M7）的"最后一道闸"。Claude 不能自动跑——必须真人 `/submit:escalate plan-...` 触发。

## 状态机

```
candidate
  ↳ local_gate_passed         (val_auc 提升 ≥ 阈值，多 seed CI 是 future R13)
  ↳ compliance_gate_passed    (3 SHA256 匹配 + 反 ensemble grep + latency ≤ budget + license + leakage)
  ↳ quota_available           (今日 daily_official_used < daily_hard_ceiling)
  ↳ human_second_approved     (submit_token 验证：HMAC + TTL + plan_id + 双人审批字段)
  ↳ submit_dry_run_verified   (taac2026 submit --bundle &lt;b&gt; 不带 --execute 必须 OK)
  ↳ submitted                 (M7 — 真实调用太极 / 比赛官网 API)
  ↳ eval_created
  ↳ eval_completed
  ↳ archived
```

每个闸**单独 advance**，**不可跳级**，FAIL 不推进且写决议到 `taiji-output/state/submits/<plan-id>/decisions/<gate>-<ts>.json`。

## 何时使用

- M0–M5 走完后，你已经有：
  - `taiji-output/proposals/<plan-id>/proposal.json`（已 freeze）
  - `taiji-output/state/loops/<plan-id>/loop-state.json`（loop 跑到 `completed`）
  - `taiji-output/state/.review-token-submit`（双人审批 + plan_id 匹配，via `taac2026 review issue --kind submit`）
  - 一个准备好的 submit-bundle（`taac2026 prepare-submit` 产出，目录形式）

## 工作流

### 1) 初始化

```bash
taac2026 submit-escalate init \
  --plan-id plan-2026-05-08-001 \
  --candidate-bundle taiji-output/submit-bundle-xxx \
  --template-job-internal-id 58620 \
  --latency-budget-ms 25 \
  --daily-hard-ceiling 1
```

写出 `taiji-output/state/submits/<plan-id>/quota-state.json`（state=`candidate`）。

> `--daily-hard-ceiling 1` 表示**今日最多让 M7 真实提交 1 次**。设 0 等于完全不允许提交（M6 dry-run 永远停在 quota_gate）。

### 2) 状态查询

```bash
taac2026 submit-escalate status --plan-id <id>
```

会显示当前 state、`gate_results` 每个闸的结果、`next_gate`（下一个待 advance 的闸）、`history`。

### 3) 推进闸（依次）

```bash
# 先 dry-run 看会跑哪个闸（不实际跑）
taac2026 submit-escalate advance --plan-id <id>

# 真跑下一个闸
taac2026 submit-escalate advance --plan-id <id> --execute --yes
```

**结果**：
- `passed: true` → state 推进，可以接着跑下一个 advance
- `passed: false` → state 不变，`reason` 字段告诉你具体哪个子检查 fail；修完之后再 advance

也可以指定 gate（**必须**是 next gate，否则报错）：

```bash
taac2026 submit-escalate advance --plan-id <id> --gate local_gate --execute --yes
```

### 4) 重置

某个闸 FAIL 后修完了上游材料，但 `gate_results` 里还有旧的 false：

```bash
taac2026 submit-escalate reset --plan-id <id> --to local_gate_passed --execute --yes
```

会把 reset 目标 state 之后的所有 `gate_results` 清掉，并把 state 改成 `<to>`。

## 5 个闸的语义

| 闸 | 检查项 | FAIL 时怎么修 |
|---|---|---|
| `local_gate` | 最后一轮 `val_auc` ≥ 倒数前 3 轮最大值 + threshold_delta | 重跑 loop / 调超参 |
| `compliance_gate` | 3 SHA256 匹配 / 仓库内无 ensemble 关键字 (`StackingClassifier` / `VotingRegressor` / `BlendEnsemble` / `model_avg` 等 10 项) / latency p95 ≤ budget / license 在白名单 / leakage red flags == [] | 改 proposal/data/code/profile 之一 |
| `quota_gate` | 今日 daily_official_used < daily_hard_ceiling | 等明天，或人为提高 daily_hard_ceiling（需 review-gate 重签 token） |
| `human_approval` | `.review-token-submit` 文件存在、HMAC 校验通过、未过期、kind=submit、plan_id 匹配、approver 含 "+human:" 段（双人） | `taac2026 review issue --kind submit --plan-id <id> --approver alice --execute --yes`（前提 `TAAC2026_SECOND_APPROVER` 已设） |
| `submit_dry_run` | 调 `node scripts/submit-taiji.mjs --bundle <b> --template-job-internal-id <id>`（**不带** `--execute`），exit 必须 0 | 看 stdout/stderr_tail 字段，常见是 manifest 缺字段 / cookie 没装 |

## 不要做

- 不要手编 `quota-state.json`——每一次跳级都会让审计断链。
- 不要把 daily_hard_ceiling 当临时调控手段——它的语义是"今日最多真实提交几次"，不是"今天可以试几次 M6 dry-run"（dry-run 不消耗 quota）。
- 不要把多个 plan-id 共用一个 candidate-bundle——`compliance_gate` 检查 SHA256 时按 plan-id 解析 proposal.json，bundle 跟 plan-id 必须一一对应。
- 不要绕过 `human_approval`（即使 dry-run）——它要求**双人**审批是设计稿 §10 的强制项，对应 R5（提交配额烧光）/ R6（违反 non-ensemble）的关键缓解。
- 不要让 Claude 自动 `/submit:escalate`——`disable-model-invocation: true` 已写死。
