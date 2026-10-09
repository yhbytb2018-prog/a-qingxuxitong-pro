// ─────────────────────────────────────────────────────────────────────────────
// S3-4 AI 盘中报告卡 · 实时装配（生成器复用路线 · 纯装配层）────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// 职责：把「6 个归档数据源 + __intradayLive 桥」喂给 buildInput + generateIntraday
// （src/ai_report.js，信封唯一出处），产出与 CI 归档报告**同一生成器、同一形态**的
// 实时报告信封。卡片与推送收到的报告天然同构——不是"字段对齐"，是同一份代码。
//
// 数据源（与 scripts/build_ai_report.mjs 的读档面一致，按 intraday 报告消费裁剪）：
//   ① data/paper/dual_track_latest.json   dualTrack   轨道结构/summary/regime/估值锚
//   ② data/signals-latest.json            signals     tradeDate/regime.turns/market_context
//   ③ data/global.json                    global      A50/费半（overseas 段）
//   ④ data/backtest.json                  backtest    v52 锚点（backtest_deviation）
//   ⑤ data/ops-alerts-latest.json         opsAlerts   events（circuit_breaker 段）
//   ⑥ data/intraday.json                  intraday    live 轨数值零消费，仅 data_health 同构
//   （dualTrackDays 被排除：grep 实证 intraday 报告零消费，省 205KB）
// 第 7 输入 paperAccount 不 fetch——桥 __intradayLive.account（内存，S3-1 形态对齐产物）。
//
// 降级纪律（决议：不拼凑）：
//   ① 任一源 fetch 失败 → buildLiveReport 整体返回 null，卡片保持归档渲染——
//     绝不部分成功部分失败地拼凑，健康面要么全真要么全归档；
//   ② 桥缺席（非盘中/锚未就绪/实时行情降级）→ null（待采样，不冒充）；
//   ③ 缓存失败不清除——旧缓存下次重试仍可用（本次已整体降级，无拼凑）。
//
// 缓存口径（交易日键 + 30 分钟 TTL）：
//   ①~⑤ 盘后落库盘中不变 → 拉取成功后按「当天日期键」缓存整天，跨日即重拉；
//   ⑥ CI 每 30 分钟快照 → 独立 30 分钟 TTL；
//   日期口径 todayStr() 与采样器序列键同源（UTC 日期，见 intraday_sampler.js）。
import { buildInput, generateIntraday } from './ai_report.js';

/** ⑤ 源之外的 intraday.json 独立缓存时长（对齐 CI 快照周期 30 分钟） */
export const INTRADAY_TTL_MS = 30 * 60 * 1000;

/** 日源（①~⑤，整天缓存） */
const DAY_SOURCES = [
  ['dualTrack', 'data/paper/dual_track_latest.json'],
  ['signals', 'data/signals-latest.json'],
  ['global', 'data/global.json'],
  ['backtest', 'data/backtest.json'],
  ['opsAlerts', 'data/ops-alerts-latest.json'],
];

// 模块级缓存（浏览器页面生命周期；单测经 resetReportCardCache 复位）
let dayCache = null;      // { dayKey, data: {dualTrack, signals, global, backtest, opsAlerts} }
let intradayCache = null; // { at, data }

/** 复位源缓存（单测隔离用；生产不调） */
export function resetReportCardCache() { dayCache = null; intradayCache = null; }

/** 浏览器默认取档：no-store 直读（缓存由本模块自管，不走 HTTP 缓存语义） */
const defaultGetJson = async (url) => {
  const res = await fetch(url + '?_=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return res.json();
};

/**
 * 组装实时报告信封（生成器复用：buildInput + generateIntraday，信封唯一出处）。
 * @param {object} live            桥 window.__intradayLive（须含 account/stats/drawdownDaily）
 * @param {object} [io]            注入口（单测用；生产全默认）
 * @param {Function} [io.getJson]  async (url) => json；默认浏览器 fetch
 * @param {Function} [io.now]      () => ms；默认 Date.now
 * @param {Function} [io.today]    () => 'YYYY-MM-DD'；默认 UTC 日期（与采样器同源）
 * @returns {Promise<object|null>} generateIntraday 信封；任一源失败/桥缺席 → null（整体降级）
 */
export async function buildLiveReport(live, io = {}) {
  const getJson = io.getJson || defaultGetJson;
  const now = io.now || (() => Date.now());
  const today = io.today || (() => new Date().toISOString().slice(0, 10));
  if (!live || !live.account || typeof live.account !== 'object') return null; // 桥缺席 → 待采样

  const dayKey = today();
  const needDay = !dayCache || dayCache.dayKey !== dayKey; // 跨日（或首拉）→ 5 日源重拉
  const needIntraday = !intradayCache || now() - intradayCache.at > INTRADAY_TTL_MS;

  // 并行拉齐（用户决议：任一失败整体降级，不拼凑）
  if (needDay || needIntraday) {
    const jobs = [];
    const keys = [];
    if (needDay) for (const [k, url] of DAY_SOURCES) { jobs.push(getJson(url)); keys.push(k); }
    if (needIntraday) { jobs.push(getJson('data/intraday.json')); keys.push('__intraday__'); }
    let results;
    try {
      results = await Promise.all(jobs);
    } catch {
      return null; // 整体降级：缓存原样保留（本次未消费任何新数据，无拼凑）
    }
    const next = needDay ? { dayKey, data: {} } : null;
    results.forEach((v, i) => {
      const k = keys[i];
      if (k === '__intraday__') intradayCache = { at: now(), data: v };
      else next.data[k] = v;
    });
    if (next) dayCache = next;
  }

  const input = buildInput({
    ...dayCache.data,
    intraday: intradayCache.data,
    paperAccount: live.account,
  });
  return generateIntraday(input, {
    drawdownDaily: live.drawdownDaily,
    stats: live.stats,
    generatedBy: 'browser',
    trigger: 'schedule',
  });
}

/**
 * 信封 → 卡片展示数据（纯投影，零计算；归档信封与实时信封同过此函数，
 * 卡片渲染层只认这一个形态——"推送层/渲染层无需区分"由形态统一保证）。
 * @param {object} env generateIntraday / CI 落库报告信封
 * @returns {object|null} 卡片数据；入参非法 → null
 */
export function cardData(env) {
  if (!env || typeof env !== 'object' || !env.payload) return null;
  const p = env.payload;
  const dd = p.drawdown_vs_threshold || {};
  return {
    date: p.date ?? null,
    generatedAt: env.generated_at ?? null,
    generatedBy: env.generated_by ?? null,
    status: p.status ?? null,
    navRealtime: p.nav_realtime ?? null,
    maxDrawdownDaily: p.max_drawdown_daily ?? null,
    pnlDaily: p.pnl_daily ?? null,
    pnlCumulative: p.pnl_cumulative ?? null,
    ddNow: dd.dd_now ?? null,
    tierEdges: dd.tier_edges ?? null,
    distancePp: dd.distance_pp ?? null,
    basis: dd.basis ?? null,
    trendSwitchHits: p.trend_switch_hits ?? null,
    overseas: p.overseas ?? null,
    missingNotes: Array.isArray(env.missing_notes) ? env.missing_notes : [],
    // generated_by 'browser' = 浏览器即时估值轨 → 卡面必须标注"估值非结算"
    isValuation: env.generated_by === 'browser',
  };
}
