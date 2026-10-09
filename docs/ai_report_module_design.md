# AI 报告生成与推送模块 · 设计对齐稿

版本：design-v1.5（2026-10-06）｜状态：**八项决议全部拍板；S1 + S1.5 + S2 已实施**（`src/ai_report.js` 模拟选股层、`src/ai_report_push.js` 推送与调度闸门、schema、单测 25/25、全量回归 1303/1303 绿、daily.yml 四挂点 + 企微推送、`data/reports/` 09-30 四类示例）
范围：只读取交易系统已有数据，生成盘前/盘中/盘后/周报四类报告并展示；不修改网格策略、风控规则、回测引擎与实盘下单逻辑。
变更记录：v1.1 增补"模拟选股"第五分层（§9）；v1.2 固化决议 7/8；v1.3 落地 S1.5（模拟选股并入 `src/ai_report.js`、判据常量化、`STARTUP_PCT_RANK_MAX=30` 矛盾裁决见 §9.2）；v1.4 口径锁定：`phase` 保持英文枚举不动、`phase_label` 承载中文（契约稳定性优先），绑定读写职责边界固化（写入由 S3 UI 用户确认剧本时触发，模块生成流程只读联查）；v1.5 落地 S2：盘前 cron 卡北京 09:05、盘中 hot 榜联查（候选池 `intraday_chg`）、CI 侧推送直走 OPS_WEBHOOK + 内容指纹防风暴（§6.1）。2026-10-07 增补：模拟选股层总开关 env `SIMULATION_MODE`（daily.yml 顶层 `${{ vars.SIMULATION_MODE || 'true' }}`——仓库 Variables 可全局关闭四挂点，不动 workflow；CLI `--sim` 优先于 env，单次强制开）。

---

## 0. 现状基线（设计的事实前提）

勘察结论（2026-10-06，基于当前仓库）：

1. **无数据库、无后台服务**。生产数据全部是 `data/*.json` 文件（GitHub Actions 每日生成、git 提交持久化）；个人模拟盘账本在**浏览器 localStorage**（`window.__paperSnapshot` 桥已存在）。
2. **调度主通道是 GitHub Actions `daily.yml`**（UTC cron）。现有盘中快照 job 已是每 30 分钟一档（`0,30 1-7`）。
3. **四类需求字段在系统中不存在**（详见 §2.3 缺失策略）：ATR、关键价位、网格触发记录、逆势加仓/逆势亏损记录。本模块**不造数**，一律 `null + missing_notes`，沿用项目既有纪律（"缺失显示未知而非补 0"）。
4. 现成推送通道：`scripts/alert_channel.mjs` 的企业微信 Webhook（env `OPS_WEBHOOK`）+ 指纹防风暴。本模块复用该模式但通道隔离。

---

## 1. 模块结构

### 1.1 文件布局（全部新增，零改动现有文件）

```
a-sentiment-pro/
├── src/ai_report.js             # 核心纯函数：DataSnapshot → 报告对象
│                                #   Node/浏览器双端共用（沿用 src/paper.js 模式）
│                                #   导出 buildInput / generatePreMarket / generateIntraday
│                                #                / generatePostMarket / generateWeekly
│                                #   S1.5 模拟选股层同文件（用户指令）：mapPhase 五期映射 /
│                                #   buildScripts 剧本模板 / buildCandidatePool 候选池 /
│                                #   绑定记录（BINDINGS_KEY 独立 localStorage key，不动账本）
├── src/ai_report_view.js        # 报告对象 → 可读文本视图（markdown，S3）
├── src/ai_report_push.js        # S2 推送与调度闸门（Node/CI 专用，不入浏览器 bundle：
│                                #   import node:fs 与 freshness/calendar）：内容指纹防风暴 /
│                                #   urgent 直达 / 四类企微文本渲染 / pushReports 出口 /
│                                #   gatePreMarket·gateIntraday·gateWeekly 三闸门
├── scripts/build_ai_report.mjs  # CI 入口：读 data/*.json → 闸门 → 调核心 → 落盘 data/reports/
│                                #   （--force 旁路闸门：示例重生成/维护用）
├── scripts/push_ai_report.mjs   # S2 CI 推送：--latest <type>（新鲜度窗口）/ 显式文件模式
├── schemas/ai-report.schema.json# 契约（纳入 scripts/check_contract.mjs 校验）
├── data/reports/                # 落盘目录
│   ├── index.json               #   各类型最新一期索引 + 首屏示例标记
│   ├── push_state.json          #   推送指纹记忆（30 天 TTL，随 bot 提交 = 无状态 runner 共享）
│   ├── post_market_2026-09-30.json   # 首发示例报告（随仓库提交）
│   └── ...
└── (后续 UI 阶段) index.html 加 #aiReportPanel 分区 + app.js 渲染
```

### 1.2 依赖方向（满足"非目标"约束）

```
data/*.json ──┐
__paperSnapshot ─┐
                ├→ buildInput() → generate*() → Report 对象 ─┬→ data/reports/*.json（CI）
                │                                          ├→ 文本视图（渲染）
                │                                          └→ push（CI / 代理）
```

- `src/ai_report.js` **只接收输入对象、只返回新对象**：不 import `paper_ui.js`/`app.js`，不写文件，不发请求，不触碰 `src/paper.js`、`src/regime.js`、`src/backtest.js` 的任何状态。
- 所有数字的**口径唯一事实源**声明在报告 `sources` 段（沿用 dualTrack"只搬运不重算"的纪律）。

### 1.3 双生成轨（关键架构决策）

CI 端读不到 localStorage，个人账本数据只有浏览器端有；反之 CI 端有完整的 18:30 落库数据。因此：

