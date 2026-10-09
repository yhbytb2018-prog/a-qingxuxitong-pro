// ─────────────────────────────────────────────────────────────────────────────
// S3-1 即时轨数据源（纯函数，浏览器与 Node 共用 · 零 DOM / 零 Node API）──────
// ─────────────────────────────────────────────────────────────────────────────
// 职责：把「轨道 A 估值锚（dual_track_latest.json::intraday_valuation）+ 指数
// 实时涨幅」合成为 accountStats 形态对齐的 live 账本，供 generateIntraday 的
// input.live 分路消费（S1 预留：nav_realtime / dd_now / basis 双口径）。
//
// 估值口径（两端单测锁死；生产方 tools/backtest/paper_dual_track.mjs 落锚）：
//   轨道 A 是账户级仓位模拟（指数池 × targetPos，无个股持仓），当日日内权益 =
//     equity_prev × (1 + Σ pos_today[name] × 指数实时涨幅% ÷ 池资产数)
//   —— 与归档轨日收益（Σ targetPos × rets ÷ N，收盘对收盘）同一结构的日内推进，
//   不含换仓成本（成本已在 equity_prev 的累乘里，targetPos 当日恒定无换仓）。
//   这是**估值非结算**（basis 如实标注）；锚定最近落库日的执行面。
//
// accountStats 形态对齐（src/paper.js）：
//   合成持仓法——positions.__PORTFOLIO__ = { qty: 1, last: 实时权益 }，cash 0 →
//   accountStats 算出 total = 实时权益、peak = max(init_cash, nav 历史, total)
//   （历史峰值含今日盘中新高）、drawdown = 总回撤实时版。nav 末点 = 今日实时点
//   → ai_report.js live 段的 pnl_daily（今日 vs 昨收）与 nav_realtime 自动就位。
//
// 当日序列：浏览器采样器每分钟追加一个权益点（localStorage 当日键，跨日重置），
//   dailyDrawdown() 给「当日相对日内高点回撤」（S3-1 第二步 max_drawdown_daily）。
// 降级纪律：任一池资产实时涨幅缺失 → 整体 null（不冒充，不兜底填充）。
import { accountStats, DD_TIERS } from './paper.js';

/** 合成持仓代码（accountStats 兼容形态的唯一虚拟标的，不出现在任何真实行情里） */
export const PORTFOLIO_CODE = '__PORTFOLIO__';

/** 风控档边沿（升序），派生自 src/paper.js::DD_TIERS——与 ai_report.js::DD_TIER_EDGES
 *  同源（单测锁死逐项一致），页面快照卡与报告的"距风控档"永远同尺。 */
const DD_EDGES = DD_TIERS.map((t) => t.threshold).filter((t) => t > 0).sort((a, b) => a - b);

/**
 * 距下一档风控线的距离（与 generateIntraday::drawdown_vs_threshold.distance_pp 同构，小数口径）。
 * @param {number} drawdown  总回撤实时版（0~小数）
 * @returns {number | null}  nearest_edge − drawdown；越过全部档位 → 负值（最深档之上）；
 *   入参非法 → null。DD_TIERS 定义变更时同步（单测对齐 ai_report）。
 */
export function riskTierDistance(drawdown) {
  if (drawdown == null || !Number.isFinite(+drawdown) || +drawdown < 0) return null; // null 前置：+null===0 会把缺失当零回撤
  const dd = +drawdown;
  const nearest = DD_EDGES.find((e) => e >= dd) ?? DD_EDGES[DD_EDGES.length - 1];
  return nearest - dd;
}

/** 当日权益序列的 localStorage 键前缀（完整键 = 前缀 + YYYY-MM-DD，跨日即换键自然重置） */
export const SERIES_KEY_PREFIX = 'asent-ilv-';

/** 日期 → 当日序列键（'2026-10-08' → 'asent-ilv-2026-10-08'）。入参非法返回 null。 */
export function seriesKey(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return SERIES_KEY_PREFIX + date;
}

const fin = (v) => Number.isFinite(+v);
const num = (v) => (fin(v) ? +v : null);

/**
 * 盘中实时估值。
 * @param {object} p
 * @param {number} p.equityPrev  最近落库日收盘权益（元）
 * @param {Record<string, number>} p.posToday  每资产目标仓位（intraday_valuation.pos_today）
 * @param {Record<string, {pct?: number}>} p.quotes  每资产实时报价（腾讯口径 pct = 涨跌幅%，如 1.23 = +1.23%）
 * @returns {{ equity: number, dayRet: number } | null}  equity=实时权益（元），
 *   dayRet=当日实时收益率（0~小数）。任一资产 pct 缺失/非法 → null（不冒充）。
 */
