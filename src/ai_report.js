// ── AI 报告生成核心（S1 · 2026-10-06 六决议拍板版）────────────────────────
//
// 定位：DataSnapshot → 四类报告对象（盘前/盘中/盘后/周报）的**纯函数层**。
//   Node/浏览器双端共用（沿用 src/paper.js 模式）；只接收输入对象、只返回
//   新对象——不 import 页面层、不写文件、不发请求、不触碰任何现有模块状态。
//
// 铁律（docs/ai_report_module_design.md）：
//   1. 只搬运不重算：执行轨数字唯一出处 data/paper/dual_track_latest.json
//      （本模块不重算任何双轨口径，与 src/dual_track.js 同纪律）。
//   2. 缺失一律 null + missing_notes，绝不补 0、绝不猜（grid_triggers 等四类
//      系统性无源字段见 STRUCTURAL_NULL）。
//   3. 双轨（决议 1）：即时轨（浏览器 localStorage 账本）一等公民，归档轨
//      （CI data/*.json）兜底；mergeReports 按 generated_at 去重合并。
//   4. urgent 触发条件限定四类（决议 3）：熔断 / regime 切换 / 单日回撤超阈值
//      / 剧本命中——trigger 枚举锁死，越界即 throw。
//
// 接线：scripts/build_ai_report.mjs（CI 归档轨）与页面 S3（即时轨）调用同一
//   组生成函数；本模块自身零 IO，测试用内联夹具 + 真实档冒烟双轨覆盖。
import { accountStats, DEFAULT_SLIP, HARD_STOP_LOSS, exportAccount } from './paper.js';
import { guardModuleFreshness } from './module_freshness.js';

export const SCHEMA_VERSION = '1.0';
export const REPORT_TYPES = ['pre_market', 'intraday', 'post_market', 'weekly'];
export const TRIGGER_ENUM = ['schedule', 'event:circuit_breaker', 'event:trend_switch', 'event:drawdown_near', 'event:script_hit'];

export const AI_REPORT_DISCLAIMER = '本报告只描述系统状态与风险特征，不构成投资建议；缺失项标注未知而非补 0。';

// 回撤档位口径出处 src/paper.js::DD_TIERS（≥9%→仓位帽 70%、≥15%→40%）。
// 此处只读档位边界做"距离"披露，不做任何仓位决策（非目标铁律）。
export const DD_TIER_EDGES = [0.09, 0.15];

// 结构性缺失字段（双轨都无数据源）：恒 null，不参与 status 降级判定
// （其缺失已由 BASE_MISSING_NOTES 常驻披露，再降级等于双重惩罚）。
const STRUCTURAL_NULL = new Set([
  'grid_triggers', 'grid_trigger_detail', 'counter_trend_losses', 'counter_trend_loss_ratio',
  'key_levels', 'events_today', 'atr', 'suggested_step',
]);

// ── 常驻缺失披露（missing_notes 的固定底座）─────────────────────────────
const BASE_MISSING_NOTES = [
  { field: 'grid_triggers / grid_trigger_detail', reason: '系统无网格交易引擎（grid_parallel 是参数寻优并行器，非交易网格）', ref: 'src/grid_parallel.js' },
  { field: 'counter_trend_losses / counter_trend_loss_ratio', reason: '无逆势加仓/亏损记账；参考 divergence.posGap（保费敞口）', ref: 'data/paper/dual_track_latest.json' },
];
const LIVE_ONLY_NOTE = { field: 'max_drawdown_daily / fee_total / net_pnl / cost_ratio / slippage 实测', reason: '个人账本成交与日内 equity 仅存在于浏览器 localStorage（即时轨一等公民，决议 1）', ref: 'paper_ui.js __paperSnapshot' };
const PRE_MARKET_MISSING_NOTE = { field: 'key_levels / events_today / atr / suggested_step', reason: '指标服务未提供 ATR 与关键价位；事件日历无数据源', ref: 'docs/ai_report_module_design.md#2.3' };
const WEEKLY_WIN_RATE_NOTE = '口径 = 剧本命中次数 / 总剧本执行次数（决议 4，2026-10-06 拍板）；剧本绑定记录（airpt_sim_bindings_v1）缺席 → null，不降级为日收益口径';

const CONCEPTS = {
  trend_switch: 'regime 状态机（src/regime.js）',
  circuit_breaker: 'DD_TIERS + HARD_STOP_LOSS + ops-alerts（src/paper.js / src/opsalerts.js）',
};

const SOURCE_REFS = {
  date: 'data/paper/dual_track_latest.json::day.date',
  pnl_daily: 'data/paper/dual_track_latest.json::day.dayReturns.A（即时轨覆盖为账本 nav 当日变化）',
  pnl_cumulative: 'data/paper/dual_track_latest.json::summary.trackA.total（即时轨覆盖为 accountStats.ret）',
  close_drawdown: 'data/paper/dual_track_latest.json::summary.trackA.maxDd',
  max_drawdown_daily: '即时轨当日 equity 序列峰谷（S3-1 注入：opts.drawdownDaily ← window.__intradayLive.drawdownDaily ← src/intraday_live.js::dailyDrawdown）',
  trend_switch_hits: 'data/signals-latest.json::regime.turns',
  overseas: 'data/global.json::quotes（A50 + 费半；美股仅美东 16:30 后可信）',
  backtest_deviation: 'data/backtest.json::v52 vs dual_track summary.trackA',
  market_context: 'data/signals-latest.json::latest / breadth / pain / seats',
  circuit_breaker: 'data/ops-alerts-latest.json::events + src/paper.js::DD_TIERS',
  regime: 'data/paper/dual_track_latest.json::day.regime + signals.dailyReport（仓位区间）',
  slippage_avg: 'src/paper.js::DEFAULT_SLIP（归档轨假设常量）/ orders×trades 逐笔实测（即时轨）',
  cost_ratio: '即时轨当日 trades 费用合计 / 成交额合计；归档轨无成交明细 → null',
  win_rate: WEEKLY_WIN_RATE_NOTE,
};

// ── 工具 ───────────────────────────────────────────────────────────────
const num = (v) => (Number.isFinite(v) ? v : null);
const pick = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

function sourceHealth(v, dateField, expectDate) {
  if (v == null || typeof v !== 'object') return 'missing';
  if (expectDate && dateField) {
    const d = pick(v, dateField);
    if (typeof d === 'string' && d !== expectDate) return 'stale';
  }
  return 'fresh';
}

