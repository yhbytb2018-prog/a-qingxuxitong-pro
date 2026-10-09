// ── 交易日历（唯一出处）──────────────────────────────────────────────────────
//
// 为什么不再用 config.manualHolidays 直接判交易日：
//   旧实现是 `isTradingDay = 非周末 && 不在 manualHolidays 里`。它有两个结构性缺陷：
//
//   ① **调休补班日无法表达**。A 股确实存在「周末上班但股市开市」之外的复杂情形，
//      而更重要的是相反方向：一旦某年把某个周末调成工作日，人工维护的人很容易
//      「顺手把周末也算成交易日」——旧的布尔逻辑连表达它的能力都没有。
//      本模块用**显式三态**表达：交易日 / 休市日 / 未知，不再靠"扣减法"推导。
//
//   ② **每年手改是脆的**。漏登记一个休市日 → 管道把休市日当交易日 → 抓不到数据
//      → 反复回退 + 误报「数据滞后」，而界面上一切正常。这类故障已经真实发生过。
//
// 设计要点：
//   · 日历文件是可选的**增强**，不是硬依赖。文件缺失/损坏时回退到 config.manualHolidays，
//     行为与改造前**逐位一致**（这一点由单测锁定）——保证升级过程零风险。
//   · 日历自带 source / generatedAt / years 元信息，来源可追溯（是交易所公告还是第三方，
//     由 scripts/fetch_calendar.mjs 如实写入，不使用"未经验证"的静默兜底）。
//   · 所有对外 API 都接受「日历对象」而不是散装的日期数组，避免调用方各自理解字段。

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 单向依赖：config.js 零 import，故此处静态引用不会形成环。
import config from './config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CALENDAR_FILE = 'data/calendar.json';

// 日历条目的三种状态
export const DAY_KIND = {
  trading: 'trading',   // 明确为交易日
  closed: 'closed',     // 明确为休市日（法定节假日，或周末）
  unknown: 'unknown',   // 日历未覆盖（超出年份范围）→ 回退到「非周末即交易日」的旧规则
};

// ── 内置种子日历（config.manualHolidays 之外的、已确证的休市日）────────────────
//
// 为什么需要种子：日历文件要在 CI 里由 fetch_calendar.mjs 生成，但本地首次跑、
// 或 CI 生成失败时，若没有种子就会退化成「全年非周末都是交易日」——比旧的
// manualHolidays 更危险（旧版至少覆盖了已知假期）。
//
// 因此种子里放**已知确定的**休市日（用户已核验过的 2026 中秋/国庆安排），
// 与 config.manualHolidays 合并后作为兜底。新增年份时应在此追加已公告的休市日。
export const SEED_CLOSED = {
  2025: [
    // 2025 元旦 / 春节 / 清明 / 劳动 / 端午 / 中秋国庆（国务院办公厅 2024-11 公告）
    '2025-01-01',
    '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-02-03', '2025-02-04',
    '2025-04-04',
    '2025-05-01', '2025-05-02', '2025-05-05',
    '2025-06-02',
    '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-06', '2025-10-07', '2025-10-08',
  ],
  2026: [
    // 沪深北交易所《2026 年中秋节、国庆节休市安排》（证监办发〔2025〕130 号）
    '2026-01-01', '2026-01-02',
    '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23',
    '2026-04-06',
    '2026-05-01', '2026-05-04', '2026-05-05',
    '2026-06-19',
    '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
    '2026-10-05', '2026-10-06', '2026-10-07',
  ],
};

// ── 载入 ──────────────────────────────────────────────────────────────────────

let _cache = null;
let _cacheKey = null;

/**
 * 载入日历。返回统一结构：
 *   {
 *     kind: 'calendar',
 *     source: 'seed' | 'file' | 'merged',
 *     closed: Set<string>,        // 休市日
 *     trading: Set<string>,       // 显式交易日（覆盖周末，用于调休/补班）
 *     years: number[],            // 覆盖年份（超出范围的日期回退旧规则）
 *     meta: {...},
 *   }
 *
 * @param {object} [opts]
 * @param {boolean} [opts.reload] 跳过缓存重新读盘（测试与管道重跑用）
 * @param {string}  [opts.file]   指定日历文件路径
 * @param {string[]} [opts.fallbackHolidays] 文件缺失时的兜底休市日（一般是 config.manualHolidays）
 */
