---
name: data-profile
description: 对已 ingest 的数据集做 schema-lock + leakage 红线 + 列级 cardinality 哈希。当用户说"profile 数据""检查泄漏""锁 schema"或"查 leakage"时使用。
allowed-tools: Bash(taac2026 data profile *), Read, Glob
argument-hint: [dataset-id]
---

# data-profile — schema-lock 与泄漏自检

## 何时使用

- `data-ingest` 完成后 / 算法提案前的强制步骤。
- 当 `taiji-output/data/<id>/manifest.json` 已存在但 `taiji-output/profiling/<id>/schema.lock.json` 缺失时主动调用。
- 用户怀疑数据漂移、特征泄漏、label 与某列高度相关时调用。

## 工作流

1. 先 dry-run：
   ```bash
   taac2026 data profile --dataset-id sample-test
   ```
   读取 manifest，构建 `schema.lock` 候选 + leakage 草表，输出在 stdout。
2. 用户确认后 `--execute --yes` 落盘到 `taiji-output/profiling/<id>/profile.json` + `profile.md`。
3. **首跑** 会创建 `schema.lock.json`；后续运行若发现列序 / 类型 / cardinality 哈希不一致，CLI 直接 `exit 2` 并要求人工 ack（设计稿 §7.2，杜绝训练数据漂移）。

## 红线规则

| 规则 | 阈值 | 行为 |
|---|---|---|
| `\|spearman(col, label)\| > 0.95` | 0.95 | 加入 `leakage_red_flags`，**exit 2** |
| 列被加 / 减 / 类型变 / 顺序变 | 任一发生 | `schema_lock_status: drift`，**exit 2** |
| domain_seq 含未来时间戳 | 暂未实现（M2 跟进） | TODO |

## 输出契约

`taiji-output/profiling/<id>/profile.json`：

```jsonc
{
  "version": 1,
  "dataset_id": "...",
  "rows_total": 1000,
  "columns_total": 120,
  "schema_lock_status": "fresh|stable|drift",
  "schema_diff": {"changed": false, ...},
  "leakage_red_flags": [{"column": "leak_x", "statistic": "spearman", "value": 0.99, "threshold": 0.95}],
  "label_column": "label",
  "profile_dry_run": false
}
```

## 失败处理

- 红线触发：保留 profile.json 已写入状态，**绝不**绕过红线继续。请用户审视数据后决定丢列或重新采样。
- Schema 漂移：要求用户显式 ack，必要时手动删除旧 `schema.lock.json` 重建。
- 仅 csv/tsv 已支持；parquet 在 M2 之前请先转 csv（用 `pyarrow` 之类离线脚本）。

## 不要做

- 不要为了让 CI 过自动绕过红线（`--execute --yes` 不能加任何 `--force`）。
- 不要把 profile 输出写到 `taiji-output/data/`——profile 与 data 严格分目录。
- 不要在 profile 内修改原始数据；profile 是只读分析。
