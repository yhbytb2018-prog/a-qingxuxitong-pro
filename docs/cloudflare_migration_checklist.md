# 云端迁移改造清单（Cloudflare Workers · 评估基准 2026-10-07）

> 目标：零成本云端运行（Cloudflare 免费额度）。
> 结论先行：**主管道不可能整体迁入免费层**（子请求墙与 CPU 墙，见 §3）；
> 本期（P0）落地**推送代理 Worker**（决议 2 的云端推送，S3 浏览器侧依赖），
> 重管道保留 GitHub Actions（公共仓库本就零成本、无上述两墙、保留 git 数据审计链）。

## 一、现状架构（"后端"是什么）

本系统**没有常驻服务器**：静态页面（GitHub Pages）+ 定时脚本（GitHub Actions cron → Node 脚本）+ 数据即文件（`data/*.json` 随 git 提交）。"后端代码" = `src/`（52 个模块）+ `scripts/`（59 个入口脚本）。

## 二、兼容性矩阵（代码清点证据）

| 层 | 结论 |
|---|---|
| **纯函数层（42 个 src 模块）** | ✅ 零 Node 依赖直接进 Worker bundle——含计算引擎 `engine/recalc.js`、`engine/enrich.js`、`ai_report.js`、`sources.js`（全部 fetch 逻辑） |
| **Node 依赖层（10 个 src 模块）** | ⚠️ 需适配：`pipeline.js`（fs/spawnSync）、`config.js`/`calendar.js`/`dual_track.js`/`opsalerts.js`（fs 读档）、`engine/write.js`（21 处 fs 写）、`ai_report_push.js`（fs/crypto）、`zt_rebuild.js`、`archive_split.js`+`lhb_codec.js`（仅 `Buffer.byteLength`，一行可换 `new TextEncoder().encode().length`） |
| **`grid_parallel.js`** | ❌ `worker_threads` 多进程并行回测——Workers 无对应物，需串行化或删除（回测网格本就是 Actions 专属负载） |
| **`pipeline.js` 的 `spawnSync`** | ❌ Workers 无子进程——`fetch_universe` 等需改为模块直调 |
| **前端（app.js/paper_ui.js/sw.js）** | ✅ 零 Node 依赖，相对路径 fetch `./data/*.json`——可原样托管到任意静态平台 |
| **第三方依赖** | ✅ `package.json` 零依赖（纯 Node 内置），**无需替换任何 npm 库** |

## 三、硬约束裁决（免费额度 vs 实测负载）

| 约束 | 免费额度 | 本系统实测/估算 | 裁决 |
|---|---|---|---|
| **子请求/次** | **50** | 主管道单跑 **230-330**（龙虎榜席位明细 120-220 占大头）；整条 CI 链含全市场扫描达**数千**（K线 5400 只每只 1 请求） | ❌ **硬伤**。付费版 1000/次也放不下整链 |
| **CPU/次** | **10ms** | 增量因子重算毫秒-秒级可过；但全档重算（241 交易日×三版公式）**数十秒**；回测网格多核并行 | ❌ 全档场景不可行；增量勉强 |
| KV 写/天 | 1000 | 本系统日写入 ~50-100 次（管道 2 跑/天 + 盘中 13 拍 + 报告若干） | ✅ 充裕 |
| KV 读/天 | 100,000 | 个人页面访问量级 | ✅ 充裕 |
| 内存 | 128MB | 主档 archive.json 全量 + 中间结构 | ⚠️ 紧张，需切片访问 |

**裁决：数据管道留在 GitHub Actions**（公共仓库零成本、无子请求/CPU 墙、git 提交即数据审计链——回滚能力是本系统透明度纪律的一部分，迁 KV 会失去）。

## 四、已实施（P0 · 推送代理 Worker，本次交付）

**动机**：决议 2——页面即时轨报告的云端推送走云函数代理（浏览器无 secret 且有 CORS 墙）；S3 即时轨依赖此端点。

