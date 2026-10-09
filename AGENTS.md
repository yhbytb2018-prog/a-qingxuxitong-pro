# AGENTS.md — A股情绪系统 PRO（云端版）

## 项目概览
纯静态前端 + Node 数据管道，跑在 GitHub Pages + Actions（零服务器）。无打包器、无 lint 工具；`type: module`，要求 Node ≥ 22。

## 常用命令
- `node --test` — 全量单元测试（node:test，无额外框架）
- `node src/pipeline.js`（加 `MODE=live` 需外网）— 主数据管道
- `node scripts/backtest.mjs` — 生成 data/backtest.json
- `node scripts/audit_lhb_caliber.mjs` — 龙虎榜口径守卫（CI 门禁）
- `node scripts/freshness.mjs --require-fresh` — 新鲜度门禁（滞后退出码 1）
- `node scripts/build_ui.mjs` — 构建合并版 UI（仅 daily.yml 用，不部署）

## 架构与边界
- **口径唯一来源模式（核心约定）**：每类业务口径有一个唯一来源文件，别处只许 import 不得复算——`src/lhb.js`（龙虎榜）、`src/global.js`（外围行情）、`src/quote.js`（实时行情）、`src/seats.js`（席位）、`src/paper.js`（模拟交易规则）。涉及这些领域的计算先找对应文件。
- 纯函数引擎（`backtest.js`/`predict.js`/`alerts.js`/`picks.js`/`paper_review.js` 等）浏览器与 Node 共用，**零依赖**，不得引入 Node 专有 API。
- 配置唯一事实源是根目录 **`config.json`**；`src/config.js` 只是加载+启动校验的薄壳。前端经 `window.ASENT_CONFIG` 取值；`app.js` 里的 `TH_DEFAULT` 等兜底副本与 JSON 的一致性由 `test/config.test.mjs` 防漂移断言守护——改 JSON 忘改兜底会测试红。改配置只改 config.json 一处。
- 前端 = 根 `index.html` + `app.js`（经典脚本）+ `style.css`，零构建；`paper_ui.js` 已下线但文件保留。
- `data/*.json` 为生成数据，由 Actions 每日更新并提交回 main。

## 容易踩的坑
- **跨语言一致性**：回测引擎语义与 `tools/backtest/sentiment_backtest.py` 严格对齐，由 `test/fixtures/parity_v52.json` 逐位比对。改任一端语义后必须重跑 `tools/backtest/make_parity_fixture.py` 并提交新夹具。
- **CI 门禁**：`audit_lhb_caliber.mjs` 校验双口径不混用、因子口径锁、连板概率不硬编码；`scripts/backtest_limit_up_streak.mjs` 产物是 predict.js 分层表唯一数据来源。
- **部署单通道**：只有 `deploy-pages.yml` 部署，paths 白名单（index.html/app.js/style.css/sw.js/data/**）——纯文档、scripts、test 变更不触发部署。
- **workflow cron 成对约束**：daily.yml 新增 cron 字符串必须同步加进 smoke/build 的排除式 if，否则会误跑冒烟+全量管道。
- 缺失数据不允许静默填值：走代理推算并记 `imputedRatio`，推不出则中性 50 + 显式标记。

## 维护规则
当项目结构、构建/测试命令、架构边界、开发约定或本文件记录的其他事实发生变化时，必须在同一次改动中同步更新本文件。