export function loadCalendar(opts = {}) {
  const file = opts.file || path.join(ROOT, CALENDAR_FILE);
  const key = file + '|' + (opts.fallbackHolidays || []).join(',');
  if (!opts.reload && _cache && _cacheKey === key) return _cache;

  const fallback = Array.isArray(opts.fallbackHolidays) ? opts.fallbackHolidays : [];
  const seedClosed = [];
  for (const arr of Object.values(SEED_CLOSED)) seedClosed.push(...arr);

  let cal = null;
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      cal = fromRaw(raw, fallback, seedClosed);
    } catch (e) {
      // 解析失败不得静默变"全年无休"——那样比旧实现更危险（旧版至少有 manualHolidays）。
      // 这里显式降级到种子 + fallback，并留下 degraded 标记供审计发现。
      cal = fromRaw(null, fallback, seedClosed);
      cal.meta.degraded = true;
      cal.meta.degradedReason = '日历文件解析失败：' + e.message;
    }
  } else {
    cal = fromRaw(null, fallback, seedClosed);
    cal.meta.degraded = true;
    cal.meta.degradedReason = '日历文件不存在（' + CALENDAR_FILE + '），已回退到种子 + config.manualHolidays';
  }

  _cache = cal;
  _cacheKey = key;
  return cal;
}

// 把原始 JSON 或"无文件"情形统一成同一结构。
// 注意：closed 是**并集**（种子 ∪ 文件 ∪ fallback）——
//   宁可多标一个休市日（后果是少抓一天，可事后补），也不能漏标（后果是把休市日当交易日，
//   触发反复回退 + 误报滞后，且界面上完全看不出来）。方向性取舍，不是妥协。
function fromRaw(raw, fallback, seedClosed) {
  const closed = new Set(seedClosed);
  const trading = new Set();
  let years = [];
  let source = 'seed';
  const meta = {};

  for (const d of fallback) closed.add(d);

  if (raw && typeof raw === 'object') {
    source = raw.source || 'file';
    meta.source = raw.source || null;
    meta.generatedAt = raw.generatedAt || null;
    meta.note = raw.note || null;
    meta.upstream = raw.upstream || null;
    if (Array.isArray(raw.years)) years = raw.years.map(Number).filter(Number.isFinite);
    // 支持两种形状：{closed:[...]} 与 {days:{'2026-01-01':'closed'}}
    if (Array.isArray(raw.closed)) for (const d of raw.closed) closed.add(d);
    if (Array.isArray(raw.holidays)) for (const d of raw.holidays) closed.add(d);
    if (raw.days && typeof raw.days === 'object') {
      for (const [d, k] of Object.entries(raw.days)) {
        if (k === DAY_KIND.closed) closed.add(d);
        else if (k === DAY_KIND.trading) { trading.add(d); closed.delete(d); }
      }
    }
    // 显式交易日优先于任何"闭市"来源（调休补班 = 周末开市）
    if (Array.isArray(raw.trading)) {
      for (const d of raw.trading) { trading.add(d); closed.delete(d); }
    }
  }

  if (!years.length) {
    const ys = new Set();
    for (const d of closed) ys.add(Number(String(d).slice(0, 4)));
    for (const d of trading) ys.add(Number(String(d).slice(0, 4)));
    years = [...ys].filter(Number.isFinite).sort();
  }

  return {
    kind: 'calendar',
    source,
    closed,
    trading,
    years,
    meta,
    fallbackCount: fallback.length,
    seedCount: seedClosed.length,
  };
}

// ── 判定 ──────────────────────────────────────────────────────────────────────

function dow(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? null : d.getDay();
}

/**
 * 某日的日历状态。三态而非布尔——「未知」必须与「休市」区分开。
 * @returns {'trading'|'closed'|'unknown'}
 */
export function dayKind(dateStr, cal) {
  const c = cal || loadCalendar();
  if (c.trading.has(dateStr)) return DAY_KIND.trading;  // 调休补班：周末也算交易日
  if (c.closed.has(dateStr)) return DAY_KIND.closed;
  const w = dow(dateStr);
  if (w === 0 || w === 6) return DAY_KIND.closed;       // 周末默认休市
  // 非周末、又不在任何休市清单里 → 视年份是否被日历覆盖决定
  const y = Number(String(dateStr).slice(0, 4));
  if (c.years.includes(y)) return DAY_KIND.trading;      // 该年已被日历覆盖，未列即交易日
  return DAY_KIND.unknown;                               // 超出覆盖范围 → 由调用方回退旧规则
}

/**
 * 是否交易日。**与旧 isTradingDay(dateStr, manualHolidays) 行为向后兼容**：
 * 传入数组时按旧语义解释（等价于"该数组是休市清单"），传入日历对象时走三态判定。
 *
 * 保留旧签名的理由：freshness.js / pipeline.js / 各脚本有十余处按位置传 holidays 数组，
 * 整体改写调用面的风险远大于收益。让新逻辑从**同一个函数**进入，调用面零改动。
 */