/**
 * 六源规范化：读档对象 → DataSnapshot（附 sources 健康标记与统一 tradeDate）。
 * 纯函数：只做存在性/新鲜度判定，不做任何数值计算。
 * @param {object} s { dualTrack, dualTrackDays, signals, global, backtest, opsAlerts, intraday, paperAccount }
 */
export function buildInput(s = {}) {
  // ★ 锚点反转（第二批事故真凶修复 · 2026-10-08 第三批）：signals.meta.tradeDate 优先。
  //   旧序 dualTrack.day.date 优先——账本滞后时把报告锚拖回旧日，曾生成
  //   「09-30 名 / 10-08 内容」的报告。账本只作为滞后披露项，绝不当日期锚。
  const tradeDate = pick(s, 'signals.meta.tradeDate') ?? pick(s, 'dualTrack.day.date') ?? null;
  // ② 离线模块新鲜度守卫（判据唯一出处 src/module_freshness.js，纯字符串比较）：
  //   账本/主线档日期落后于锚 → 旧值不进叙事，置 null 走 missing 中性披露
  //   （与 s_amt 缺失 → 中性 50 同一路径）；sources 标 stale 供报告披露「今日未刷新」。
  const gDt = guardModuleFreshness(pick(s, 'dualTrack.day.date'), tradeDate);
  const gBt = guardModuleFreshness(pick(s, 'backtest.meta.tradeDate'), tradeDate);
  const dualTrack = gDt.ok ? s.dualTrack : null;
  const backtest = gBt.ok ? s.backtest : null;
  const sources = {
    dual_track: gDt.ok ? sourceHealth(s.dualTrack, 'day.date', tradeDate) : 'stale',
    signals: sourceHealth(s.signals, 'meta.tradeDate', tradeDate),
    global: sourceHealth(s.global, 'meta.aShareTradeDate', tradeDate),
    backtest: gBt.ok ? sourceHealth(s.backtest, 'meta.tradeDate', tradeDate) : 'stale',
    ops_alerts: sourceHealth(s.opsAlerts, null, null),
    intraday: sourceHealth(s.intraday, 'tradeDate', tradeDate),
    paper_account: s.paperAccount && typeof s.paperAccount === 'object' ? 'live' : 'missing',
  };
  return { ...s, dualTrack, backtest, tradeDate, sources, live: sources.paper_account === 'live' };
}

function deriveStatus(input, payload) {
  if (input.sources.dual_track === 'missing') return 'missing';
  const variablyNull = Object.entries(payload)
    .filter(([k, v]) => v == null && !STRUCTURAL_NULL.has(k))
    .map(([k]) => k);
  return variablyNull.length ? 'degraded' : 'ok';
}

// 恒 null 字段 → 统一进 payload（缺失语义唯一出处，杜绝各生成器各自手写）
function structuralNulls() {
  return {
    grid_triggers: null,
    counter_trend_losses: null,
  };
}

function buildOverseas(global) {
  if (!global || !Array.isArray(global.quotes)) return null;
  const mk = (key) => {
    const q = global.quotes.find((x) => x && x.key === key);
    if (!q) return null;
    return {
      key: q.key, name: q.name,
      // 单位换算（S3-5 逮住的 S1 既有 bug）：data/global.json 的 chgPct 是**百分数值**
      // （src/global.js::normalizeQuote 现算 chg/prevClose×100，如 0.4942 = +0.4942%），
      // 报告层约定小数（push_text pct() 再 ×100）——搬运边界必须 ÷100，否则虚报 100 倍。
      chgPct: q.ok && Number.isFinite(q.chgPct) ? q.chgPct / 100 : null,
      state: q.state || (q.ok ? 'ok' : 'unknown'),
    };
  };
  const out = [mk('a50'), mk('sox')].filter(Boolean); // A50=夜盘代理；费半=与 A 股科技链同源度最高
  return out.length ? out : null;
}

/** global.quotes 里取一资产涨跌幅（buildOverseas 同款判定 + ÷100 单位换算，缺 → null） */
function quoteOf(input, key) {
  const q = (Array.isArray(input?.global?.quotes) ? input.global.quotes : []).find((x) => x && x.key === key);
  return q && q.ok && Number.isFinite(q.chgPct) ? q.chgPct / 100 : null;
}

function buildRegime(input) {
  const day = pick(input, 'dualTrack.day');
  if (!day) return null;
  const range = (pick(input, 'signals.dailyReport.sections') || [])
    .find((x) => x && x.id === 'regime' && x.position && x.position.range);
  return {
    key: day.regime?.key ?? null,
    label: day.regime?.label ?? null,
    cap: Number.isFinite(day.regime?.cap) ? day.regime.cap : null,
    position_range: range ? range.position.range : null,
  };
}

function turnsIn(input, from, to) {
  const turns = pick(input, 'signals.regime.turns');
  if (!Array.isArray(turns)) return [];
  return turns.filter((t) => t && typeof t.date === 'string' && t.date >= from && t.date <= to);
}

function buildCircuitBreaker(input, opts = {}) {
  const events = Array.isArray(pick(input, 'opsAlerts.events')) ? input.opsAlerts.events : null;
  const riskEvents = events ? events.length : null;
  if (!input.live) {
    return {
      dd_tier: null,
      hard_stop_triggered: null,
      risk_events: riskEvents,
      note: '归档轨无账户日内回撤与止损记录，档位未知；ops-alerts 事件计数如上',
    };
  }
  const stats = opts.stats;
  const ddNow = Math.abs(Number.isFinite(stats?.drawdown) ? stats.drawdown : 0);
  const ddTier = ddNow >= DD_TIER_EDGES[1] ? 2 : ddNow >= DD_TIER_EDGES[0] ? 1 : 0;
  const logs = Array.isArray(input.paperAccount?.logs) ? input.paperAccount.logs : [];
  const stopHit = logs.some((l) => l && l.date === input.tradeDate && (l.stage === 'stop' || l.stage === 'risk') && l.result === 'rejected');
  return {
    dd_tier: ddTier,
    hard_stop_triggered: stopHit,
    risk_events: riskEvents,
    note: `即时轨：运行回撤 ${(ddNow * 100).toFixed(2)}%，距档位边界见 drawdown_vs_threshold；单笔止损/风控拦截当日 ${stopHit ? '有' : '无'}`,
  };
}

