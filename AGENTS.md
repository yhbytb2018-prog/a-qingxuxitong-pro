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
- `node scripts/build_reports_html.mjs` — 生成多栏目静态 HTML 日报（reports_html/，daily.yml 盘后挂点）
- `node scripts/fetch_stock_detail.mjs` — 采集个股级涨跌停明细（东财涨停/跌停/炸板三池 → data/stock_detail.json，10 个个股级栏目的共同数据底座）
- `node scripts/fetch_arb_sources.mjs` — 采集在市转债清单+腾讯转债/正股行情 → data/arb_sources.json（套利日报数据源）
- `node scripts/fetch_hot_news.mjs` — 采集东财 7x24 快讯 + 涨停题材聚合 → data/hot_news.json（热点新闻栏目数据源）
- `node scripts/fetch_prejudge_data.mjs` — 东财 push2 clist 创科 10 日涨幅榜 → data/prejudge_detail.json（盘中预判栏目：硬过滤/组合AB/主力交叉验证；push2 本地可能拉不通，CI 可达，缺档页面按缺失降级）
- `node scripts/push_hot_news.mjs` — 热点题材晨报企微推送（OPS_WEBHOOK，generatedAt 指纹防重推，失败不记指纹下拍自愈重试）
- `node scripts/check_frontend.mjs` — 前端一致性检查（app.js 兜底与 config.json 防漂移等）
- `node scripts/promote_params.mjs` — 参数晋级（回测调优结果写入正式参数）

以上均有 package.json 快捷方式（`npm test`、`npm run backtest`/`audit:lhb`/`check:frontend` 等），优先用 npm scripts。

## 架构与边界
- **口径唯一来源模式（核心约定）**：每类业务口径有一个唯一来源文件，别处只许 import 不得复算——`src/lhb.js`（龙虎榜）、`src/global.js`（外围行情）、`src/quote.js`（实时行情）、`src/seats.js`（席位）、`src/paper.js`（模拟交易规则）。涉及这些领域的计算先找对应文件。
- 纯函数引擎（`backtest.js`/`predict.js`/`alerts.js`/`picks.js`/`paper_review.js` 等）浏览器与 Node 共用，**零依赖**，不得引入 Node 专有 API。
- 配置唯一事实源是根目录 **`config.json`**；`src/config.js` 只是加载+启动校验的薄壳。前端经 `window.ASENT_CONFIG` 取值；`app.js` 里的 `TH_DEFAULT` 等兜底副本与 JSON 的一致性由 `test/config.test.mjs` 防漂移断言守护——改 JSON 忘改兜底会测试红。改配置只改 config.json 一处。
- 前端 = 根 `index.html` + `app.js`（经典脚本）+ `style.css`，零构建；`paper_ui.js` 已下线但文件保留。
- `data/*.json` 为生成数据，由 Actions 每日更新并提交回 main。
- `ui/` 存放 K 线抓取相关脚本（`fetch_kline_all.mjs`）；`schemas/` 是 data 产物的 JSON Schema，改动产物结构需同步改 schema 及 `scripts/check_contract.mjs` 校验。
- `reports_html/` 是多栏目静态 HTML 日报（对齐外部短线日报站形态）：14 栏目全部按交易日出 `YYYYMMDD.html` 日报，每栏目 `index.html` 归档 + 根 `index.html` 导航；**子目录名 = 中文栏目名**（如 `情绪扫描/`），页面内链接经 encodeURIComponent，栏目 key（morning/emotion/…）仅作脚本内部索引不落盘。生成时点分拍（同日文件后跑覆盖先跑）：**北京 08:30** 热点新闻（挂 smoke job 的 UTC 00:30 拍点，抓快讯→生成→推企微晨报，快讯 7x24 无交易日语义工作日全抓）、**09:00** 早盘快报（挂 daily.yml 盘中快照 job 的 UTC 01:00 拍点）、**09:30** 竞价复盘（UTC 01:30 拍点，首封样本先出、盘后全覆盖）、**10:30/15:00** 盘中预判（UTC 02:30/07:00 拍点，首判/终判覆盖，策略链路=创科 10日涨幅前60 硬过滤→组合AB）、**18:30/21:00** 其余全部栏目 + 上述栏目用最新数据覆盖（另有 **19:15/22:15 备拍** `15 11`/`15 14`：2026-10-22 实录平台连续三天丢盘后 cron、smoke/build 全 skipped 显示 success 静默断更后新增——它们是 smoke/build 排除式 if 之外的同语义拍点，跑同一链路幂等覆盖；**23:50 断更守卫** `50 15` 挂 `reports_guard` job 跑 `scripts/check_reports_gap.mjs`，交易日缺当日栏目文件即企微+issue 告警，判定在 `src/reports_gap.js` 纯函数层、日历未覆盖/非交易日不臆测不告警、观察者恒 exit 0）；**周度复盘仅在周五生成**（`--force` 旁路）。盘中各拍点的 HHMM 精确门控自 2026-10-13 起改为「时间窗 + 当日文件缺失补生成」（防 GitHub cron 延迟丢拍：延迟 run 落窗内且文件未出即补、已出则跳过；终判窗恒覆盖首判，抓取失败保留既有版本）；文件名日期与生成脚本同源（`--date` > signals/intraday 两档 tradeDate 取较新——盘中拍点 signals-latest 仍是上一交易日，须用已滚当日的 intraday，2026-10-19 实录：纯 signals 优先曾把周一盘中数据写进周五 20261016.html）。`--only col1,col2` 限定栏目（拍点用）。唯一生成入口 `scripts/build_reports_html.mjs`——只读 data/、只写 reports_html/，缺失渲染「—」不补 0，不做口径计算（数值全部引自各口径唯一来源文件）。个股级栏目依赖 `data/stock_detail.json`（fetch_stock_detail.mjs 产物，档内 tradeDate 为 ymd 紧凑格式）与 `data/arb_sources.json`，缺档按缺失标注降级。页面自包含（内联 CSS，红涨绿跌），改动公共样式需全栏目同步。部署经 deploy-pages.yml paths 白名单 `reports_html/**` 与产物组装 `cp -r reports_html/. site/reports_html/`（两处同源，改一处须同步另一处，test/deploy_manifest.test.mjs 有守卫）。

