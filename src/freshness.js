// 数据新鲜度：把「数据是否滞后」从粘滞的失败标记，改为按交易日历可计算的状态。
//
// 背景（旧口径的两个毛病，都由真实故障暴露）：
//   1) meta.stale 被当作「上一次尝试是否失败」的标记：只在回退路径置 true，
//      成功路径重建 meta 时才会清掉。若某次回退之后，后续运行只是「跳过」
//      （龙虎榜未公布 → main() 直接 return null，不写存档），stale 会一直粘着，
//      页面长期误报「数据滞后」——而数据其实已是最新收盘会话。
//   2) 「正常等待」（今天数据还没到发布时间）与「真滞后」（预期时间已过仍没更）
//      被混成同一句话，用户无法判断要不要管。
//
// 新口径按三条状态判定（均为纯函数，便于测试与跨端一致）：
//   fresh   存档交易日 ≥ 最近一个已收盘交易日 → 展示的就是最新已收盘会话
//   pending 落后 1 个交易日，但预期更新时刻还没到 → 正常等待（18:30 首抓 / 21:00 补抓）
//   behind  已过预期更新时刻仍然落后 → 真滞后，需要告警
//
// 「预期更新时刻」= 该交易日之后第一个交易日的 PUBLISH_HHMM（北京时区）。
// 用绝对时间戳下发，前端无需交易日历即可与本地时钟比较，也不受时区影响。
import { isTradingDay } from './util.js';
import { bjDate, bjTime, bjInstant } from './time.js';

export const MARKET_CLOSE = '15:00'; // 收盘时刻，用于判定「当日是否已收盘」
export const MARKET_OPEN = '09:30';  // 连续竞价开始（集合竞价 09:15~09:25 不产生有效盘中快照）
export const PUBLISH_HHMM = '19:30'; // 某交易日数据应已落库的兜底时刻（18:30 首抓 + 1h 余量）

// ── 盘中/盘后相位（与 freshness.state 正交，不可互相替代）──────────────────────
//
// 为什么单独要一个 phase：
//   freshness.state 回答的是「**存档** 是不是最新的已收盘会话」（数据滞后与否）；
//   phase 回答的是「**现在这个时刻**市场处在什么阶段」。两者语义完全不同，且会同时出现在
//   同一份页面上——盘中 10:30 时，存档仍是昨天收盘的（若尚未跑盘中快照，state=pending），
//   但 markets 正在交易、push2ex 涨跌停池与同花顺强势股都**已经有当日数据**。
//   把两者混成一句话，读者就无法判断「现在看到的是不是实时」。
//
// 三态：
//   pre     交易日开盘前（00:00~09:30）——今日行情尚未产生，页面应显示「昨收」口径
//   live    交易日盘中（09:30~15:00）——盘中数据可得（快照 cron 每 30 分钟刷），但**分位与因子未重算**
//   closed  收盘后（15:00~24:00）或非交易日——当日已定盘
//
// ⚠ 关键纪律：phase=live 时，页面**必须显著标注「盘中快照，分位/因子为上一收盘值」**。
//   盘中拿实时涨跌家数去和「按收盘值算的分位」比较，会得出"情绪分突然跳变"的假信号——
//   这不是数据错，是把两个不同时点的量放进了同一个尺度。故 meta.phase 必须成对携带
//   meta.phaseNote（口径说明），由前端如实展示。
export const PHASE_NOTE = {
  pre: '开盘前：今日行情尚未产生，下方为上一交易日收盘口径',
  live: '盘中：行情为实时快照，情绪分/分位/因子仍为上一收盘日口径（未重算），不要把实时涨跌家数与收盘分位对比',
  closed: '收盘后：当日已定盘，各项指标为收盘口径',
};

/** 北京时区当前相位。非交易日恒为 closed（无盘中概念）。 */
export function marketPhase(now = new Date(), holidays = []) {
  const today = bjDate(now);
  if (!isTradingDay(today, holidays)) return { phase: 'closed', isTradingDay: false, bjDate: today, bjTime: bjTime(now) };
  const t = bjTime(now);
  let phase;
  if (t < MARKET_OPEN) phase = 'pre';
  else if (t < MARKET_CLOSE) phase = 'live';
  else phase = 'closed';
  return { phase, isTradingDay: true, bjDate: today, bjTime: t };
}

/** 把相位写进 meta（与 applyFreshnessMeta 分开调用，两者互不改写对方字段） */
export function applyPhaseMeta(meta, now = new Date(), holidays = []) {
  const p = marketPhase(now, holidays);
  meta.phase = p.phase;
  meta.phaseNote = PHASE_NOTE[p.phase];
  meta.phaseCheckedAt = now.toISOString();
  meta.phaseTradingDay = p.isTradingDay;
  return p;
}

// bjDate/bjTime 的实现已收敛至 src/time.js（BJ 换算全仓唯一出处）。
// 此处 re-export 维持既有调用方（scripts/snapshot_intraday.mjs、scripts/freshness.mjs
// 及本文件内部相位判定）import 路径零改动。
export { bjDate, bjTime };