| 轨道 | 运行处 | 数据能力 | 产物 |
|---|---|---|---|
| **归档轨**（archived） | GitHub Actions | data/*.json 全量；无个人账本、无日内 equity | `data/reports/*.json`，`generated_by: "ci"` |
| **即时轨**（live） | 页面打开时 | `__paperSnapshot`（账户净值/持仓/成交/滑点/回撤档位）+ data/*.json | 内存对象，`generated_by: "browser"`，可复制/推送，不落盘 |

同一天两轨并存：即时轨字段更全（账户级 `max_drawdown_daily`、真实 `cost_ratio`/`slippage_avg`），归档轨是快照底座。`payload.*_source` 字段标注每个数字来自哪条轨。

---

## 2. 数据接口

### 2.1 DataSnapshot 输入结构

```js
buildInput({
  dualTrack,     // data/paper/dual_track_latest.json        [必填] 前日/当日执行轨账本
  dualTrackDays, // data/paper/dual_track.json::days 周切片  [周报必填]
  signals,       // data/signals-latest.json                 [必填] regime/dailyReport/health/pain/breadth/seats
  global,        // data/global.json                          [盘前/盘中] 外盘/夜盘 quotes
  backtest,      // data/backtest.json                        [盘后/周报] 偏差分析锚点
  opsAlerts,     // data/ops-alerts-latest.json               [必填] 熔断/风控事件
  intraday,      // data/intraday.json                        [盘中] 指数实时
  paperAccount,  // window.__paperSnapshot（即时轨注入）      [可选] 个人账本
})
```

### 2.2 字段映射表（需求 → 实际来源）

| 需求字段 | 来源（归档轨） | 来源（即时轨） | 备注 |
|---|---|---|---|
| `date` | `dualTrack.day.date` | 同左 | 交易日，非自然日 |
| `pnl_daily` | `dualTrack.day.dayReturns.A` | `accountStats` 当日 equity 变化 | 执行轨 A 口径为默认 |
| `pnl_cumulative` | `dualTrack.summary.trackA.total` | `accountStats.ret` | 同上 |
| `max_drawdown_daily` | `null`（无日内 equity 序列） | `acct.nav` 当日峰谷计算 | 即时轨专属 |
| `grid_triggers` | **不存在** → `null` | 同左 | `src/grid_parallel.js` 是参数寻优并行器，非网格交易引擎 |
| `counter_trend_losses` | **不存在** → `null` | 同左 | 近似参考项：`logs[stage=risk]` 拦截数、`divergence.posGap`，只作旁注不冒充 |
| `trend_switch_hits` | `signals.regime.turns`（当日/本周计数） | 同左 | regime 状态机切换 |
| `cost_ratio` | `null`（当日无真实成交明细） | `trades[]` 汇总 `fee / 毛收益` | 归档轨披露假设口径常量 |
| `slippage_avg` | `0.0002`，`source: "assumed_constant"`（`DEFAULT_SLIP`） | `estPrice vs px` 逐笔实算 | |
| `status` | 派生：`ok / degraded / missing` | 同左 | 见 §4.1 |
| 净值/持仓结构 | `dualTrack.day.trackA.targetPos + poolPos` | `+ accountStats.positions` | |
| 浮盈浮亏 | `null`（CI 无个人持仓） | `accountStats.floatPnl` | |
| ATR | **不存在** → `null` | 同左 | 扩展点：可后续从 `ui/kline/` 日K 计算，不在本模块内造 |
| 关键价位 | **不存在** → `null` | 同左 | 扩展点：archive 高低点枢轴 |
| 外盘/夜盘涨跌幅 | `global.quotes[].chgPct` | 同左 | A50 = 夜盘代理；美股仅 04:30 后可信（`usReadiness`） |
| 趋势开关状态 | `signals.regime.latest`（key/label/cap）+ `position_policy` 区间 | 同左 | "趋势开关" = regime 状态机 + 仓位帽 |
| 熔断状态 | `opsAlerts.events`（risk/error 级）+ regime cap | `+ paper.js DD_TIERS` 当前档位、`HARD_STOP_LOSS` | 概念映射见下 |
| 回测曲线（偏差分析） | `backtest.series.navV52/navV53` vs `dualTrack` A 轨累计 | 同左 | 锚定关系已有门禁 |

概念映射声明（写进每份报告的 `concepts` 段）：
- **趋势开关** → `regime`（unknown/ebb/climax/ice/recover/shift/neutral 七态 + 仓位帽）
- **熔断** → 账户层 `DD_TIERS`（回撤 ≥9%→仓位帽 70%、≥15%→40%）+ 单笔 `HARD_STOP_LOSS=-8%` + `ops-alerts` 风控事件；CI 端只见事件流，档位计算在即时轨

### 2.3 缺失策略（统一纪律）

任何取不到的字段：值 `null` + `missing_notes[]` 追加 `{field, reason, ref}`。**绝不补 0、绝不猜**。`status` 降级规则见 §4.1。

---

## 3. 调度流程

### 3.1 cron 表（GitHub Actions，UTC；北京 = UTC+8）

| 报告 | 触发 | cron（UTC） | 数据窗口 |
|---|---|---|---|
| 盘前 | 交易日 09:05（北京，v1.5 实施口径：卡 9:00-9:10 窗口，早于 09:15 集合竞价） | `5 1 * * 1-5` 独立 `premarket` job（S2 已实施） | 前日 dual_track + 凌晨美股档（04:30 已落库）+ global 夜盘 |
| 盘中 | 每 30 分钟（09:30~15:00） | 复用现有 `0,30 1-7` 盘中快照 job 追加一步（S2 已实施） | intraday（hot 榜当日快照 → 候选池 `intraday_chg` 联查）+ dual_track + global |
| 盘中·立即 | 四类 urgent 事件 | **即时轨（页面 S3）职责**——CI 归档轨盘中无实时源（见 3.3 诚实披露） | 熔断/regime 切换/回撤阈值/剧本命中（见 3.3） |
| 盘后·即时轨 | 15:05（北京） | 页面端本地合成（无 cron） | __paperSnapshot |
| 盘后·归档轨 | 18:30 首抓 + 21:00 补抓各生成一次（同日覆盖）；**推送只在 21:00**（首抓常缺龙虎榜/深证日K，不推半成品） | 挂现有 build job（`30 10` / `0 13`）末尾（S2 已实施） | 当日全量数据 |
| 周报 | 本周最后交易日 build 后（周五或节前末日，闸门自动判定） | 挂 build job 条件步（S2 已实施） | dual_track.json 本周 days 切片（week-start 自动取 ISO 周一） |

**时点约束（诚实披露）**："收盘后 5 分钟内"只有即时轨做得到——CI 端当日行情要到 18:30 抓取后才完备。归档轨盘后版在 build job 末尾生成，两轨以 `generated_at` 区分。周报判"本周最后交易日"而非死板周五（遇节假日自动前移）。盘前 09:05 受 GitHub 定时可能延迟数分钟影响（平台已知行为）——数据为昨收口径不随竞价变化，延迟不损内容正确性，推送有指纹去重兜底。

### 3.2 生成流水（归档轨，单次运行）

```
读六源 → buildInput() → generate*() → 契约校验(schemas/ai-report.schema.json)
→ 写 data/reports/<type>_<date>.json → 更新 index.json → (bot) git push
→ deploy-pages.yml paths 已含 data/** → 页面自动可见
```

落盘走现有 bot 提交链路，部署零新增配置（`data/**` 已在 deploy-pages 白名单内）。

### 3.3 事件触发（盘中"立即生成"）

**诚实披露（v1.5 实施后修正）**：四类 urgent 条件在 CI 归档轨上**均无实时数据源**——盘中 signals/regime/ops-alerts 全部是昨收盘口径（18:30 才更新），账户回撤与剧本绑定记录在浏览器 localStorage。故盘中"立即生成"是**即时轨（页面 S3）的职责**；CI 盘中报告只有 30 分钟例行版（`trigger: "schedule"`），其真实时成分 = 候选池 `intraday_chg`（hot 强势榜联查，§9.5）。四类 urgent 触发条件（schema trigger 枚举锁死，决议 3）：

- **熔断**：即时轨 ops-alerts 事件 diff（页面常开时延迟 0）
- **趋势切换**：`signals.regime.latest.key` 变化（即时轨刷新时判定）
- **回撤接近阈值**：即时轨 `drawdown` 距 `DD_TIERS` 档位（9%/15%）剩 <1pp
- **剧本命中**：剧本触发条件回放为真（§9 绑定记录）

命中任一 → 生成 `trigger: "event:<原因>"` 的盘中报告并标记 `urgent: true`（推送免防风暴直达，§6.1）。CI 侧延迟上界 30 分钟（下一拍例行报告会把变化带出来，但 `trigger` 仍为 schedule——变化与事件在归档轨上不可区分，如实标注不冒充事件）。

### 3.4 首屏示例

首发时随仓库提交 `data/reports/post_market_2026-09-30.json`（§5 的真实数字示例）+ `index.json` 标记 `is_sample: true`。首次打开页面：无本地生成记录 → 显示 09-30 示例；有记录后按类型显示各最新一期，示例保留可查。

---

## 4. JSON Schema

### 4.1 信封（四类报告共用）

```jsonc
{
  "schema_version": "1.0",
  "report_type": "pre_market | intraday | post_market | weekly",
  "trigger": "schedule | event:circuit_breaker | event:trend_switch | event:drawdown_near",
  "urgent": false,
  "date": "2026-09-30",              // 交易日；周报为周末日
  "generated_at": "2026-09-30T10:35:00.000Z",
  "generated_by": "ci | browser",
  "status": "ok | degraded | missing",  // ok=关键字段全齐；degraded=有 null 但可读；missing=核心源缺失
  "track": "A",                        // 净值口径：执行轨 A（唯一 CI 口径）
  "data_health": { "sources": { "dual_track": "fresh", "signals": "fresh", "...": "stale|missing" } },
  "data_completeness": { "pnl_daily": { "source": "archived", "confidence": "measured" }, "slippage_avg": { "source": "assumed", "confidence": "assumed" }, "grid_triggers": { "source": "missing", "confidence": "missing" }, "...": "字段级来源与可信度（决议 5，2026-10-06 拍板）" },
  "payload": { /* §4.2 分层 */ },
  "missing_notes": [ { "field": "grid_triggers", "reason": "系统无网格交易引擎", "ref": "docs/ai_report_module_design.md#2.3" } ],
  "concepts": { "trend_switch": "regime 状态机", "circuit_breaker": "DD_TIERS + HARD_STOP_LOSS + ops-alerts" },
  "sources": { "pnl_daily": "data/paper/dual_track_latest.json::day.dayReturns.A", "...": "..." },
  "disclaimer": "本报告只描述系统状态与风险特征，不构成投资建议；缺失项标注未知而非补 0。"
}
```

### 4.2 payload 分层字段

**base（四类共用，命名与需求统一）**

| 字段 | 类型 | 说明 |
|---|---|---|
| `date` / `status` | string | 信封冗余，便于单读 payload |
| `pnl_daily` | number\|null | 当日（执行轨 A） |
| `pnl_cumulative` | number\|null | 累计 |
| `max_drawdown_daily` | number\|null | 日内峰谷（即时轨） |
| `grid_triggers` | number\|null | **恒 null（见 §2.3）** |
| `counter_trend_losses` | number\|null | **恒 null（见 §2.3）** |
| `trend_switch_hits` | number | 当日/本周 regime 切换次数 |
| `cost_ratio` | number\|null | 费用/毛收益（即时轨） |
| `slippage_avg` | number\|null | 带 `slippage_source: assumed_constant \| measured` |
| `regime` | object | `{key, label, cap, position_range}` |
| `circuit_breaker` | object | `{dd_tier, hard_stop_triggered, risk_events, note}` |
| `overseas` | array | `[{key, name, chgPct, state}]`（A50 + 美股收盘档） |

**pre_market 增**：`prev_nav`（前日净值）、`positions`（目标仓位结构）、`overnight_exposure`（A50 夜盘 + posGap 保费敞口）、`key_levels`（**null**）、`events_today`（**null**）、`atr`（**null**）、`suggested_step`（**null**）

**intraday 增**：`nav_realtime`（归档轨 = intraday 指数 × targetPos 合成近似，标 `approx: true`；即时轨 = accountStats 实值）、`drawdown_vs_threshold`（距 9%/15% 档的 pp 距离）

**post_market 增**：`fee_total`、`slippage_total`、`net_pnl`（毛-费用）、`grid_trigger_detail`（**null**）、`counter_trend_loss_ratio`（**null**，旁注 posGap）、`max_drawdown_intraday`、`close_drawdown`、`backtest_deviation`（A 轨累计 vs backtest v52 锚点差）

**weekly 增**：`nav_series`（本周逐日）、`week_return`、`max_drawdown_week`、`win_rate`（dayReturns.A>0 天数占比）、`cost_ratio_week`、`trend_switch_effect`（turns 明细 + trackC 影子线对照）、`param_suggestions`（仅事实性提示：posGap 阈值观察、trackC 晋升门禁证据计数）

**四类报告均可携带 `simulation_stock` 段**（第五展示分层，结构见 §9.5，09-30 真实数字示例见 §9.6）。

---

## 5. 示例报告（2026-09-30，真实数字，归档轨口径）

### 5.1 盘后报告 JSON（`data/reports/post_market_2026-09-30.json`）

```json
{
  "schema_version": "1.0",
  "report_type": "post_market",
  "trigger": "schedule",
  "urgent": false,
  "date": "2026-09-30",
  "generated_at": "2026-09-30T10:35:00.000Z",
  "generated_by": "ci",
  "status": "degraded",
  "track": "A",
  "data_health": { "sources": { "dual_track": "fresh", "signals": "fresh", "global": "fresh", "backtest": "fresh", "ops_alerts": "fresh", "paper_account": "missing" } },
  "payload": {
    "date": "2026-09-30",
    "status": "degraded",
    "pnl_daily": 0.00017,
    "pnl_cumulative": -0.015005,
    "max_drawdown_daily": null,
    "grid_triggers": null,
    "counter_trend_losses": null,
    "trend_switch_hits": 0,
    "cost_ratio": null,
    "slippage_avg": 0.0002,
    "slippage_source": "assumed_constant",
    "regime": { "key": "recover", "label": "回暖", "cap": 0.5, "position_range": "30%~50%" },
    "circuit_breaker": { "dd_tier": null, "hard_stop_triggered": false, "risk_events": 0, "note": "归档轨无账户日内回撤，档位未知；ops-alerts 当日零风控事件" },
    "overseas": [
      { "key": "a50", "name": "富时中国A50期货", "chgPct": 0.0915, "state": "ok" },
      { "key": "sox", "name": "费城半导体指数", "chgPct": null, "state": "preopen" }
    ],
    "fee_total": null,
    "slippage_total": null,
    "net_pnl": null,
    "grid_trigger_detail": null,
    "counter_trend_loss_ratio": null,
    "max_drawdown_intraday": null,
    "close_drawdown": 0.137886,
    "backtest_deviation": {
      "live_cum": -0.015005, "backtest_v52": -0.01501, "delta": -0.000005,
      "note": "执行轨 vs 回测 v52 锚点（5e-6 为档间舍入差级，视为锚定一致）"
    },
    "market_context": {
      "emotion": 64.4, "pct_rank": 44.1, "indexes": { "上证指数": 0.31, "深证成指": -0.11, "创业板指": -0.23 },
      "up_down": "2393/2730/167", "amount_yi": 14380.2, "zt_dt": "52/9",
      "breadth": "宽度收窄（站上20日线 30.1%）", "pain": "多空拉锯（翻绿 49%）",
      "seats": "游资主导（净买 8.43 亿）"
    }
  },
  "missing_notes": [
    { "field": "grid_triggers", "reason": "系统无网格交易引擎（grid_parallel 是参数寻优并行器）", "ref": "src/grid_parallel.js" },
    { "field": "counter_trend_losses", "reason": "无逆势加仓/亏损记账；参考 divergence.posGap=0.2（保费敞口）", "ref": "data/paper/dual_track_latest.json" },
    { "field": "max_drawdown_daily / fee_total / net_pnl / cost_ratio", "reason": "个人账本成交与日内 equity 仅存在于浏览器 localStorage（即时轨）", "ref": "paper_ui.js __paperSnapshot" },
    { "field": "key_levels / events_today / atr / suggested_step", "reason": "指标服务未提供 ATR 与关键价位（盘前字段，此处不适用）", "ref": "-" }
  ],
  "concepts": { "trend_switch": "regime 状态机（src/regime.js）", "circuit_breaker": "DD_TIERS + HARD_STOP_LOSS + ops-alerts（src/paper.js / src/opsalerts.js）" },
  "sources": {
    "pnl_daily": "data/paper/dual_track_latest.json::day.dayReturns.A",
    "pnl_cumulative": "data/paper/dual_track_latest.json::summary.trackA.total",
    "close_drawdown": "data/paper/dual_track_latest.json::summary.trackA.maxDd",
    "trend_switch_hits": "data/signals-latest.json::regime.turns",
    "overseas": "data/global.json::quotes",
    "backtest_deviation": "data/backtest.json::v52 vs dual_track gates"
  },
  "disclaimer": "本报告只描述系统状态与风险特征，不构成投资建议；缺失项标注未知而非补 0。"
}
```

### 5.2 同一报告的文本视图（`renderText(report)` 输出）

```
【盘后报告】2026-09-30 · 执行轨 A · status: degraded
────────────────────────────────
■ 当日结果
  当日盈亏       +0.02%（+0.00017）
  累计收益       -1.50%（-0.015005）
  收盘回撤       13.79%（运行峰值口径）
  净收益/费用/滑点 未知（个人账本未接入，即时轨可见）