function buildMarketContext(signals) {
  const latest = pick(signals, 'latest');
  if (!latest) return null;
  const verdict = (p, k) => pick(signals, `${p}.verdict.${k}`) ?? null;
  const breadthDetail = pick(signals, 'breadth.snapshot.verdict.detail') ?? pick(signals, 'breadth.snapshot.verdict.label');
  return {
    emotion: num(pick(signals, 'signals.latestEmotion.value')),
    pct_rank: num(latest.pct_rank),
    indexes: latest.indexes && typeof latest.indexes === 'object' ? latest.indexes : null,
    up_down: Number.isFinite(latest.up_count) ? `${latest.up_count}/${latest.down_count}/${latest.flat_count}` : null,
    amount_yi: num(latest.amount_yi),
    zt_dt: Number.isFinite(latest.zt_count) ? `${latest.zt_count}/${latest.dt_count}` : null,
    breadth: breadthDetail ?? null,
    pain: verdict('pain', 'label') ?? verdict('pain', 'reason'),
    seats: verdict('seats', 'label'),
  };
}

// ── data_completeness（决议 5）：字段级来源与可信度 ─────────────────────
const FIELD_SOURCE_DEFAULTS = {
  date: 'derived', status: 'derived',
  pnl_daily: 'archived', pnl_cumulative: 'archived',
  max_drawdown_daily: 'live',
  grid_triggers: 'missing', counter_trend_losses: 'missing',
  trend_switch_hits: 'archived',
  cost_ratio: 'live',
  slippage_avg: 'assumed', slippage_source: 'derived',
  regime: 'archived', circuit_breaker: 'archived', overseas: 'archived',
  prev_nav: 'derived', positions: 'archived', overnight_exposure: 'archived',
  key_levels: 'missing', events_today: 'missing', atr: 'missing', suggested_step: 'missing',
  nav_realtime: 'live', approx: 'derived', drawdown_vs_threshold: 'derived',
  fee_total: 'live', slippage_total: 'live', net_pnl: 'live',
  grid_trigger_detail: 'missing', counter_trend_loss_ratio: 'missing',
  max_drawdown_intraday: 'live', close_drawdown: 'archived',
  backtest_deviation: 'derived', market_context: 'archived',
  ma20_degraded: 'derived',
  week_return: 'derived', nav_series: 'archived', max_drawdown_week: 'derived',
  win_rate: 'live', win_rate_note: 'derived', profit_trade_ratio: 'live', cost_ratio_week: 'live',
  trend_switch_effect: 'archived', param_suggestions: 'archived',
};

const CONFIDENCE_BY_SOURCE = { assumed: 'assumed', missing: 'missing' };

/**
 * payload → 逐字段 {source, confidence}。
 * @param {object} payload 报告 payload
 * @param {object} [overrides] 生成器传入的轨道覆盖（如即时轨 pnl_daily:'live'）
 */
export function buildDataCompleteness(payload, overrides = {}) {
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v == null) { out[k] = { source: 'missing', confidence: 'missing' }; continue; }
    const source = overrides[k] ?? FIELD_SOURCE_DEFAULTS[k] ?? 'derived';
    out[k] = { source, confidence: CONFIDENCE_BY_SOURCE[source] ?? 'measured' };
  }
  return out;
}

// ── 信封 ───────────────────────────────────────────────────────────────
function envelope({ type, trigger, date, generatedAt, generatedBy, payload, input, extraNotes = [], sourceOverrides = {}, simulationStock = null }) {
  if (!REPORT_TYPES.includes(type)) throw new Error(`非法 report_type: ${type}`);
  if (!TRIGGER_ENUM.includes(trigger)) throw new Error(`非法 trigger: ${trigger}（urgent 触发条件限定四类，决议 3）`);
  const status = deriveStatus(input, payload);
  payload.simulation_stock = simulationStock ?? null; // 模拟选股段（S1.5）：注入式，四类报告均可携带
  // MA20 降级标志（2026-10-08 推送前校验 ①）：s_amt 因子 null = 当日成交额缺或
  // 量能 MA20 历史不足（<10 个有值交易日）→ 因子中性 50——这是量能降级唯一的
  // 管道判据（src/sentiment.js:143），比 smoke 旁路样本量更权威。bool 恒有值，
  // 不进 deriveStatus 的 variably-null 判定（status 语义保持）；推送侧据此打
  // 红警行，报告 JSON 同步留字段供页面/核查用（老档无此键 → falsy，兼容）。
  payload.ma20_degraded = pick(input, 'signals.latest.factors.s_amt') == null;
  const base = BASE_MISSING_NOTES;
  const notes = [...base, ...extraNotes];
  if (!input.live) notes.push(LIVE_ONLY_NOTE);
  return {
    schema_version: SCHEMA_VERSION,
    report_type: type,
    trigger,
    urgent: trigger !== 'schedule',
    date,
    generated_at: generatedAt,
    generated_by: generatedBy === 'browser' ? 'browser' : 'ci',
    status,
    track: 'A',
    data_health: { sources: input.sources },
    data_completeness: buildDataCompleteness(payload, sourceOverrides),
    payload: { ...payload, status },
    missing_notes: notes,
    concepts: CONCEPTS,
    sources: SOURCE_REFS,
    disclaimer: AI_REPORT_DISCLAIMER,
  };
}