## 容易踩的坑
- **跨语言一致性**：回测引擎语义与 `tools/backtest/sentiment_backtest.py` 严格对齐，由 `test/fixtures/parity_v52.json` 逐位比对。改任一端语义后必须重跑 `tools/backtest/make_parity_fixture.py` 并提交新夹具。
- **CI 门禁**：`audit_lhb_caliber.mjs` 校验双口径不混用、因子口径锁、连板概率不硬编码；`scripts/backtest_limit_up_streak.mjs` 产物是 predict.js 分层表唯一数据来源。
- **主档写盘形态唯一**：任何写 `data/archive.json` 的路径（管道正常写入 / 跳过·非交易日的 `refreshMetaOnly` / 回写脚本）一律走 `writeArchive` / `writeArchiveSafely`（码表 + 提子 `_sub` 同一形态），不得自写 `encodeArchive`——漏传 `{ deflate: true }` 会把主档写回内联态，审计「主档写盘态 lhb 已提子」断言即红（2026-10-14 实录：`refreshMetaOnly` 漏提子，盘后 build 被拦，次日预测等 13 个盘后栏目停更）。
- **部署单通道**：只有 `deploy-pages.yml` 部署，paths 白名单（index.html/app.js/style.css/sw.js/data/**/reports_html/**）——纯文档、scripts、test 变更不触发部署。⚠ GITHUB_TOKEN 的 push 不产生 push 触发事件（2026-10-14 全量 run 实录：6/6 bot push 零触发、3/3 人工 push 全部触发）：daily.yml 五个提交步骤（热点晨报/盘后/盘中/盘前/外围）在 bot push 成功后经 Actions API 显式 dispatch 本工作流（需 `actions: write` 权限），勿依赖 push 自动触发。
- **workflow cron 成对约束**：daily.yml 新增 cron 字符串必须同步加进 smoke/build 的排除式 if，否则会误跑冒烟+全量管道（例外：`15 11`/`15 14` 盘后备拍**有意不排除**——它们就是 smoke/build 的冗余触发；`50 15` 断更守卫则必须排除并挂独立 reports_guard job）。
- 缺失数据不允许静默填值：走代理推算并记 `imputedRatio`，推不出则中性 50 + 显式标记。

## 维护规则
当项目结构、构建/测试命令、架构边界、开发约定或本文件记录的其他事实发生变化时，必须在同一次改动中同步更新本文件。