■ 风控状态
  趋势开关       回暖（recover）· 仓位帽 50% · 建议区间 30%~50%
  熔断           未触发（ops-alerts 零风控事件；日内回撤档位未知）
  趋势切换       本日 0 次（09-29 冰点→回暖后维持）

■ 执行与偏差
  回测偏差       0.00%（执行轨 -1.50% vs 回测 v52 -1.50%，锚定一致）

■ 外盘（收盘档）
  A50 期货       +0.09%    费半（美股）  盘前无数据

■ 市场底色
  情绪分 64.4（分位 44.1）· 上证 +0.31% 深成 -0.11% 创业 -0.23%
  涨跌 2393/2730 · 成交 14380 亿 · 涨停 52 / 跌停 9
  宽度收窄（站上20日线 30.1%）· 亏钱效应多空拉锯 · 游资主导

■ 缺失披露
  网格触发/逆势亏损：系统无此记账（grid_parallel 为参数寻优，非交易网格）
  日内回撤/费用/滑点实测：需浏览器即时轨（localStorage 账本）
  ATR/关键价位：指标服务未提供
────────────────────────────────
不构成投资建议 · 缺失项标注未知而非补 0
```

### 5.3 周报 payload 摘例（2026-09-28 ~ 09-30，节前 3 交易日）

```json
{
  "report_type": "weekly",
  "date": "2026-09-30",
  "payload": {
    "week_return": -0.00982,
    "nav_series": [
      { "date": "2026-09-28", "day_return": -0.01049, "score": 32.11, "regime": "ice" },
      { "date": "2026-09-29", "day_return": 0.000503, "score": 75.93, "regime": "recover" },
      { "date": "2026-09-30", "day_return": 0.00017, "score": 64.41, "regime": "recover" }
    ],
    "max_drawdown_week": 0.01049,
    "win_rate": 0.333,
    "cost_ratio_week": null,
    "trend_switch_hits": 2,
    "trend_switch_effect": {
      "turns": [ { "date": "2026-09-28", "from": "退潮", "to": "冰点" }, { "date": "2026-09-29", "from": "冰点", "to": "回暖" } ],
      "shadow_note": "trackC 影子线累计 +2.70%（0.5 档）跑赢执行轨；episodes 18 已达晋升门禁分母（≥10），证据累积中，晋升仍须走 promote_params 门禁"
    },
    "param_suggestions": [
      { "topic": "posGap 阈值", "fact": "分歧 >0.02 达 226/241 天，0.02/0.03 告警阈值仍是 [待确认] 状态", "action": "提议进入确认流程，非本模块职责" }
    ],
    "pnl_cumulative": -0.015005,
    "status": "degraded",
    "grid_triggers": null,
    "counter_trend_losses": null,
    "cost_ratio": null,
    "slippage_avg": 0.0002,
    "slippage_source": "assumed_constant"
  }
}
```

---

## 6. 推送链路（复制 → 云端推送）

### 6.1 CI 侧推送（S2 已实施 · 2026-10-06 用户拍板：四类报告统一企微 Webhook）

```
daily.yml 四挂点（盘前 09:05 / 盘中每 30 分钟 / 盘后+周报 21:00）
  → scripts/build_ai_report.mjs 生成（闸门跳过 = 正常退出）
  → scripts/push_ai_report.mjs --latest <type>（可重复多类型）
      → src/ai_report_push.js::pushReports（Node/CI 专用，不入浏览器 bundle）
          通道：env OPS_WEBHOOK（现有运维企微机器人，零新增 secret）
          防风暴：内容指纹去重（sha256 of report_type|date|trigger|status|payload|
                   missing_notes——generated_at 等易变字段剔除）：同内容重跑不重推，
                   数据真变了（21:00 补抓 vs 18:30 首抓）→ 新指纹 → 照推。
                   30 天指纹记忆（data/reports/push_state.json，随 bot 提交入库 = 无状态
                   runner 间共享记忆）
          urgent（event:* 四类）：免防风暴直达（决议 3）
          失败自愈：fetch 失败/HTTP 非 2xx 不 throw、不记指纹 → 下拍自然重试；
                   推送永不红 CI（数据管线优先），参数错误才 exit 1
          --latest 新鲜度窗口（15 分钟）：只推"本次运行刚生成"的报告——防把闸门
                   跳过后 index 残留的上一期旧报告当新一期重推（另有指纹去重双保险）
      文本：renderPushText 四类各一版简讯（null → —，缺失披露数 + 数据状态进尾注）