| 文件 | 职责 |
|---|---|
| `src/push_text.js`（新） | 纯渲染层抽取：`PUSH_CONSTS`+`renderPushText`，零 import，Node/Worker/浏览器三端通用 |
| `src/ai_report_push.js`（改） | re-export 纯渲染层，既有 import 路径零改动；推送/闸门逻辑不动 |
| `worker/index.js`（新） | Worker 入口：`GET /healthz` · `POST /push` · OPTIONS 预检 · 404 |
| `worker/push_proxy.js`（新） | 代理逻辑（可单测）：形状校验 → 来源闸（ALLOWED_ORIGIN）→ 请求体上限 → KV 指纹去重（30 天，urgent 免直达——决议 3 对齐）→ 每日 100 条上限 → 企微推送（失败不记指纹自愈） |
| `wrangler.toml`（新） | Worker 配置：KV 绑定 PUSH_STATE、vars ALLOWED_ORIGIN（注释态）、部署三步注释 |
| `test/worker_proxy.test.mjs`（新） | 9 用例：路由/无 secret 跳过/成功记 KV/去重/urgent/来源闸/体校验/日限/失败自愈/指纹稳定性 |

**Node API 合规**（验收标准①）：worker 目录零 Node API——仅标准 fetch/Request/Response/URL + 纯模块 import；`node:crypto` 摘要被 djb2 轻量指纹替代（去重场景非安全场景，已在代码注释记录理由）。

**已验证**（2026-10-07 本机）：
- 单测 9/9，全量回归 1312/1312 零失败
- `npx wrangler dev`：50s 就绪，`/healthz` 200，`/push` 无 secret 优雅跳过
- `.dev.vars` 注入 secret 后：真实企微推送成功（`pushed:true`）+ 同内容二推被 KV 去重拦截——**端到端含 KV 与外部 fetch 全通**（`.dev.vars` 已删，`.gitignore` 已加 `.dev.vars` 与 `.wrangler/`）

**部署步骤**（首次上线时）：
```
npx wrangler login
npx wrangler kv namespace create PUSH_STATE   # 把返回的 id 填入 wrangler.toml
npx wrangler secret put OPS_WEBHOOK            # 企微机器人 URL（与 CI 同值）
npx wrangler deploy
# 加固：[vars] 设 ALLOWED_ORIGIN = 页面部署域（当前注释态）
```

## 五、P1（可选 · 数据 API 化）

- Worker 增加 `GET /api/data/:key`：读 KV 返回数据档（CORS 开）——页面即时轨可在 CI 数据过期时取云端最新拍
- Actions 管道尾步追加"同步 KV"（写当日快照 ~10 键，读免费额度内）
- 改动面：`engine/write.js` 加 KV 出口（注入式，同 storage 注入惯例）；页面临时不接（现有 git 档照常）

## 六、P2（受限 · 管道迁移，当前不建议）

前提条件（缺一不可）：付费计划（$5/月档：CPU 30s、子请求 1000/次）+ 任务拆分（Durable Objects 或 Queues 把席位抓取分片到多次调用）+ `grid_parallel` 串行化重写 + 数据审计链重建方案（KV/R2 版本化 + 告知失去 git 回滚）。**收益仅 cron 精度**（GitHub 定时已知延迟数分钟），代价是全部上述重构——性价比为负，除非 Actions 政策变化。

## 七、依赖替换对照表（P2 若启动时逐项套用）

| 现状（Node） | Cloudflare 替代 | 涉及文件 |
|---|---|---|
| `node:fs` 读写 | KV `get/put`（数据档）注入式适配 | engine/write.js、calendar.js、config.js、dual_track.js、opsalerts.js、ai_report_push.js、zt_rebuild.js |
| `node:crypto` createHash | WebCrypto `crypto.subtle`（异步）或轻量哈希（非安全场景） | ai_report_push.js（已用 djb2 替代于代理侧） |
| `child_process.spawnSync` | 模块直调 import | pipeline.js |
| `worker_threads` 并行 | 无对应物——串行或分片 Cron | grid_parallel.js |
| `Buffer.byteLength` | `new TextEncoder().encode(s).length` | archive_split.js、lhb_codec.js |
| `git commit` 数据持久化 | KV 直写 + 版本化键（失去 git 审计链，需另行补偿） | Actions 步骤 |
| `process.env` | `env` 绑定（fetch/scheduled 第二参数） | 全部 scripts（迁 Worker 的部分） |