// ── base payload（四类共用骨架）────────────────────────────────────────
function buildBase(input, opts = {}) {
  const day = pick(input, 'dualTrack.day');
  const summary = pick(input, 'dualTrack.summary');
  const payload = {
    date: input.tradeDate,
    ...structuralNulls(),
    pnl_daily: num(pick(day, 'dayReturns.A')),
    pnl_cumulative: num(pick(summary, 'trackA.total')),
    max_drawdown_daily: null, // 恒 null 底座：盘中报告由 generateIntraday 注入（opts.drawdownDaily，S3-1），其余类型无日内语义不造数
    trend_switch_hits: input.tradeDate ? turnsIn(input, input.tradeDate, input.tradeDate).length : null,
    cost_ratio: null,
    slippage_avg: DEFAULT_SLIP, // 归档轨假设常量（口径唯一出处 src/paper.js）
    slippage_source: 'assumed_constant',
    regime: buildRegime(input),
    circuit_breaker: null,
    overseas: buildOverseas(input.global),
  };
  const overrides = {};
  if (input.live) {
    const acct = input.paperAccount;
    const stats = accountStats(acct);
    opts.stats = stats;
    const nav = Array.isArray(acct.nav) ? acct.nav.filter((n) => n && Number.isFinite(n.equity)) : [];
    const last = nav[nav.length - 1];
    if (nav.length >= 2 && last && last.date === input.tradeDate) {
      const prev = nav[nav.length - 2];
      payload.pnl_daily = (last.equity - prev.equity) / prev.equity;
      overrides.pnl_daily = 'live';
      payload.pnl_cumulative = Number.isFinite(stats.ret) ? stats.ret : payload.pnl_cumulative;
      overrides.pnl_cumulative = 'live';
      const tradesToday = (Array.isArray(acct.trades) ? acct.trades : []).filter((t) => t && t.date === input.tradeDate);
      const fee = tradesToday.reduce((a, t) => a + (Number.isFinite(t.fee) ? t.fee : 0), 0);
      const gross = tradesToday.reduce((a, t) => a + Math.abs(Number.isFinite(t.gross) ? t.gross : 0), 0);
      if (tradesToday.length) {
        payload.cost_ratio = gross > 0 ? fee / gross : null;
        overrides.cost_ratio = 'live';
        payload.fee_total = fee;
        overrides.fee_total = 'live';
        payload.net_pnl = last.equity - prev.equity;
        overrides.net_pnl = 'live';
      }
      // 滑点实测：orders(estPrice) × trades(px) 逐笔配对（配不上 = 未测，不冒充）
      const filled = (Array.isArray(acct.orders) ? acct.orders : [])
        .filter((o) => o && o.status === 'filled' && o.settleDate === input.tradeDate && Number.isFinite(o.estPrice));
      const byCode = new Map(tradesToday.filter((t) => t.code).map((t) => [t.code, t]));
      const slips = filled
        .map((o) => { const t = byCode.get(o.code); return t && Number.isFinite(t.px) ? Math.abs(t.px - o.estPrice) / o.estPrice : null; })
        .filter((v) => v != null);
      if (slips.length) {
        payload.slippage_avg = slips.reduce((a, b) => a + b, 0) / slips.length;
        payload.slippage_source = 'measured';
        overrides.slippage_avg = 'live';
      }
    }
    payload.nav_realtime = Number.isFinite(stats.total) ? stats.total : null;
    overrides.nav_realtime = 'live';
  }
  payload.circuit_breaker = buildCircuitBreaker(input, { stats: opts.stats });
  return { payload, overrides };
}

// ── 四类生成器 ─────────────────────────────────────────────────────────

/** 盘前报告（交易日 09:15）：前日净值、持仓结构、隔夜敞口、剧本位（结构性 null）。 */
export function generatePreMarket(input, opts = {}) {
  const { payload, overrides } = buildBase(input);
  const day = pick(input, 'dualTrack.day');
  const summary = pick(input, 'dualTrack.summary');
  const ret = num(pick(day, 'dayReturns.A'));
  const cum = num(pick(summary, 'trackA.total'));
  payload.prev_nav = ret != null && cum != null ? (1 + cum) / (1 + ret) : null;
  payload.positions = day?.trackA ? { targetPos: day.trackA.targetPos ?? null, poolPos: num(day.trackA.poolPos), executed: day.trackA.executed ?? null } : null;
  payload.overnight_exposure = {
    a50_chgPct: num((payload.overseas || []).find((q) => q.key === 'a50')?.chgPct),
    posGap: num(pick(day, 'divergence.posGap')),
    // S3-5 盘前推送增强：隔夜外围全景（数据源 data/global.json，04:30 美股收盘档
    // cron 专抓、usReadiness ≥16:30 ET 才采信收盘态）。ok:false / chgPct 缺失 → null
    // （与 buildOverseas 同款判定，不冒充）。渲染端聚合一行展示（push_text.js）。
    us_close: { dji: quoteOf(input, 'dji'), spx: quoteOf(input, 'spx'), ixic: quoteOf(input, 'ixic') },
    cn_overnight: { hxc: quoteOf(input, 'hxc'), fxi: quoteOf(input, 'fxi') },
    cnh_chgPct: quoteOf(input, 'cnh'),
  };
  payload.key_levels = null;
  payload.events_today = null;
  payload.atr = null;
  payload.suggested_step = null;
  return envelope({
    type: 'pre_market',
    trigger: opts.trigger || 'schedule',
    date: input.tradeDate,
    generatedAt: opts.generatedAt || new Date().toISOString(),
    generatedBy: opts.generatedBy,
    payload,
    input,
    extraNotes: [PRE_MARKET_MISSING_NOTE],
    sourceOverrides: overrides,
    simulationStock: opts.simulationStock ?? null,
  });
}

/** 盘中报告（每 30 分钟 / 四类 urgent 事件即时）。 */
export function generateIntraday(input, opts = {}) {
  const { payload, overrides } = buildBase(input);
  if (!input.live) payload.nav_realtime = null; // 归档轨无指数点位合成源（intraday.json 无指数），S1 诚实置 null
  // S3-1 注入（取数+赋值一行）：当日 equity 序列峰谷回撤。数据链 = 浏览器采样器
  // window.__intradayLive.drawdownDaily（src/intraday_live.js::dailyDrawdown）→ 装配方
  // opts 传入。opts 缺/序列不足两点 → null（不冒充，data_completeness 呈 missing）。
  payload.max_drawdown_daily = input.live ? num(opts.drawdownDaily) : null;
  const extraNotes = [];
  if (input.live && payload.max_drawdown_daily == null) {
    extraNotes.push({ field: 'max_drawdown_daily', reason: '即时轨当日权益序列不足两点（采样刚启动/实时行情降级），无日内回撤语义', ref: 'src/intraday_live.js::dailyDrawdown' });
  }
  payload.approx = false;
  const stats = opts.stats ?? (input.live ? accountStats(input.paperAccount) : null);
  const ddNow = input.live && Number.isFinite(stats?.drawdown)
    ? Math.abs(stats.drawdown)
    : num(pick(input, 'dualTrack.summary.trackA.maxDd'));
  const nearest = DD_TIER_EDGES.find((e) => e >= (ddNow ?? 0)) ?? DD_TIER_EDGES[DD_TIER_EDGES.length - 1];
  payload.drawdown_vs_threshold = {
    dd_now: ddNow,
    tier_edges: DD_TIER_EDGES,
    distance_pp: ddNow != null ? Math.round(((nearest - ddNow) * 100 + Number.EPSILON) * 100) / 100 : null,
    basis: input.live ? '即时轨 accountStats.drawdown（运行回撤）' : '归档轨 trackA.maxDd（运行回撤，非当日）',
  };
  // ── 盘中身份日期修复（2026-10-08 实录：盘中推送标「09-30」）────────────
  // 设计语义（test/intraday_live.test.mjs §4 注释 / build_ai_report.mjs
  // intradayHot 注入门同款）：盘中报告的**身份日期 = 快照交易日（当日）**。
  // buildInput 的统一 tradeDate 锚定盘后主档（盘中时点恒为昨日），此前直接
  // 拿它当信封 date 造成四层错位：
  //   ① 推送文案标昨日（push_text.js 盘中行首）；
  //   ② 文件名逐日错位——盘中报告永远落「昨日名」，假期主档滞后时直接
  //     覆盖同名旧档（10-08 实录：当日 6 拍连续踩坏 09-30 首屏示例档）；
  //   ③ 指纹含 date（fingerprintOf）→ 去重台账日期失真；
  //   ④ data_health.sources.intraday 误标 stale——「当日快照 vs 昨日主档」
  //     必不相等，最新鲜的源反被判过期。
  // 修法：身份日期取快照 tradeDate，缺席兜底主档日期（防御性，不炸）；
  //   payload.date 保持主档口径（盘中盈亏恒为昨收口径，推送文案已点破）；
  //   intraday 源健康改为在场性判定——陈旧快照在写入侧已被三重保险拒绝
  //   （snapshot_intraday：非 live 相位/交易日不符/三源全败均不落盘），
  //   「在场即当日」，与盘后主档比对对盘中源必错位，纯误报。
  const intraDate = pick(input, 'intraday.tradeDate') ?? null;
  return envelope({
    type: 'intraday',
    trigger: opts.trigger || 'schedule',
    date: intraDate ?? input.tradeDate,
    generatedAt: opts.generatedAt || new Date().toISOString(),
    generatedBy: opts.generatedBy,
    payload,
    input: { ...input, sources: { ...input.sources, intraday: sourceHealth(input.intraday, null, null) } },
    extraNotes,
    sourceOverrides: overrides,
    simulationStock: opts.simulationStock ?? null,
  });
}