```

**盘后推送时点**：18:30 首抓只生成不推送（常缺龙虎榜/深证日K），21:00 补抓推送全量版；"收盘 5 分钟"语义由页面即时轨 15:05 版补位（双轨时点约束 §3.1）。**盘中推送粒度**：归档轨盘中内容仅随 hot 榜变化（候选池 `intraday_chg`），榜变才推、榜不变不推——CI 侧盘中推送天然稀疏，密集实时推送是即时轨（S3）的事。

### 6.2 页面侧推送（S3/S4 · 复制按钮 → 云端）

```
页面「复制内容」按钮
  → navigator.clipboard.writeText(文本视图)
  → 成功回调 pushReport(report_id)
      → POST {代理端点}                     ← adapter 可插拔
          adapter A（默认，推荐）：云函数/Worker 转发（页面只持代理 URL+token，
                                   Webhook secret 存云端，不落静态页面）
          adapter B（最小可用）：GitHub repository_dispatch 触发 CI push job
  → CI scripts/push_ai_report.mjs（同一指纹与防风暴，显式文件模式无新鲜度检查）
  → 推送结果回显在按钮旁（推送失败不回滚复制，仅提示重试）
```

安全边界：静态页面**永不**持有 Webhook secret（CI 侧直推走 GitHub secrets，与页面侧互不越界）。防风暴状态存 `data/reports/push_state.json`（沿用 ops-alerts 模式，两侧共享同一份指纹记忆）。

---

## 7. 实施切分（对齐通过后）

| 阶段 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| S1 | `src/ai_report.js` + schema + 09-30 示例落盘 + 单测（纯函数，Node 直测） | 本文档定稿 | ✅ 完成 |
| S1.5 | 模拟选股层（五期映射/候选池现算/剧本模板，并入 `src/ai_report.js`）+ schema 增补 + 单测 | S1 | ✅ 完成 |
| S2 | `src/ai_report_push.js`（推送/指纹/闸门）+ `scripts/push_ai_report.mjs` + daily.yml 四挂点（premarket job 09:05 + 盘中/盘后/周报步）+ CI 侧企微推送 | S1 / S1.5 | ✅ 完成（2026-10-06） |
| S3 | UI：`#aiReportPanel` 四分层 + 模拟选股第五标签展示 + 分层「复制内容」按钮（复制仅写剪切板，推送 stub）；剧本绑定录入与导出；即时轨合成与 mergeReports 合并 | S2 | ⬜ 下一步 |
| S4 | 页面侧推送 adapter（云函数代理）+ `push_ai_report.mjs` 显式文件模式接线 | S3 | ⬜ |
| S5 | 参数调整与推送流程测试（用户指定：放在推送流程之后） | S4 | ⬜ |

