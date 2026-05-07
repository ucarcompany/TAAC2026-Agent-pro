---
name: data-ingest
description: 拉取 TAAC2026 训练/样例数据集（HuggingFace、本地路径、太极 COS），落 manifest+SHA256+license。当用户说"准备数据""下载样例""导入太极数据集"或"ingest <数据集>"时使用。
allowed-tools: Bash(taac2026 data ingest *), Read, Glob
argument-hint: [source] [dataset-id]
---

# data-ingest — 数据导入与 manifest 落盘

## 何时使用

- 用户要求准备/导入/下载 TAAC2026 数据集（如 HuggingFace `TAAC2026/data_sample_1000` 或本地预先准备好的 parquet/csv 目录）。
- 进入 M3+ 算法提案阶段前，必须先有 `taiji-output/data/<dataset-id>/manifest.json` 在册。

## 工作流

1. 读取用户给的 `--source`（`hf`/`local`/`cos`）和 `--dataset-id`。**绝不脑补来源**——若用户没说清楚，直接用 AskUserQuestion 询问。
2. 默认执行一次 dry-run 让用户审核 manifest 草稿：
   ```bash
   taac2026 data ingest --source local --src ./fixtures/sample --dataset-id sample-test
   ```
3. 用户确认后再 `--execute --yes`。
4. 完成后立即跑 `data-profile` 做 schema-lock 和泄漏自检（见相邻 skill）。

## 关键约束

- 路径白名单：所有写入必须落在 `taiji-output/data/<id>/` 下；`scripts/_taiji-http.mjs::joinSafeRelative` 已强制 `..` / `.` 拒绝。
- License 字段必须在白名单 `cc-by-nc-4.0` / `mit` / `apache-2.0` / `bsd-3-clause` 之一。
- HF 拉取走 `https://huggingface.co/...`，由 `.claude/hooks/guard-webfetch.sh` 与 CLI 双闸把关，不会泄漏 cookie。
- 默认 dry-run；`--execute --yes` 才真写盘。

## 输出契约

`taiji-output/data/<id>/manifest.json`（schema 见 `scripts/data-tools.mjs::ingestLocal`/`ingestHf`）：

```jsonc
{
  "version": 1,
  "dataset_id": "...",
  "source": {"type": "hf|local|cos", "uri": "..."},
  "license": {"id": "cc-by-nc-4.0", "commercial_use": false},
  "fetched_at": "...",
  "ingest_dry_run": false,
  "files": [{"path": "train.parquet", "bytes": 12345, "sha256": "..."}]
}
```

## 失败处理

- HF 网络失败：直接报错；不要在循环里盲重试（依赖 `_taiji-http.mjs` 已有的退避策略）。
- 路径含 `..` 或文件名非法：拒绝并向用户报错。
- License 不在白名单：拒绝；让用户改 `--license` 或先和合规确认。

## 不要做

- 不要直接读取 `taiji-output/secrets/`——cookie 通过 `--cookie-file` 传给底层 CLI。
- 不要在 `data-ingest` 里跑算法或写 csv 之外的处理；那是 `data-profile` 的事。
- 不要新建数据目录后仍标 `ingest_dry_run: true`——状态字段必须如实反映落盘与否。