/** 盘后报告（15:05 即时轨 / 18:35 归档轨）。 */
export function generatePostMarket(input, opts = {}) {
  const { payload, overrides } = buildBase(input);
  const summary = pick(input, 'dualTrack.summary');
  payload.close_drawdown = num(pick(summary, 'trackA.maxDd'));
  payload.max_drawdown_intraday = null; // 同 max_drawdown_daily：日内 equity 采样未接入
  payload.grid_trigger_detail = null;
  payload.counter_trend_loss_ratio = null;
  const cum = num(pick(summary, 'trackA.total'));
  const bt = num(pick(input, 'backtest.v52.total'));
  payload.backtest_deviation = cum != null && bt != null
    ? { live_cum: cum, backtest_v52: bt, delta: Math.round((cum - bt) * 1e6) / 1e6, note: '执行轨 vs 回测 v52 锚点（零偏差为设计约束）' }
    : null;
  payload.market_context = buildMarketContext(input.signals);
  if (!input.live) { payload.fee_total = null; payload.slippage_total = null; payload.net_pnl = null; }
  else { payload.slippage_total = null; } // 金额口径需 order.qty 配对（S3 录入 qty 后开放），不造数
  return envelope({
    type: 'post_market',
    trigger: opts.trigger || 'schedule',
    date: input.tradeDate,
    generatedAt: opts.generatedAt || new Date().toISOString(),
    generatedBy: opts.generatedBy,
    payload,
    input,
    extraNotes: [{ field: 'counter_trend_loss_ratio', reason: '旁注：当日分歧 posGap（保费敞口）见 overnight/pre 段', ref: 'data/paper/dual_track_latest.json' }],
    sourceOverrides: overrides,
    simulationStock: opts.simulationStock ?? null,
  });
}

/** 周报（本周最后交易日）：周净值、回撤、剧本口径胜率（决议 4）、参数建议。 */
export function generateWeekly(input, opts = {}) {
  const tradeDate = input.tradeDate;
  const days = (Array.isArray(input.dualTrackDays) ? input.dualTrackDays : [])
    .filter((d) => d && d.date >= (opts.weekStart || '0000') && d.date <= (tradeDate || '9999'));
  const { payload, overrides } = buildBase(input);
  let cum = 1;
  let missingDays = 0;
  const navSeries = days.map((d) => {
    const r = num(pick(d, 'dayReturns.A'));
    if (r == null) missingDays += 1;
    else cum *= 1 + r;
    return { date: d.date, day_return: r, score: num(d.score), regime: pick(d, 'regime.key') ?? null };
  });
  payload.nav_series = navSeries;
  payload.week_return = days.length ? cum - 1 : null;
  let peak = 1; let maxDd = 0;
  let v = 1;
  for (const d of days) {
    const r = num(pick(d, 'dayReturns.A')) ?? 0;
    v *= 1 + r;
    peak = Math.max(peak, v);
    maxDd = Math.max(maxDd, (peak - v) / peak);
  }
  payload.max_drawdown_week = days.length ? maxDd : null;
  payload.win_rate = null; // 决议 4：剧本口径；绑定记录缺席 → null
  payload.win_rate_note = WEEKLY_WIN_RATE_NOTE;
  const ups = navSeries.filter((d) => (d.day_return ?? 0) > 0).length;
  payload.profit_trade_ratio = navSeries.length ? ups / navSeries.length : null; // 辅助指标（日线口径；回合配对 S3）
  payload.cost_ratio_week = null;
  payload.trend_switch_hits = days.length && tradeDate ? turnsIn(input, days[0].date, tradeDate).length : null;
  const turns = tradeDate && days.length ? turnsIn(input, days[0].date, tradeDate) : [];
  const tc05 = num(input.dualTrack?.summary?.trackC?.['0.5']?.total); // key '0.5' 含点，不能用 pick 路径（split('.') 会断）
  const cumA = num(pick(input, 'dualTrack.summary.trackA.total'));
  const episodes = num(input.dualTrack?.summary?.trackC?.['0.5']?.episodes);
  payload.trend_switch_effect = {
    turns,
    shadow_note: tc05 != null && cumA != null
      ? `trackC 影子线（0.5 档）累计 ${tc05} vs 执行轨 ${cumA}；episodes ${episodes ?? '[未知]'}（晋升门禁 ≥10，仍须走 promote_params）`
      : null,
  };
  const div = pick(input, 'dualTrack.summary.divergence');
  payload.param_suggestions = div && Number.isFinite(div.daysGt02)
    ? [{ topic: 'posGap 阈值', fact: `分歧 >0.02 达 ${div.daysGt02}/${pick(input, 'dualTrack.sample.days') ?? '?'} 天，0.02/0.03 告警阈值仍是 [待确认] 状态`, action: '提议进入确认流程，非本模块职责' }]
    : [];
  const extra = [];
  if (missingDays) extra.push({ field: 'week_return / max_drawdown_week', reason: `本周 ${missingDays} 个交易日 dayReturns.A 缺失，按 0 跳过（缺失不补 0，但复利口径如实披露跳过日数）`, ref: 'data/paper/dual_track.json::days' });
  return envelope({
    type: 'weekly',
    trigger: opts.trigger || 'schedule',
    date: tradeDate,
    generatedAt: opts.generatedAt || new Date().toISOString(),
    generatedBy: opts.generatedBy,
    payload,
    input,
    extraNotes: extra,
    sourceOverrides: overrides,
    simulationStock: opts.simulationStock ?? null,
  });
}