## 8. 决议记录（2026-10-06 用户拍板，六项全部落定）

1. **双轨主从**：即时轨为一等公民，归档轨为兜底；页面加载时以 `generated_at` 去重合并（字段级：较新者为基座，其 null 字段从较旧轨回填，轨道与来源记入 `data_completeness`）。实现：`src/ai_report.js::mergeReports`。
2. **推送通道**：云函数代理（adapter A）为正式方案；repository_dispatch（adapter B）仅作临时方案。补充（v1.5）：CI 侧四类报告直推现有 `OPS_WEBHOOK`（同一企微机器人，零新增 secret）已随 S2 落地（§6.1）；云函数代理仍是页面侧（S3/S4）的正式通道（§6.2）。
3. **盘中粒度与 urgent**：30 分钟粒度可接受。urgent 触发条件**限定四类**：熔断、regime 切换、单日回撤超阈值、剧本命中（`trigger` 枚举锁死，见 schema）。
4. **周报胜率口径**：`win_rate = 剧本命中次数 / 总剧本执行次数`（依赖剧本绑定记录）；另保留 `profit_trade_ratio`（盈利交易占比）作辅助指标。绑定记录缺席时 `win_rate=null`，不降级为日收益口径。
5. **data_completeness**：信封新增 `data_completeness` 字段，逐字段标注 `{source: live|archived|derived|assumed|missing, confidence: measured|assumed|missing}`（§4.1）。
6. **模拟选股数据模式**：先走**人工输入 + 系统记录**模式——候选池与剧本由人工录入（S1.5 的录入 UI + localStorage `airpt_sim_bindings_v1`），系统记录绑定与触发回放；后续再接真实数据源。§9.3 的"情绪面规则现算候选池"降级为人工输入的**辅助建议**（可一键采纳，不自动生效）。
7. **五期映射口径（2026-10-06 二次拍板：认可）**：recover 细分做启动/发酵，climax/ebb/ice 原样对应高潮/退潮/冰点，shift/unknown 外透不硬塞。补充决议：schema **同时保留 `phase`（五期值）与 `regime_raw`（七态原始值）**，复盘时可追溯原始状态，翻译层不丢信息（§9.2）。
8. **候选池口径（2026-10-06 二次拍板：接受）**：情绪面现算 + 基本面 null 为当前约束最优解。补充决议：①候选池每只必带 `pool_reason`（入选理由，如"6 连板龙头""3 板晋级""板块联动最强"），盘后复盘据此归因选股逻辑是否成立；②基本面字段（roe/pe/pb/peg/market_cap/moat_note/themes）**null 占位但 schema 键常驻**，后续接上数据源直接填充，不改 schema（§9.5）。