export function intradayEquity({ equityPrev, posToday, quotes }) {
  const base = num(equityPrev);
  if (base == null || base <= 0 || !posToday || typeof posToday !== 'object') return null;
  const names = Object.keys(posToday);
  if (!names.length) return null;
  let weighted = 0;
  for (const name of names) {
    const pct = num(quotes?.[name]?.pct);
    if (pct == null) return null; // 任一资产缺实时涨幅 → 整体不估（降级纪律）
    weighted += (fin(posToday[name]) ? +posToday[name] : 0) * (pct / 100);
  }
  const dayRet = weighted / names.length; // 池等权（与归档轨 Σ targetPos×ret ÷ N 同构）
  return { equity: base * (1 + dayRet), dayRet };
}

/**
 * accountStats 形态对齐的 live 账本组装（合成持仓法，见文件头注释）。
 * @param {object} p
 * @param {{date: string, equity: number}[]} p.navSeries  全史日权益（intraday_valuation.nav_series，元口径）
 * @param {number} p.equityRealtime  当日实时权益（intradayEquity().equity）
 * @param {string} p.tradeDate  交易日（YYYY-MM-DD，nav 末点日期）
 * @param {number} p.initCash  元口径基期（intraday_valuation.init_cash）
 * @returns {object | null}  accountStats 可直接消费的账本；入参非法 → null
 */
export function buildLiveAccount({ navSeries, equityRealtime, tradeDate, initCash }) {
  const eq = num(equityRealtime);
  const cash0 = num(initCash);
  if (eq == null || eq <= 0 || cash0 == null || cash0 <= 0
    || typeof tradeDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)
    || !Array.isArray(navSeries) || !navSeries.length) return null;
  const nav = navSeries
    .filter((s) => s && typeof s.date === 'string' && fin(s.equity))
    .map((s) => ({ date: s.date, equity: +s.equity }));
  if (!nav.length) return null;
  // nav 末点若已是 tradeDate（收盘后重放落库当日），不重复追加实时点
  if (nav[nav.length - 1].date !== tradeDate) nav.push({ date: tradeDate, equity: eq });
  return {
    initCash: cash0,
    cash: 0,
    freeze: 0,
    positions: { [PORTFOLIO_CODE]: { code: PORTFOLIO_CODE, name: '轨道A组合（指数池×仓位）', qty: 1, last: eq, avgCost: cash0, cost: cash0 } },
    nav,
  };
}

/** buildLiveAccount 产物的静态快照（等价 accountStats，便捷/测试两用） */
export function liveAccountStats(account) {
  return accountStats(account);
}

/**
 * 当日权益序列追加（纯函数：返回新数组）。
 * 跨日（sampleDate ≠ 序列首点日期）→ 重置为单点新序列（当日键自然隔离的兜底防线）。
 * @param {{date: string, ts: number, equity: number}[]} series
 * @param {{date: string, ts: number, equity: number}} sample
 */
export function appendSample(series, sample) {
  const arr = Array.isArray(series) ? series.filter((s) => s && fin(s.equity)) : [];
  if (!sample || !fin(sample.equity) || typeof sample.date !== 'string') return arr;
  if (arr.length && arr[0].date !== sample.date) arr.length = 0; // 跨日重置
  arr.push({ date: sample.date, ts: num(sample.ts) ?? Date.now(), equity: +sample.equity });
  return arr;
}

/**
 * 序列持久化还原（localStorage 读出后的校验层：键不符/坏档 → 空序列重新开始）。
 * @param {unknown} stored  JSON.parse 后的任意值
 * @param {string} key  期望的当日序列键（seriesKey() 产物）
 */
export function deserializeSeries(stored, key) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return [];
  if (stored.key !== key || !Array.isArray(stored.samples)) return [];
  return stored.samples.filter((s) => s && typeof s.date === 'string' && fin(s.equity));
}

/**
 * 当日相对日内高点的回撤（S3-1 第二步 max_drawdown_daily 的数据面）。
 * @param {{equity: number}[]} series  当日权益序列
 * @returns {number | null}  (dayHigh − now) ÷ dayHigh，≥0；不足两点或空 → null（不冒充）
 */
export function dailyDrawdown(series) {
  const arr = (Array.isArray(series) ? series : []).filter((s) => s && fin(s.equity));
  if (arr.length < 2) return null; // 单点无回撤语义
  const high = Math.max(...arr.map((s) => +s.equity));
  const now = +arr[arr.length - 1].equity;
  if (!(high > 0)) return null;
  return Math.max(0, (high - now) / high);
}