// ── 双轨合并（决议 1：generated_at 去重，即时轨一等公民，null 回填）──────
/**
 * 同 report_type+date 的两轨报告合并：
 *   · 基座 = generated_at 较新者；同刻即时轨（browser）优先；
 *   · 基座 null 字段从较旧轨回填（data_completeness 标注回填来源）；
 *   · missing_notes 按 field 去重合并；data_health.sources 就宽合并。
 * 纯函数：不改输入对象。
 */
export function mergeReports(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const newer = (x, y) => {
    if (x.generated_at !== y.generated_at) return x.generated_at > y.generated_at ? x : y;
    return x.generated_by === 'browser' ? x : y; // 同刻即时轨优先（一等公民）
  };
  const base = newer(a, b);
  const older = base === a ? b : a;
  const mergedPayload = { ...older.payload };
  const backfilled = [];
  for (const [k, v] of Object.entries(base.payload)) {
    if (v == null && older.payload && older.payload[k] != null) {
      mergedPayload[k] = older.payload[k];
      backfilled.push(k);
    } else mergedPayload[k] = v;
  }
  const noteFields = new Set((base.missing_notes || []).map((n) => n.field));
  const missingNotes = [...(base.missing_notes || []), ...(older.missing_notes || []).filter((n) => !noteFields.has(n.field))];
  const sources = { ...(older.data_health?.sources || {}), ...(base.data_health?.sources || {}) };
  const overrides = {};
  for (const k of backfilled) overrides[k] = older.generated_by === 'browser' ? 'live' : 'archived';
  return {
    ...base,
    data_health: { sources },
    data_completeness: buildDataCompleteness(mergedPayload, overrides),
    payload: mergedPayload,
    missing_notes: missingNotes,
    merged_from: [base.generated_by, older.generated_by],
    backfilled_fields: backfilled,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 模拟选股层（S1.5 · 2026-10-06 决议 7/8 + 用户 S1.5 指令）
//
// 定位：只输出候选池、情绪判断、资金旁注、交易剧本与绑定记录，
//   不自动下单、不替代实盘决策、不保证候选上涨（非目标铁律）。
//   剧本是本模块的**生成物**（模板，script_source: 'template'），非信号。
//
// 判据矛盾裁决（显式披露）：S1.5 指令正文写"分位 <50 且 up 为启动"，但同指令
//   的示例要求 09-30（recover·分位 44.1·up）为**发酵期**——两者互斥。按已拍板
//   决议 7 的 v1.1 判据（<30 为启动）实现，与示例一致；阈值提取为
//   STARTUP_PCT_RANK_MAX 常量，一行可改。
// ═══════════════════════════════════════════════════════════════════════

/** ISO 周周一（纯日期运算，浏览器安全；S2 周报 week-start 推导）：'2026-09-30' → '2026-09-28'。 */
export function isoWeekStart(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // 回退到周一（0=周日 → 6 天）
  return d.toISOString().slice(0, 10);
}

// 五期英文枚举 → 中文标签（phase 保持英文枚举不动、phase_label 承载中文——
// 2026-10-06 用户拍板：契约稳定性优先；regime_raw 保留七态原始值供复盘追溯——决议 7）
export const PHASE_LABELS = { startup: '启动期', fermentation: '发酵期', climax: '高潮期', decline: '退潮期', freezing: '冰点期' };
export const PHASE_ENUM = Object.keys(PHASE_LABELS);
export const STARTUP_PCT_RANK_MAX = 30; // recover 细分阈值（矛盾裁决见上）
export const POSITION_SUGGESTION_ENUM = ['aggressive', 'neutral', 'defensive', 'wait'];
export const BINDINGS_KEY = 'airpt_sim_bindings_v1'; // 独立 localStorage key，不动现有账本 key

// 剧本模板参数（唯一出处；除前两个复用系统常量外均为模板结构参数，非风控规则）
export const SIM_SCRIPT_CONSTS = {
  hard_stop_loss: HARD_STOP_LOSS,        // -0.08（src/paper.js 系统常量，复用）
  take_profit_a_multiple: 2,             // A 剧本止盈 = 2×|止损|（指令指定）
  script_c_stop_loss: -0.05,             // C 剧本止损 -5%（S1.5 指令指定；剧本模板参数，非系统风控常量）
  b_position_factor: 0.5,                // B 剧本 = cap×0.5（半仓试探）
  c_position_factor: 0.2,                // C 剧本 = cap×0.2（轻仓反核）
  pool_max: 10,                          // 候选池上限（5-10 只，指令口径）
  pool_min: 5,
};

/**
 * 五期映射（决议 7 · 翻译层，判据唯一出处）。
 *   recover + pct_rank<30 + up → startup；其余 recover → fermentation；
 *   climax→climax、ebb→decline、ice→freezing；
 *   shift/unknown/其他 → phase 原样透出系统 key、phase_label=null（不硬塞五期，
 *   由调用侧进 warning_signals）。
 * @param {string} regime 七态 key（dualTrack.day.regime.key / signals.regime.latest.key）
 * @param {{pct_rank:number|null, dir:string|null}} substate 分位与方向（signals.regime.latest）
 * @returns {{phase:string, phase_label:string|null, regime_raw:string}}
 *   phase 英文枚举（契约稳定键）+ phase_label 中文（展示）+ regime_raw 七态原值（追溯）。
 *   四字段自洽不变式（单测锁定）：phase∈PHASE_ENUM ⇔ phase_label===PHASE_LABELS[phase]，
 *   且 regime_raw 恒等于入参原值（翻译层不丢信息）。
 */
export function mapPhase(regime, substate = {}) {
  const raw = regime ?? 'unknown';
  const pct = Number.isFinite(substate?.pct_rank) ? substate.pct_rank : null;
  const dir = substate?.dir ?? null;
  const out = (phase) => ({ phase, phase_label: PHASE_LABELS[phase] ?? null, regime_raw: raw });
  if (raw === 'recover') {
    const startup = pct != null && pct < STARTUP_PCT_RANK_MAX && dir === 'up';
    return out(startup ? 'startup' : 'fermentation');
  }
  const direct = { climax: 'climax', ebb: 'decline', ice: 'freezing' }[raw];
  if (direct) return out(direct);
  return { phase: raw, phase_label: null, regime_raw: raw }; // shift / unknown / 未识别 → 原样透出，无五期标签
}

/** 仓位建议映射（regime cap 的翻译，非新增风控规则；§9.2）。 */
export function mapPositionSuggestion(cap, phase) {
  if (!Number.isFinite(cap)) return 'wait';
  if (cap >= 0.7) return 'aggressive';
  if (cap >= 0.5) return 'neutral';
  if (cap >= 0.3) return 'defensive';
  return 'wait'; // cap≤0.2；映射外 phase 由调用方在 warning_signals 披露，仓位仍按帽
}

/**
 * A/B/C 三剧本模板（唯一出处；阈值全部来自 SIM_SCRIPT_CONSTS，不引入散落魔数）。
 *   A 顺势：高开/放量突破 → cap 仓位，止损 HARD_STOP_LOSS，止盈 2×止损；
 *   B 分歧：平开震荡 → 半仓试探，止损为条件位（破 5 日线，数字不可预知 → null，条件写进文本）；
 *   C 核按钮：低开/竞价弱 → 轻仓反核或观望，止损 -5%（指令指定）。
 * B/C 止盈指令未给数值 → null（条件文本描述），不造数。
 * @param {{code:string}} stock 候选股（code 仅用于剧本文本定位）
 * @param {{regimeCap:number}} ctx cap（dualTrack.day.regime.cap）
 */
export function buildScripts(stock, ctx = {}) {
  const cap = Number.isFinite(ctx.regimeCap) ? ctx.regimeCap : 0;
  const c = SIM_SCRIPT_CONSTS;
  const mk = (name, trigger_condition, position_ratio, stop_loss, take_profit, invalid_condition) => ({
    name, trigger_condition, position_ratio: Math.round(position_ratio * 1000) / 1000,
    stop_loss, take_profit, invalid_condition, script_source: 'template',
  });
  return [
    mk('A', `高开 >2% 或放量突破昨收上沿（${stock.code}，即时轨实时价判定）`,
      cap, c.hard_stop_loss, Math.abs(c.hard_stop_loss) * c.take_profit_a_multiple,
      '低开 >3% 或午前跌破昨收 -2%'),
    mk('B', '平开震荡：回踩 5 日线缩量企稳（即时轨实时价判定）',
      cap * c.b_position_factor, null, null, '放量跌破 5 日线（止损为条件位，非固定百分比，故 stop_loss=null 不造数）'),
    mk('C', '低开/竞价弱：观望或轻仓反核（情绪冰点逆势位）',
      cap * c.c_position_factor, c.script_c_stop_loss, null, '断板次日翻绿或 seats 转机构撤离'),
  ];
}

/** 基本面八字段 null 占位（决议 8：键常驻，后续接数据源直接填充，不改 schema）。 */
export function emptyFundamentals() {
  return {
    roe: null, revenue_growth: null, net_profit_growth: null,
    pe: null, pb: null, peg: null, market_cap: null, moat_note: null,
  };
}

/**
 * 候选池现算（决议 8 口径）：pain.advance.detail（连板活跃明细）按连板数降序取 5-10 只。
 *   · selection_reason 必填（连板数+当日涨跌+晋级结果，全部真实字段，复盘归因用）；
 *   · themes/fundamentals null 占位；name 经 opts.nameMap（paper_universe.symbols）注入，缺则 null；
 *   · 资金流向仅席位级真实数据作 fund_flow_note，个股级主力资金 null；
 *   · risks 只填系统可验证项（晋级失败率/大面/席位属性），解禁减持业绩雷不编造；
 *   · opts.intradayHot（S2）：{code: 盘中涨幅%} 映射（intraday.json::hot.rows 的 change_pct），
 *     注入则逐股填 intraday_chg——**不在强势榜 = null（不是 0）**，缺席与不涨严格区分。
 * @param {object} signals signals-latest.json
 * @param {{nameMap?:object, regimeCap?:number, seatNote?:string, advanceFailRate?:number, intradayHot?:object}} opts
 */
export function buildCandidatePool(signals, opts = {}) {
  const detail = Array.isArray(signals?.pain?.advance?.detail) ? signals.pain.advance.detail : [];
  const rows = [...detail].sort((a, b) => (b.lb ?? 0) - (a.lb ?? 0)).slice(0, SIM_SCRIPT_CONSTS.pool_max);
  if (!rows.length) return [];
  const failRate = Number.isFinite(opts.advanceFailRate) ? opts.advanceFailRate : Number.isFinite(signals?.pain?.advance?.failRate) ? signals.pain.advance.failRate : null;
  const seatNote = opts.seatNote ?? (signals?.seats?.verdict ? `${signals.seats.verdict.label}（席位级：instNet/northNet/hotNet 真值；个股级主力净流入系统无数据）` : null);
  const pool = rows.map((r) => {
    const meta = opts.nameMap?.[r.code] ?? null;
    const kept = r.kept ? '晋级成功' : '晋级失败';
    const hot = opts.intradayHot ? opts.intradayHot[r.code] : undefined;
    return {
      code: r.code,
      name: meta?.name ?? null,
      themes: null, // 题材标签无个股级数据源（momentum.fresh 只有题材名无成分股）
      selection_reason: `${r.lb} 连板（当日 ${r.chg}%，${kept}${meta?.appearances ? `，近期上榜 ${meta.appearances} 次` : ''}）`,
      intraday_chg: hot === undefined ? null : Number.isFinite(hot) ? hot : null, // S2：不在强势榜 = null ≠ 0
      fundamentals: emptyFundamentals(),
      fund_flow_note: seatNote,
      scripts: buildScripts({ code: r.code }, { regimeCap: opts.regimeCap ?? 0 }),
      risks: [
        r.kept ? `${r.lb} 板高位，连板晋级失败率 ${failRate != null ? `${Math.round(failRate * 100)}%` : '未知'}` : `昨日 ${r.lb} 板已晋级失败（chg ${r.chg}%），反核属逆势剧本`,
      ],
    };
  });
  return pool;
}

/**
 * 模拟选股段组装（sentiment_cycle + 仓位建议 + 候选池 + 模拟持仓 + 复盘占位）。
 *   即时轨（input.live）才填 simulation_positions（paperAccount.positions）；
 *   review 首期 null（复盘归因 S3 录入后才有数据，不造数）。
 * @param {object} input buildInput 产物
 * @param {{nameMap?:object, bindings?:Array}} opts paper_universe.symbols 注入（CI 侧读取）；
 *   bindings = loadBindings 读出的绑定记录（当日 code→script_name 联查填持仓跟踪，读取由调用方完成）
 */
export function buildSimulationStock(input, opts = {}) {
  const regimeKey = pick(input, 'dualTrack.day.regime.key') ?? pick(input, 'signals.regime.latest.key');
  const sub = pick(input, 'signals.regime.latest') ?? {};
  const { phase, phase_label, regime_raw } = mapPhase(regimeKey, { pct_rank: sub.pct_rank, dir: sub.dir });
  const cap = pick(input, 'dualTrack.day.regime.cap');
  const zt = pick(input, 'signals.latest.zt_count');
  const zb = pick(input, 'signals.latest.zb_count');
  const brokenRatio = Number.isFinite(zt) && Number.isFinite(zb) && zt + zb > 0 ? zb / (zt + zb) : null;
  const warnings = [];
  const painReason = pick(input, 'signals.pain.verdict.reason');
  if (painReason) warnings.push(painReason);
  const bigLoss = pick(input, 'signals.pain.bigLoss.list');
  if (Array.isArray(bigLoss) && bigLoss.length) warnings.push(`大面 ${bigLoss.length} 只：${bigLoss.map((b) => `${b.name} ${b.chg}%`).join('、')}`);
  const breadthDetail = pick(input, 'signals.breadth.snapshot.verdict.detail');
  if (breadthDetail) warnings.push(`宽度收窄（${breadthDetail}）`);
  if (phase === regime_raw && phase_label == null) warnings.push(`情绪周期映射外状态 ${regime_raw} 原样透出（不硬塞五期，决议 7）`);
  const sentiment_cycle = {
    phase,
    phase_label,
    regime_raw,
    phase_source: `regime=${regimeKey} · 分位 ${Number.isFinite(sub.pct_rank) ? sub.pct_rank : '未知'} · 方向 ${sub.dir ?? '未知'}${regimeKey === 'recover' ? `（recover 细分阈值 <${STARTUP_PCT_RANK_MAX} 为启动期）` : ''}`,
    limit_up_count: num(zt),
    highest_chain: num(pick(input, 'signals.pain.advance.maxLb')),
    broken_limit_ratio: brokenRatio,
    yesterday_chain_performance: num(pick(input, 'signals.pain.perf.avg')),
    warning_signals: warnings,
  };
  const pool = buildCandidatePool(input.signals, { nameMap: opts.nameMap, regimeCap: cap, intradayHot: opts.intradayHot });
  let simulation_positions = null;
  if (input.live && input.paperAccount?.positions) {
    // 绑定联查（读写职责边界）：绑定写入由 S3 前端 UI 在用户确认剧本时触发
    // （saveBindings 仅为 UI 复用的工具函数，本模块生成流程只读不写）；
    // 此处用调用方注入的 bindings（loadBindings 产物）按当日 code 联查，
    // 同日同股多条绑定取首条（UI 一次只确认一个剧本）。
    const bindings = Array.isArray(opts.bindings) ? opts.bindings : [];
    simulation_positions = Object.values(input.paperAccount.positions).map((p) => ({
      code: p.code, name: p.name ?? null, cost_price: num(p.avgCost), current_price: num(p.last),
      volume: num(p.qty), unrealized_pnl: num((p.last - p.avgCost) * p.qty), holding_days: num(p.days),
      script_name: bindings.find((b) => b && b.date === input.tradeDate && b.code === p.code)?.script_name ?? null,
      stop_loss_triggered: null, take_profit_triggered: null, // 触发回放依赖盘中实时价采样（S3 接线），首期 null 不造数
    }));
  }
  return {
    sentiment_cycle,
    position_suggestion: mapPositionSuggestion(cap, phase),
    pool_basis: 'pain.advance.detail 连板活跃明细按连板数降序（情绪面规则现算，决议 8：人工输入模式的辅助建议，可一键采纳不自动生效）',
    candidate_pool: pool,
    simulation_positions,
    review: null, // 复盘归因 S3 录入后才有数据；win_rate 口径 = 剧本命中/总执行（决议 4），缺席恒 null
  };
}

// ── 绑定记录（决议 6：人工输入 + 系统记录；独立 key，不动现有账本）────────
/**
 * 构造一条绑定记录（纯函数，不碰 storage）。
 * @returns {{date:string, code:string, script_name:string, note:string, bound_at:string}}
 */
export function makeBinding({ date, code, script_name, note = '', boundAt = new Date().toISOString() }) {
  if (!date || !code || !script_name) throw new Error('绑定记录必须含 date/code/script_name（人工输入三要素）');
  return { date, code, script_name, note, bound_at: boundAt };
}

/**
 * 绑定列表合并（幂等：同 date+code+script_name 不重复追加，返回新数组）。
 * @param {Array} list 现有绑定（可 null）
 * @param {object} binding makeBinding 产物
 */
export function mergeBindings(list, binding) {
  const arr = Array.isArray(list) ? list : [];
  const dup = arr.some((b) => b && b.date === binding.date && b.code === binding.code && b.script_name === binding.script_name);
  return dup ? arr : [...arr, binding];
}

/** 读绑定（storage 注入：浏览器传 localStorage，Node 测试传 mock；坏 JSON → 空表，不 throw）。 */
export function loadBindings(storage) {
  try {
    const raw = storage?.getItem?.(BINDINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/**
 * 写绑定（storage 注入，同上）。职责边界（2026-10-06 拍板）：写入时机由 S3 前端
 * UI 在用户确认剧本时触发调用；本模块的报告生成流程只读（loadBindings）不写，
 * makeBinding/mergeBindings/saveBindings 仅为 UI 层复用的纯函数工具。
 */
export function saveBindings(storage, bindings) {
  storage?.setItem?.(BINDINGS_KEY, JSON.stringify(bindings));
  return bindings;
}

/**
 * 模拟导出（复用 exportAccount 机制，指令第 4 条）：账户导出串 + 绑定记录合并为一份 JSON。
 * @param {object} acct 模拟账户（src/paper.js 账本）
 * @param {Array} bindings 绑定记录列表
 * @returns {string} JSON（{ account: <exportAccount 反解>, bindings, exported_at }）
 */
export function exportSimulation(acct, bindings) {
  let account = null;
  try { account = JSON.parse(exportAccount(acct)); } catch (e) { account = { error: `账户导出失败：${e.message}` }; }
  return JSON.stringify({ account, bindings: Array.isArray(bindings) ? bindings : [], exported_at: new Date().toISOString() });
}