状态：八项决议全部落定；前六项已进 S1 实现（`src/ai_report.js` + `schemas/ai-report.schema.json` + 示例落盘 + 单测 8/8），第 7/8 项随 S1.5 落地（`src/ai_report_simulation.js`）。

---

## 9. 模拟选股分层（v1.1 增补）

### 9.1 定位与边界

- 在盘前/盘中/盘后/周报之外新增**第五展示分层**，复用同一调度与推送链路：各时点报告 payload 增设 `simulation_stock` 段，UI 加独立"模拟选股"标签页聚合展示。
- 只输出候选池、情绪判断、资金验证、交易剧本与复盘，**不自动下单、不替代实盘决策、不保证候选上涨**；所有模拟操作仅供训练与复盘。
- 需求中的"剧本推演模块"在系统里不存在——**剧本是本模块的生成物**（模板化纯函数输出），不是外部数据源。模板阈值只取现有常量（`HARD_STOP_LOSS=-8%`、regime cap、20 日线宽度口径、`DD_TIERS`），不引入新魔数，不改任何现有规则。
- **非目标（增补）**：不自动下单；不替代实盘决策；不保证候选股上涨；模拟记录仅供训练与复盘。

### 9.2 情绪周期五期映射（翻译层）

需求五期由系统 regime 七态 + 分位/方向推导，映射表（判据唯一出处 `src/ai_report.js::mapPhase`，阈值常量 `STARTUP_PCT_RANK_MAX`）：

