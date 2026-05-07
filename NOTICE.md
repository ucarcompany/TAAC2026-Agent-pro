# NOTICE

## Upstream

本仓库（`ucarcompany/TAAC2026-Agent-pro`）派生自：

- **原始仓库**：<https://github.com/ZhongKuang/TAAC2026-CLI>
- **原作者**：ZhongKuang
- **原始 LICENSE**：MIT（请前往原仓库查看完整 LICENSE 文本）

我们感谢原作者搭建了 TAAC2026 / Taiji 平台的 agent-friendly CLI 基础。本派生的修改集（M0 / M1）均建立在原作者的工作之上，原始版权与许可声明均完整保留。

## What this fork changes

详见 [`CHANGELOG.md`](CHANGELOG.md)。简述：

- M0：修复 [`taiji-output/reports/code-audit-2026-05-07.md`](taiji-output/reports/code-audit-2026-05-07.md) 中列出的 P0 / 关键 P1 安全与稳健性问题；新增 Stage 0 readiness 闸、`.claude/` 骨架（settings + hooks）、secrets CLI。
- M1：新增 `taac2026 data ingest` / `taac2026 data profile`（schema-lock + leakage 红线）+ data-auditor subagent + 配套 skill 文档。
- 路线图 M2–M8 见 [`taiji-output/reports/skill-expansion-design-2026-05-07.md`](taiji-output/reports/skill-expansion-design-2026-05-07.md)（设计稿，尚未实现）。

## Third-party dependencies

无新增运行时依赖。继承原仓库 `package.json` 中的依赖：

- `js-yaml` (MIT)
- `playwright` (Apache-2.0)
- `cos-nodejs-sdk-v5` (MIT)

## Contact

本 fork 维护：`ucarcompany`（GitHub）。如发现安全问题，请优先在 GitHub Issues 用 `security` 标签提交，或私信仓库维护者。
