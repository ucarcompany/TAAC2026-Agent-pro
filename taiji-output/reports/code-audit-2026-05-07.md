# TAAC2026‑CLI 代码审计报告

- 审计范围：`bin/taac2026.mjs`、`scripts/*.mjs`、`scripts/tests/*.test.mjs`、`references/*.md`、`package.json`、`README*.md`、`SKILL.md`、`agents/openai.yaml`、`examples/minimal-taiji-submit/*`
- 审计方式：仅静态阅读，零修改、零写代码
- 审计日期：2026‑05‑07
- 总评：架构清晰、安全意识较强（dry‑run 默认、`--execute --yes` 双确认、`safeResult` 兜底脱敏、HTML/ZIP/YAML 下载校验、relative `--out` 沙箱化），但仍存在 1 处**高危安全漏洞**、1 处**潜在路径穿越**、1 处**`--execute` 静默降级**逻辑陷阱，以及若干稳健性、性能、一致性问题。建议按 P0 → P1 → P2 顺序处置。

---

## 一、严重程度概览

| 级别 | 数量 | 摘要 |
| --- | --- | --- |
| P0 安全 | 2 | Cookie 跨域泄漏；`file.name` 路径穿越写文件 |
| P0 安全/逻辑 | 1 | `submit --execute` 缺 `--cookie-file` 时静默降级为 dry‑run |
| P1 稳健性 | 6 | 无 fetch 超时、无重试退避、`jobs.json` 非原子写、Federation token 反复申请、`pythonishConfigToObject` 脆弱、`fetchInstanceOutput` 失败牵连 |
| P1 一致性 | 4 | `submit-taiji` 不校验 `body.error.code`、`toCsv` 列集合不统一、`extractCookieHeader` 三处复制、`resolveTaijiOutputDir` 三处复制 |
| P2 优化 | 8 | NaN 容忍、Pareto / metricKey 启发式脆弱、`compareRuns` 浮点未做容差、`scrapeEvaluations` 无最大页数、Playwright `viewport` 硬编码、CLI 路由 if‑链可表驱动等 |

---

## 二、P0 — 安全与高危逻辑

### 2.1 【高危】跨域 Cookie 泄漏：`fetchBinaryDirect` 对任意 URL 透传 Taiji Cookie