**判据矛盾裁决（v1.3 显式披露）**：S1.5 指令正文写"分位 <50 且 up 为启动"，但同指令示例要求 09-30（recover·分位 44.1·up）为发酵期——两者互斥。按已拍板决议 7 的 v1.1 判据（<30 为启动）实现，与示例一致；阈值已提取为常量，一行可改。

| 需求五期 | 推导判据（系统字段） |
|---|---|
| startup 启动期 | `turns` 含 ice→recover 转折，或 `recover 且 pct_rank<30` |
| fermentation 发酵期 | `recover 且 pct_rank∈[30,70] 且 dir=up` |
| climax 高潮期 | `climax` |
| decline 退潮期 | `ebb` |
| freezing 冰点期 | `ice` |
| （映射外）| `shift`/`unknown` → `phase` 原样透出系统 key + 进 `warning_signals`，不硬塞五期 |

**双字段保留（决议 7）**：`sentiment_cycle` 同时输出 `phase`（五期英文枚举，沿用需求 schema 契约）、`phase_label`（五期中文标签：启动期/发酵期/高潮期/退潮期/冰点期）与 `regime_raw`（七态原始 key）——复盘时以 `regime_raw` 追溯原始状态，翻译层不丢信息；`phase_source` 记映射依据原文。

字段映射：`limit_up_count`←`zt_count`；`highest_chain`←`pain.advance.maxLb`；`broken_limit_ratio`←`zb_count/(zt_count+zb_count)`；`yesterday_chain_performance`←`pain.perf.avg`；`warning_signals`←`pain.verdict.reason` + 大面/晋级失败明细 + 宽度收窄提示。

**仓位建议映射**（`position_suggestion`）：cap≥0.7→`aggressive`；cap=0.5→`neutral`；cap∈[0.3,0.4]→`defensive`；cap≤0.2 或 phase∈{freezing, 映射外}→`wait`。仅是 regime 帽子的翻译，非新增风控规则。

### 9.3 数据接口（需求六域 → 系统现实）

| 需求数据域 | 系统现状 | 处理 |
|---|---|---|
| 情绪周期 | regime/pain/zt/zb 全量在档 | §9.2 映射，全部真实值 |
| 候选股池（基本面） | **基本面选股模块不存在**（无 ROE/营收/扣非/PE/PB/PEG/市值/护城河） | 池由情绪面规则现算：`momentum.fresh` 题材 ∩ 涨停/连板活跃个股（`pain.advance.detail` 等），5-10 只；基本面字段一律 `null`+missing_notes |
| 资金流向 | 席位级真实（seats：instNet/northNet/hotNet 近 3 日 + dominant）；**个股级主力净流入不存在** | 席位/板块级用真值；个股 `fund_flow_note` 只写席位结构旁注 |
| 交易剧本 | **不存在** | 本模块模板生成 A/B/C，标注 `script_source: "template"`（非信号） |
| 模拟持仓 | `paper.js` positions（localStorage，即时轨） | 直接可用；归档轨 `null` |
| 复盘记录 | `logs[]/trades[]` 在账本内；**剧本命中无处记录** | 新增独立 localStorage key `airpt_sim_bindings_v1`（{code, date, script_name}），不动现有账本 key；命中 = 绑定记录 ∧ 触发条件回放 |

### 9.4 调度（并入 §3，不新增 cron）

- **盘前**（09:15）：`simulation_stock` 全量段（周期判断 + 仓位建议 + 候选池 + 资金验证 + 剧本 + 风险提示）。
- **盘中**（每 30 分钟 / 事件）：剧本触发信号 diff、热点切换（`momentum.fresh` 集合变化）、模拟持仓止损止盈检查（即时轨 `quote.js` 实时价 vs 剧本位）、情绪阶段切换、降仓/暂停建议（透传 regime cap 变化）。
- **盘后**（15:05 即时轨 / 18:35 归档轨）：复盘段（操作明细 ∨ 剧本命中、选股逻辑复盘、周期判断复盘、资金验证、错误归因、明日改进点）。
- **周报**（本周最后交易日）：模拟收益率/最大回撤/胜率、选股逻辑命中率、情绪周期判断准确率、有效题材/因子、下周观察方向。