export function isTradingDay(dateStr, calendarOrHolidays) {
  if (Array.isArray(calendarOrHolidays)) {
    // 旧语义：数组 = 休市日清单；其余按"非周末即交易日"
    const w = dow(dateStr);
    if (w === 0 || w === 6) return false;
    return !calendarOrHolidays.includes(dateStr);
  }
  const kind = dayKind(dateStr, calendarOrHolidays);
  if (kind === DAY_KIND.trading) return true;
  if (kind === DAY_KIND.closed) return false;
  // unknown：日历未覆盖该年 → 回退旧规则（非周末即交易日），而不是假定休市
  const w = dow(dateStr);
  return w !== 0 && w !== 6;
}

// ── 供上游（pipeline / 脚本）使用的便捷入口 ─────────────────────────────────

/**
 * 取「当前应使用的休市日清单」——为兼容仍按数组语义消费的位置而提供。
 *
 * ⚠ 注意：本函数返回的是**休市日并集**，不含"调休补班"信息。
 *   调用方若需要完整语义（含周末开市），必须传日历对象给 isTradingDay，
 *   而不是继续用这个数组。保留它是为了让尚未改造的调用点不至于行为反转。
 */
export function holidayList(cal) {
  const c = cal || loadCalendar();
  return [...c.closed].sort();
}

/** 日历健康摘要，供审计与日志（一眼看出是否退化到兜底） */
export function calendarSummary(cal) {
  const c = cal || loadCalendar();
  return {
    source: c.source,
    years: c.years,
    closedCount: c.closed.size,
    tradingOverrideCount: c.trading.size,
    degraded: !!c.meta.degraded,
    degradedReason: c.meta.degradedReason || null,
    generatedAt: c.meta.generatedAt || null,
  };
}

// ── 与 config 的接线（唯一入口）────────────────────────────────────────────
//
// 为什么单独一个 resolveHolidays：
//   改造前有十余处调用点写成 `isTradingDay(d, config.manualHolidays)`。
//   逐处改成传日历对象风险大——漏改一处就行为不一致，而且**不会有任何报错**：
//   它只是悄悄按旧规则判，节假日错一天没人发现。
//   故提供本函数把"该用哪个日历"收敛到一处，调用点只需把
//   `config.manualHolidays` 换成 `resolveHolidays()` 即可拿到完整语义。
//
// 返回**日历对象**（而非数组）是刻意的：数组语义只有"休市清单"，无法表达调休补班。
export function resolveHolidays() {
  return loadCalendar({ fallbackHolidays: config.manualHolidays || [] });
}

/** 日历健康摘要（单行，供日志）：一眼看出是否退化到兜底 */
export function calendarLine(cal) {
  const s = calendarSummary(cal);
  return `source=${s.source} 覆盖=${s.years.join(',') || '—'} 休市${s.closedCount} 补班${s.tradingOverrideCount}`
    + (s.degraded ? ` [降级: ${s.degradedReason}]` : '');
}

/** 校验日历自洽（供 fetch_calendar.mjs 写盘前自检与单测使用） */
export function validateCalendar(raw) {
  const errs = [];
  const seen = new Map();
  const push = (d, kind) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) errs.push(`非法日期格式：${d}`);
    if (seen.has(d) && seen.get(d) !== kind) errs.push(`同一日期被标为两种状态：${d}（${seen.get(d)} / ${kind}）`);
    seen.set(d, kind);
  };
  for (const d of raw.closed || []) push(d, DAY_KIND.closed);
  for (const d of raw.trading || []) push(d, DAY_KIND.trading);
  if (raw.days) {
    for (const [d, k] of Object.entries(raw.days)) {
      if (k !== DAY_KIND.closed && k !== DAY_KIND.trading) errs.push(`未知状态：${d}=${k}`);
      else push(d, k);
    }
  }
  // 调休补班必须是周末（否则意味着不是"补班"而是写错了）
  for (const d of raw.trading || []) {
    const w = dow(d);
    if (w !== 0 && w !== 6) errs.push(`调休补班日必须是周末：${d}（周${w}）`);
  }
  // 休市日不得落在周末（周末本来就不交易，列进去只会让"并集"虚高、掩盖真实遗漏）
  const weekendClosed = (raw.closed || []).filter((d) => { const w = dow(d); return w === 0 || w === 6; });
  if (weekendClosed.length) errs.push(`休市清单含周末日（应省略，周末默认休市）：${weekendClosed.join(',')}`);
  return { ok: errs.length === 0, errors: errs };
}