文件：[scripts/scrape-taiji.mjs](scripts/scrape-taiji.mjs#L562-L583) 的 `fetchBinaryDirect`，及评估侧 [scripts/evaluation-tools.mjs](scripts/evaluation-tools.mjs#L298-L318) 的同名函数。

```js
async function fetchBinaryDirect(client, resourceUrl) {
  const response = await fetch(resourceUrl, {
    headers: {
      cookie: client.directCookieHeader,
      referer: TRAINING_URL,
      ...
    },
  });
```

调用链：`saveJobCodeFiles` → `candidateFileSources(file)` → 当 `file.path` 为 `https?://...` 时直接以 `kind: "url"` 形式 fetch，并把 `taiji.algo.qq.com` 的 Cookie 完整发送到该 URL。

风险：训练任务 `trainFiles[].path` 与评估任务 `files[].path` 来源于服务端 JSON。一旦后端被污染、被中间人篡改，或被其它租户构造出包含 `https://attacker.example/x` 的字段，本地 CLI 会把含登录态的 Cookie 发到第三方域，造成会话劫持。SKILL.md 明确要求“Cookies are secrets” —— 当前实现违反此承诺。

建议（不在本次实施）：
1. 在 `fetchBinaryDirect` / Playwright `fetchBinaryResource` 入口处校验 `new URL(resourceUrl).host` 必须属于 `taiji.algo.qq.com`、`*.cos.ap-guangzhou.myqcloud.com` 等白名单。
2. 非白名单域改走无 Cookie 的匿名 fetch，或直接拒绝。
3. 同步修复 `fetchTextDirect`（已被外部测试导出，需保持签名兼容）。

### 2.2 【中高危】`saveJobCodeFiles` 路径穿越：`safeRelativeFilePath` 未过滤 `..`

文件：[scripts/scrape-taiji.mjs](scripts/scrape-taiji.mjs#L184-L191)

```js
function safePathPart(value) {
  return String(value ?? "unknown").replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_").slice(0, 180);
}
function safeRelativeFilePath(file) {
  const raw = String(file?.name ?? file?.path ?? file?.url ?? "file");
  const withoutProtocol = raw.replace(/^https?:\/\//i, "").replace(/^\/+/, "");
  const parts = withoutProtocol.split(/[\\/]+/).filter(Boolean).map(safePathPart);
  return parts.length ? path.join(...parts) : "file";
}
```

`safePathPart` 替换了 `< > : " / \ | ? *` 与控制字符，**但保留了 `.`**。攻击者控制的 `file.name = "../../../../escape.txt"` 会被 `split` 拆为 `["..","..","..","..","escape.txt"]`，全部通过 `safePathPart` 后再 `path.join`，最终在 `path.join(outputDir, "code", jobId, "files", "../../../../escape.txt")` 时穿越到工作区任意位置写入文件，覆盖 `package.json` 等关键文件。

对比：评估侧 `safeEvalFileName` 已用 `path.basename` 并显式拒绝 `.` / `..`，是正确做法；训练侧需对齐。

建议：在 `safeRelativeFilePath` 中过滤 `part === ".." || part === "."`，或最终通过 `path.relative` 验证结果不以 `..` 开头。

### 2.3 【高 P0 逻辑】`submit-taiji.mjs --execute` 在缺 `--cookie-file` 时静默降级

文件：[scripts/submit-taiji.mjs](scripts/submit-taiji.mjs#L259-L272)

```js
if (args.execute && !args.yes) throw new Error("--execute requires --yes");
if (!args.cookieFile) {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "plan.json"), ...);
  console.log(`Wrote dry-run plan without network: ...`);
  return;
}
```

问题：用户显式传 `--execute --yes` 但忘记 `--cookie-file` 时，工具不报错，反而写出 dry‑run 计划并以 0 退出。Agent / 自动化脚本可能据此误判“已上线”，与 SKILL.md 中“Mutation Safety Gate”和用户规则 `r4`（先定 DoD）相抵触。

建议：当 `args.execute` 为真且无 `--cookie-file` 时显式 `throw new Error("--execute requires --cookie-file")`。

---

## 三、P1 — 稳健性与一致性

### 3.1 全局缺失 `fetch` 超时（Hang 风险）

`scripts/scrape-taiji.mjs`、`submit-taiji.mjs`、`experiment-tools.mjs`、`evaluation-tools.mjs` 中的 `fetch(...)` 全部没有 `AbortSignal.timeout(...)`。一旦 Taiji 网关 502/挂起，CLI 会无限阻塞。`scrape --all` 多次串行调用，极易卡死整夜任务。

建议：统一封装 `fetchJsonWithTimeout` / `fetchBinaryWithTimeout`，默认 60s，可由 `--http-timeout` 覆盖。

### 3.2 `--direct` 模式无 401/403 自动重试，无指数退避

`fetchJsonFromPage` 在 Playwright 模式下对 401/403 会循环等待登录刷新；`fetchJsonDirect` 一旦 401 立即抛出。两条路径行为不一致，增量同步若中途凭据短暂失效，整次 `scrape --all` 失败。

建议：直连模式下对 5xx / 408 / 429 加上有界指数退避（最多 3‑5 次），对 401 仍可即时失败但提示用户更新 cookie。

### 3.3 `scrapeAllTrainingJobs` 写盘非原子，且只在最后写一次

[scripts/scrape-taiji.mjs](scripts/scrape-taiji.mjs#L876-L920) 中 `jobs.json` / `all-metrics-long.csv` 在循环结束后才 `writeFile`。
- 进程被 Ctrl‑C 时已下载的代码 / 日志保留在磁盘，但 `jobs.json` 不会更新，下一次增量同步无法识别已抓部分；
- 写入大 JSON 时若崩溃，旧文件被截断 → 缓存全毁。

建议：
1. 每处理 N 个 Job 做一次中间持久化；
2. 写入采用 “tmp + rename” 原子模式（Node 14+ `fs.promises.writeFile` 不保证原子）。

### 3.4 Federation Token 与 COS Client 反复创建

[submit-taiji.mjs `uploadToCos`](scripts/submit-taiji.mjs#L186-L204)、[evaluation-tools.mjs `uploadToCos`](scripts/evaluation-tools.mjs#L255-L273)：每个文件都 `await getFederationToken(...)` + `new COS({...})`。提交包含 ≥4 个文件时多次请求 `/get_federation_token/`，浪费 round‑trip 且与用户规则 `r9`（控制服务器请求频次）相违。

建议：和 `saveJobCodeFiles` 中 `getCosClient()` 一样做单实例懒加载。

### 3.5 `fetchInstanceOutput` 用 `Promise.all` 把 checkpoints 与 metrics 绑定失败

[scripts/scrape-taiji.mjs](scripts/scrape-taiji.mjs#L483-L494)：任一接口失败整个实例标记 `error`，metrics 数据丢失。常见场景：刚启动的实例 `get_ckpt` 还没列表，但 `tf_events` 已有第一批指标。

建议：改为 `Promise.allSettled`，分别记录 partial 错误。

### 3.6 `pythonishConfigToObject` 解析极脆弱

[scripts/experiment-tools.mjs](scripts/experiment-tools.mjs#L191-L199)：

```js
const normalized = text
  .replace(/:\s*\(([^()]*)\)/g, ": [$1]")
  .replaceAll("'", '"')
  .replace(/\bTrue\b/g, "true")
  .replace(/\bFalse\b/g, "false")
  .replace(/\bNone\b/g, "null");
return JSON.parse(normalized);
```

- 单引号字符串内的内嵌单引号（如 `'it's ok'`）→ JSON 解析失败；
- 字符串值里出现单词 `True/False/None`（如 `'reason': 'True positive'`）→ 被错误降转，篡改 config 数据；
- 嵌套元组 `((1,2),(3,4))` 第一遍正则只匹配最内层，外层 `()` 保留 → 解析失败；
- 任何 `1e-3`、`Decimal(...)`、`numpy.float64(...)` 都会抛错。

该函数被 `verify` / `compareRuns` / `diffConfigRef` / `diagnoseJob` 间接依赖；解析失败会让审计失真。建议长期方案：
1. 训练侧把 `Resolved config` 直接 JSON 化打印；
2. CLI 端不要尝试 “python repr → JSON”，仅在严格 JSON 行可解析时才比较，否则降级为字符串 diff，避免 false signal。

### 3.7 一致性：`fetchTaijiJson` 逻辑分散

`extractCookieHeader`、`taijiHeaders`、`fetchTaijiJson`、`resolveTaijiOutputDir` 在 4 个 `.mjs` 中复制粘贴，且行为略有差异：
- `experiment-tools.mjs` 的 `fetchTaijiJson` 校验 `body.error.code !== "SUCCESS"`；
- `submit-taiji.mjs`、`evaluation-tools.mjs` 的 `fetchTaijiJson` **没有**业务错误码校验。

后果：Taiji 侧返回 HTTP 200 + `{error: {code: "FAILED", message: "quota exceeded"}}` 时，submit 与 eval 路径会把失败当成成功，写出 `result.json` 误导用户。

建议：抽到 `scripts/_taiji-http.mjs`（保持纯函数）共用，统一错误码语义。

### 3.8 `toCsv` 列集合不一致

[scrape-taiji.mjs `toCsv`](scripts/scrape-taiji.mjs#L172-L178) 只用 `Object.keys(rows[0])`；[evaluation-tools.mjs `toCsv`](scripts/evaluation-tools.mjs#L131-L135) 用 `flatMap(Object.keys)` 并集。前者会丢失后续行新增的字段（例如不同 instance 才有的 metric）。

建议：统一用并集策略。

---

## 四、P2 — 优化与可读性

1. **CLI dispatcher 表驱动**：[bin/taac2026.mjs](bin/taac2026.mjs#L101-L114) 的 `routedArgs` 三元嵌套可改为 `commands[name].rewriteArgs(args)` 字段，避免再加命令时双向修改。
2. **`Number(arg)` 缺校验**：`--page-size`、`--timeout`、`--auth-timeout` 直接 `Number(...)`，传入非法值得到 `NaN` 静默生效（导致 `for (;;)` 死循环风险）。建议 `Number.isFinite + > 0` 校验。
3. **Pareto 选择器** [experiment-tools.mjs `paretoCandidates`](scripts/experiment-tools.mjs#L394-L417)：当 `valid_test_like` 缺失时用 `-Infinity` 兜底，会让缺失指标的点更易被支配；可在文档里显式说明。
4. **`metricKey` 启发式**[experiment-tools.mjs](scripts/experiment-tools.mjs#L257-L266) 依赖字符串 `includes("/")` 推断完整 key，遇到自定义指标命名（如 `auc-valid`）就归类错误。
5. **`compareRuns` 浮点误差**：测试里直接断言 `0.0040000000000000036`，输出层未做有效位数收敛（建议 `toFixed(6)`），便于 Markdown 报告阅读。
6. **`scrapeEvaluations` 翻页无最大页保护**：`for (;;) ... if (!body.next) break;` 全靠服务端守约。建议加 `maxPages`（如 200）兜底。
7. **`waitForLogin` body 文案匹配**：硬编码中英文片段，UI 改版易失败。可改为等待具体 API 返回 200 取代文案探测。
8. **Playwright `viewport: 1600x1000`** 硬编码，部分内网最小窗口会触发响应式隐藏；可走配置项。

---

## 五、可优化的工程实践（与本仓库代码风格一致）

| 主题 | 现状 | 建议 |
| --- | --- | --- |
| 公共 HTTP 封装 | 4 处复制 | 抽 `_taiji-http.mjs`，含超时/重试/业务码 |
| 公共参数解析 | 3 套 `parseArgs` | 抽 `_argv.mjs`，统一布尔/字符串/数值校验 |
| 输出沙箱 | 3 处 `assertSafeRelativeOutputPath` | 抽 `_paths.mjs` |
| 日志噪音 | `console.log` 散布 | 引入 `--quiet` 与 `--log-level` |
| 单元测试覆盖 | 仅 5 个 test 文件，集中在 happy path | 补：401 重试、Cookie 跨域拒绝、partial fetch、CSV 列并集、`pythonishConfigToObject` 边界 |
| `.gitignore` | 仓库根无 `.gitignore`，`taiji-output/` 易被误提交（含 cookie / browser‑profile） | 在示例 `examples/minimal-taiji-submit/` 与根目录补 `.gitignore`，至少忽略 `taiji-output/` |
| 依赖审计 | `playwright ^1.52`、`cos-nodejs-sdk-v5 ^2.15.4` | 加 `npm audit --omit=dev` 到 CI；定期 `playwright install` 跟随浏览器版本 |
| 退出码 | 多数 `main().catch(...)` 用 `process.exitCode = 1` | 区分参数错误（2）、网络错误（3）、平台业务错误（4）便于自动化脚本判别 |
| README/SKILL 与代码漂移 | bin help 列出 `evaluation` 别名但未在表里展示；docs 描述与 actual flag 大体一致 | 用 `node bin/taac2026.mjs --help` 在 CI snapshot 比对 |

---

## 六、建议的修复优先级（不立即执行）

| 优先级 | 项目 | 位置 |
| --- | --- | --- |
| P0 | Cookie 域名白名单 | `fetchBinaryDirect` / `fetchBinaryResource` / `fetchTextDirect` |
| P0 | `safeRelativeFilePath` 拒绝 `.` / `..` | `scripts/scrape-taiji.mjs` |
| P0 | `submit --execute` 缺 `--cookie-file` 立即报错 | `scripts/submit-taiji.mjs` |
| P1 | 全局 `fetch` 超时 + 5xx/429 退避 | 抽 `_taiji-http.mjs` |
| P1 | `jobs.json` 增量原子写 | `scrapeAllTrainingJobs` |
| P1 | Federation token 单实例化 | `submit-taiji.mjs` / `evaluation-tools.mjs` |
| P1 | `fetchInstanceOutput` 改 allSettled | `scrape-taiji.mjs` |
| P1 | `submit/eval` 校验 `body.error.code` | 三处 `fetchTaijiJson` 合并 |
| P2 | `pythonishConfigToObject` 降级策略 | `experiment-tools.mjs` |
| P2 | `toCsv` 并集列 | `scrape-taiji.mjs` |
| P2 | 数值参数校验 / NaN 防御 | 各 `parseArgs` |
| P2 | `.gitignore` 模板 | 仓库根 + 示例 |

---

## 七、亮点（值得保留）

- Mutation Safety Gate 设计良好：所有写操作默认 dry‑run，要求 `--execute --yes` 二步确认，并在 `safeResult` 中统一脱敏 `cookie/token/secret/...`。
- `validateTrainFileDownload` 拦截 SPA HTML / 大小不符 / ZIP magic 错位 / `config.yaml` 非 mapping 等典型坑。
- `shouldSkipJobDeepSync` 判定纪律严谨：终态 + 完整缓存 + `updateTime/status/jzStatus` 三字段一致才跳过，且 `downloadVersion` 字段为升级缓存预留。
- 每条命令都把产物收敛在 `taiji-output/` 下，避免污染调用方仓库根。
- 单元测试用真实 `execFile` 跑 CLI 端到端，能捕获 dispatcher 行为；`evaluation-tools` 测试通过替换 `globalThis.fetch` 隔离网络，干净。
- README、SKILL.md、references/ 三层文档清楚地分给“人 / agent / 协议参考”三类读者。

---

## 八、结论

整体代码质量达到“可发布给 agent 直接调用”的水准。**当务之急是 P0 的三项修复**：Cookie 跨域白名单、训练 trainFile 路径穿越加固、`submit --execute` 缺 cookie 时报错。完成 P0 后再分批清理 P1（HTTP 公共层、原子写、token 复用），可显著提升大规模 `scrape --all` 与多文件 `submit` 的稳健性。P2 主要是可读性与边界鲁棒性，可滚动迭代。

> 本报告为只读审计输出，未对任何源码、配置、工件做修改。