### 9.5 Schema 增补（沿用需求字段命名，null 纪律不变）

`payload.simulation_stock` 结构照抄需求 JSON，增补诚实字段：`phase_label`+`regime_raw`（决议 7 双字段追溯）、`phase_source`（映射依据原文）、`script_source: "template"`、`pool_basis`（池的现算规则说明）。

**候选池字段纪律（决议 8）**：
- 每只候选股必带 `pool_reason`（入选理由，人工输入或辅助建议生成，如"6 连板龙头""3 板晋级""板块联动最强"）——盘后复盘据此归因选股逻辑是否成立；
- 基本面字段 `roe/revenue_growth/net_profit_growth/pe/pb/peg/market_cap/moat_note/themes` 为 **null 占位但 schema 键常驻**：后续接入基本面数据源时直接填充，**不改 schema、不改渲染分支**（渲染层本就按 null→"未知"处理，占位即兼容）。

风险提示 `risks[]` 首期只填系统可验证项（高位连板晋级失败率、大面榜、宽度收窄、席位属性），"解禁/减持/业绩雷"系统无数据 → 不编造，进 missing_notes。

### 9.6 示例：2026-09-30 盘前 `simulation_stock` 段（真实数字）

```json
{
  "simulation_stock": {
    "sentiment_cycle": {
      "phase": "fermentation",
      "phase_label": "发酵期",
      "regime_raw": "recover",
      "phase_source": "regime=recover · 分位 44.1 · 方向 up（较 3 交易日前 +7.4 分）",
      "limit_up_count": 52,
      "highest_chain": 6,
      "broken_limit_ratio": 0.1875,
      "yesterday_chain_performance": 0.013,
      "warning_signals": [
        "昨涨停今日翻绿 49%、高位板晋级失败 40%，追高盈亏各半",
        "大面 4 只：澳弘电子 -10%、协和电子 -10%、雪龙集团 -10%、中新赛克 -8.6%",
        "宽度收窄（站上20日线仅 30.1%）"
      ]
    },
    "position_suggestion": "neutral",
    "pool_basis": "momentum.fresh 题材 ∩ 昨日涨停/连板活跃个股（情绪面规则，非基本面选股）",
    "candidate_pool": [
      {
        "code": "600825", "name": null, "themes": null,
        "roe": null, "revenue_growth": null, "net_profit_growth": null,
        "pe": null, "pb": null, "peg": null, "market_cap": null, "moat_note": null,
        "fund_flow_note": "席位结构：游资主导（当日 hot 净买 8.43 亿）；个股级主力净流入系统无数据",
        "pool_reason": "最高连板 6 板（9-30 涨停 9.99%），情绪空间标的",
        "scripts": [
          { "name": "A", "trigger_condition": "高开 >2% 且开盘 30 分钟守住昨收上沿", "position_ratio": 0.05, "stop_loss": -0.08, "take_profit": 0.1, "invalid_condition": "低开 >3% 或午前跌破昨收 -2%", "script_source": "template" },
          { "name": "B", "trigger_condition": "回踩 5 日线缩量企稳（即时轨实时价判定）", "position_ratio": 0.03, "stop_loss": -0.08, "take_profit": 0.06, "invalid_condition": "放量跌破 5 日线", "script_source": "template" },
          { "name": "C", "trigger_condition": "断板后 2 日内不补跌且 seats 转机构主导", "position_ratio": 0.02, "stop_loss": -0.08, "take_profit": 0.15, "invalid_condition": "断板次日翻绿", "script_source": "template" }
        ],
        "risks": ["6 板高位，晋级失败率本周 40%", "游资主导席位，接力属性波动大"]
      },
      {
        "code": "000678", "name": null, "themes": null,
        "roe": null, "revenue_growth": null, "net_profit_growth": null,
        "pe": null, "pb": null, "peg": null, "market_cap": null, "moat_note": null,
        "fund_flow_note": "同上（席位级可验，个股级缺失）",
        "pool_reason": "3 连板晋级成功（9-30 涨停 9.98%）",
        "scripts": [ { "name": "A", "trigger_condition": "…同模板…", "position_ratio": 0.04, "stop_loss": -0.08, "take_profit": 0.08, "invalid_condition": "…", "script_source": "template" } ],
        "risks": ["连板中位，断板回撤风险"]
      }
    ],
    "simulation_positions": null,
    "review": null
  }
}
```

`simulation_positions` 与 `review` 归档轨恒 `null`（账本在浏览器），即时轨才填充真实持仓与当日操作。missing_notes 追加：

```json
[
  { "field": "candidate_pool[].roe/pe/pb/peg/market_cap/moat_note/themes", "reason": "系统无基本面选股模块，个股基本面与题材标签无数据源", "ref": "docs/ai_report_module_design.md#9.3" },
  { "field": "risks 中的解禁/减持/业绩雷", "reason": "系统无公告/解禁数据源，不编造", "ref": "-" },
  { "field": "simulation_positions / review", "reason": "模拟账本仅存于浏览器 localStorage（即时轨）", "ref": "src/paper.js" }
]
```

### 9.7 界面与交互增补（S3）

- `#aiReportPanel` 内在原四分层旁加"模拟选股"标签：盘前视图 = 候选池 + 剧本；盘中视图 = 触发状态 + 模拟持仓变化；盘后视图 = 复盘归因；周报视图 = 命中率统计。
- 同样提供独立"复制内容"按钮，复制成功后走 §6 同一推送链路（指纹含 `sim` 段标记）。
- 模拟交易记录导出：复用 `paper.js::exportAccount` + `airpt_sim_bindings_v1` 一并导出为 JSON 下载，供后续回测对比。