function shift(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// （原私有 atBJ 已并入 src/time.js 的 bjInstant——北京墙上时刻 → 绝对时间点）

/** 上一个交易日（不含 dateStr 自身） */
export function prevSession(dateStr, holidays = []) {
  let d = shift(dateStr, -1);
  for (let i = 0; i < 400; i++) {
    if (isTradingDay(d, holidays)) return d;
    d = shift(d, -1);
  }
  return null;
}

/** 下一个交易日（不含 dateStr 自身） */
export function nextSession(dateStr, holidays = []) {
  let d = shift(dateStr, 1);
  for (let i = 0; i < 400; i++) {
    if (isTradingDay(d, holidays)) return d;
    d = shift(d, 1);
  }
  return null;
}

/** 最近一个已收盘交易日：交易日且已过 15:00 记当日，否则记上一交易日 */
export function lastClosedSession(now = new Date(), holidays = []) {
  const today = bjDate(now);
  if (isTradingDay(today, holidays) && bjTime(now) >= MARKET_CLOSE) return today;
  return prevSession(today, holidays);
}

/** 落后交易日数 = (from, to] 区间内的交易日数 */
export function countSessions(from, to, holidays = []) {
  if (!from || !to || from >= to) return 0;
  let n = 0;
  let d = from;
  for (let i = 0; i < 400; i++) {
    d = shift(d, 1);
    if (d > to) break;
    if (isTradingDay(d, holidays)) n++;
  }
  return n;
}

/** 该交易日数据「预期已更新完毕」的北京时刻（绝对时间戳）；前端可直接与本地时钟比较 */
export function publishDeadline(tradeDate, holidays = []) {
  const n = nextSession(tradeDate, holidays);
  return n ? bjInstant(n, PUBLISH_HHMM) : null;
}

/**
 * 评估数据新鲜度。
 * @param {{tradeDate?: string|null}} meta 存档 meta（只需 tradeDate）
 * @param {Date} now 评估时刻
 * @param {string[]} holidays 手动节假日（config.manualHolidays）
 */
export function assessFreshness(meta = {}, now = new Date(), holidays = []) {
  const tradeDate = meta.tradeDate || null;
  const latestClosed = lastClosedSession(now, holidays);
  const behindSessions = countSessions(tradeDate, latestClosed, holidays);
  const deadline = tradeDate ? publishDeadline(tradeDate, holidays) : null;
  let state;
  if (!tradeDate) state = 'unknown';
  else if (behindSessions <= 0) state = 'fresh';
  else if (deadline != null && now.getTime() < deadline) state = 'pending';
  else state = 'behind';
  return {
    state,
    stale: state === 'behind',
    tradeDate,
    latestClosed,
    behindSessions,
    publishDeadline: deadline == null ? null : new Date(deadline).toISOString(),
    checkedAt: now.toISOString(),
  };
}

/** 滞后原因（人读文案；非滞后返回 null） */
export function staleReasonText(f) {
  if (!f || !f.stale) return null;
  return `落后 ${f.behindSessions} 个交易日（最近已收盘交易日 ${f.latestClosed}）`;
}

/**
 * 把判定结果写进 meta（管道与 CLI 共用，只改判定字段、不动数据）。
 * @param {object} meta 存档 meta（就地修改）
 * @param {string|null} tradeDate 存档当前覆盖的交易日
 * @param {Date} now 评估时刻
 * @param {string[]} holidays 手动节假日
 * @param {{outcome:string, reason?:string|null}|undefined} attempt 本次尝试结果；给出才覆盖 lastAttempt
 */
export function applyFreshnessMeta(meta, tradeDate, now = new Date(), holidays = [], attempt = undefined) {
  const f = assessFreshness({ tradeDate }, now, holidays);
  meta.tradeDate = tradeDate;
  meta.stale = f.stale;
  meta.staleReason = staleReasonText(f);
  meta.freshness = f;
  if (attempt) meta.lastAttempt = { at: now.toISOString(), ...attempt };
  return f;
}

/**
 * 判定字段里「有意义」的部分——用于判断是否值得落盘。
 * checkedAt / lastAttempt.at / phaseCheckedAt 每次评估都会变，不参与比较，避免产生无意义提交；
 * 但 lastAttempt.outcome 参与：让「最近一次没抓成（跳过/失败）」这类信息能真正落盘给页面看，
 * 同时因为只比结果不比时间戳，连续同类结果不会产生重复提交。
 *
 * phase 参与比较：相位切换（pre→live→closed）是**页面必须知道**的状态变化，
 * 不写盘就永远停在旧相位（比如盘中一直显示"收盘后"）。但它一天只变 2~3 次，
 * 不会像时间戳那样造成提交噪音。
 */
export function freshnessKey(meta = {}) {
  const f = meta.freshness || {};
  return JSON.stringify([meta.tradeDate, meta.stale, meta.staleReason,
    f.state, f.latestClosed, f.behindSessions, f.publishDeadline,
    meta.phase ?? null, meta.phaseTradingDay ?? null,
    meta.lastAttempt?.outcome ?? null]);
}
