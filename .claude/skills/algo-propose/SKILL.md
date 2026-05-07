---
name: algo-propose
description: 起草 / 校验 / 冻结一份算法提案（7 节模板 + 3 SHA256 + ≥3 篇 evidence ≥0.6）。当用户说"起草方案""写一份提案""propose 一下""定方案"或斜杠 /algo:propose 时使用。注意：Claude 不能自动启动训练或提交，需 review-gate skill 把关。
allowed-tools: Read, Glob, Grep, Bash(taac2026 propose *), Bash(taac2026 lit list *), Bash(taac2026 data profile *), Edit
disable-model-invocation: true
argument-hint: [plan-id] [data-id]
---

# algo-propose — 算法提案的起草、校验、冻结

> **为什么 `disable-model-invocation: true`？** 算法提案是后续训练 / 提交链路的根。一旦 Claude 自作主张推进了 freeze，会带着错的假设污染 train_token / submit_token 的 HMAC 链。Skill 必须由人类显式 `/algo:propose <plan-id>` 触发。

## 何时使用

- M1（数据治理）和 M2（文献检索）已就绪后。
- 用户给出 `<plan-id>`（如 `plan-2026-05-08-001`）+ `<data-id>`（来自 `taac2026 data ingest` 的 manifest）后。

## 工作流（强制顺序）

### 1) 拉骨架

```bash
taac2026 propose init --plan-id <plan-id> --data-id <data-id> --latency-budget-ms 25 --max-iters 12
```

CLI 会写出 `taiji-output/proposals/<plan-id>/proposal.md`，包含 7 节占位符 + 自动填入的 `data_manifest_sha256` / `research_index_sha256`。

### 2) 人工填写

7 节都必须**逐句填实**，不能保留 `TODO` 占位（`validate` 会检查 `\bTODO\b` 计数）。每节最低要求：

| 节 | 必含字段 |
|---|---|
| 1 问题与目标 | 任务描述 + 指标（valid AUC + p95 latency）+ 比赛约束（non-ensemble）|
| 2 数据假设 | 数据集 ID（反引号） + `data_manifest_sha256`（反引号 64 hex）+ 切分策略 |
| 3 文献支撑 | `research_index_sha256` + 至少 3 条 evidence_score.relevance ≥ 0.6 的论文引用 |
| 4 算法方案 | 主干 / 特征 / loss + `non_ensemble_ack: true` |
| 5 实验计划 | `max_iters: \`12\`` + 早停规则 + 多 seed 列表 |
| 6 延迟预算 | `latency_budget_ms: \`25\`` + benchmark 协议 + p95/p99 目标 |
| 7 风险与回滚 | 至少 2 项风险 + 各自的降级方案 |

**Claude 在这一步只读不写**。如果用户要求你帮忙起草内容，用 `Edit` 工具直接改文件，但**必须**：
- 引用 `taac2026 lit list --top 8 --min-relevance 0.6` 的真实输出，不要臆造论文 ID（CLAUDE.md r1）。
- 引用 `taiji-output/data/<data-id>/manifest.json` 中的真实 SHA256，不要瞎填。
- 不要修改 CLI 自动填入的 `data_manifest_sha256` / `research_index_sha256` 行。

### 3) 校验

```bash
taac2026 propose validate --plan-id <plan-id>
```

期望输出 `"ok": true`。常见 issue：

- `todo_placeholders` — 模板还有 `TODO` 没填。
- `data_manifest_sha256_mismatch` — 数据集变化了；要么重新 init，要么先确认数据是否真该变。
- `research_index_sha256_mismatch` — 文献索引动过；同上。
- `insufficient_evidence` — `index.jsonl` 中 ≥0.6 的条目不够 3 条；先跑 `taac2026 lit search` 或 `lit ingest` 补充。
- `non_ensemble_ack_missing` — 第 4 节里没出现 `non_ensemble_ack: true`。
- `latency_budget_ms_missing` — 第 6 节里没出现 `latency_budget_ms: \`<n>\``。

### 4) 冻结

```bash
taac2026 propose freeze --plan-id <plan-id> --execute --yes
```

会做：
- `validate` 必须先通过（否则 `VALIDATION_FAILED` exit 2）；
- 计算 `proposal.md` 的 sha256 写入 `proposal.json`；
- 状态机推进：`draft → reviewed_by_compliance`。

冻结后才能进入 `review-gate` 申请 `train_token`。

## 不要做

- 不要在 freeze 后修改 `proposal.md`——这会让后续生成的 token 中 `proposal_sha256` 与盘上文件不匹配，所有依赖它的训练 / 提交都会被拒。改方案要走新 `plan-id`。
- 不要把 `proposal.json` 当作可手编文件——只能由 CLI 写。
- 不要在没有 `compliance-reviewer` subagent PASS 输出的情况下推进到 `awaiting_human` 状态（M4+ 才会引入 reviewer 自动调度，本里程碑只到 `reviewed_by_compliance`）。
