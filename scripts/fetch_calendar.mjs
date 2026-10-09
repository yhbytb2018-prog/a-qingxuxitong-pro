#!/usr/bin/env node
// 抓取 / 推导 A 股交易日历 → data/calendar.json
//
// ── 为什么用「指数日K反推」而不是抓假日办公告 ────────────────────────────────
//
// 最初设想是抓国务院办公厅 / 交易所的休市安排公告。实际做下来这个方案有三个硬伤：
//   ① 公告是**自然语言**（"春节 2 月 16 日至 22 日放假调休，共 7 天"），解析要用正则猜，
//      每年措辞还会变——解析错了会静默产出错误的日历，比手工维护更危险；
//   ② 公告只声明"放假"，不声明"股市不开市"（银行间、期货、股市的休市并不总是一致）；
//   ③ 跨年安排常在上一年 11~12 月才出，年初/年中抓不到次年公告 → 日历出现空洞。
//
// 于是改用**上证指数日K反推**：它上面每一个日期就是真实开市的一天，没有歧义、没有解析、
// 不可能"解读错"。休市 = 自然日在覆盖区间内、但不是日K日期。
//   实测效果：2026 春节 02-14~02-23 休市、国庆 10-01~10-07 休市，全部精确还原。
//
// 局限与如实披露：
//   · 覆盖区间最右端之后无数据 → 那些天状态为 unknown，由 src/calendar.js 回退"非周末即交易日"。
//     故本脚本每次运行都会把覆盖范围写进 meta.coveredTo，并在超出时打 warning，
//     提醒维护者日历该续了——不假装自己覆盖了未来。
//   · 「调休补班的周末」在日K上就是"有数据的周六/周日"，会被自动识别为 trading，
//     无需任何额外规则。这是本方案的额外红利。
//
// 用法：
//   node scripts/fetch_calendar.mjs [--years 2025,2026,2027] [--out data/calendar.json]
//   node scripts/fetch_calendar.mjs --offline   # 只重算种子，不联网（CI 兜底/本地调试）

import { writeFileSync } from 'node:fs';
import { atomicWriteJSON } from '../src/fsutil.js';
import config from '../src/config.js';
import { CALENDAR_FILE, SEED_CLOSED, validateCalendar, DAY_KIND, loadCalendar, calendarSummary } from '../src/calendar.js';
import { bjDate } from '../src/time.js';
import { fetchWithRetry } from '../src/util.js';

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const OFFLINE = args.includes('--offline');
const OUT = argOf('--out', CALENDAR_FILE);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36';

const thisYear = Number(bjDate().slice(0, 4));
const YEARS = (argOf('--years', '') || `${thisYear - 1},${thisYear},${thisYear + 1}`)
  .split(',').map((x) => Number(x.trim())).filter(Number.isFinite).sort();

// 上证指数日K（腾讯，项目已用于指数行情，无需新增依赖）
const KLINE = (a, b) => 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
  + `?param=sh000001,day,${a},${b},640,qfq`;

// 抓取重试已收敛至 util.fetchWithRetry（全仓唯一实现）。结构校验（缺少
// data.sh000001.day 视同失败）放进 opts.read，保持在重试范围内——与收敛前手写循环语义一致。
async function fetchSessions(from, to, retries = 3) {
  return fetchWithRetry(KLINE(from, to), {
    headers: { 'User-Agent': UA },
    timeout: 20000,
    read: async (r) => {
      const j = await r.json();
      const day = j?.data?.sh000001?.day;
      if (!Array.isArray(day)) throw new Error('返回结构异常：缺少 data.sh000001.day');
      return day.map((row) => row[0]).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    },
  }, retries, 1200);
}

const shift = (d, n) => {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const dowOf = (d) => new Date(d + 'T00:00:00').getDay();
const isWeekend = (d) => { const w = dowOf(d); return w === 0 || w === 6; };

async function main() {
  // 覆盖区间：取各年 1/1 ~ 12/31（跨年合并成一段，避免年边界处丢日期）
  const from = `${Math.min(...YEARS)}-01-01`;
  const to = `${Math.max(...YEARS)}-12-31`;

  let sessions = [];
  let source = 'seed';
  let upstream = null;
  const warnings = [];

  if (!OFFLINE) {
    try {
      sessions = await fetchSessions(from, to);
      source = 'tencent-kline-derived';
      upstream = KLINE(from, to);
      console.log(`[calendar] 已抓取上证指数日K：${sessions.length} 个交易日（${sessions[0]} → ${sessions[sessions.length - 1]}）`);
    } catch (e) {
      console.error('[calendar] 日K抓取失败：' + e.message);
      warnings.push('日K抓取失败，本次仅写出种子日历（未覆盖的日期将回退到「非周末即交易日」）：' + e.message);
      console.log('::warning::交易日历本次未能从日K反推（' + e.message + '），已回退种子日历');
    }
  } else {
    console.log('[calendar] --offline：不联网，仅写出种子日历');
  }

  // ── 由交易日集合反推休市日 ────────────────────────────────────────────────
  const closed = new Set();
  const trading = new Set();
  let coveredTo = null;

  if (sessions.length) {
    const set = new Set(sessions);
    coveredTo = sessions[sessions.length - 1];
    // 只遍历到「最后一个已知交易日」为止：之后是未来，无法判断是休市还是尚未开盘。
    // 把未来当休市写进日历会**永久污染**该文件（下一年真的开市时反而不认）——
    // 这是本脚本最容易犯的错，故用 coveredTo 硬性截断。
    for (let d = from; d <= coveredTo; d = shift(d, 1)) {
      if (set.has(d)) {
        // 落在周末却有行情 = 调休补班，显式记为 trading（这正是旧方案表达不了的）
        if (isWeekend(d)) trading.add(d);
      } else if (!isWeekend(d)) {
        closed.add(d); // 工作日却无行情 = 休市
      }
      // 周末无行情 = 正常周末，不必写进清单（validateCalendar 会拒绝清单里的周末日）
    }
  }

  // 种子休市日并入（已知确定的法定假期），并剔除落在周末的（周末默认休市，写进去只会虚高）
  for (const arr of Object.values(SEED_CLOSED)) {
    for (const d of arr) if (!isWeekend(d)) closed.add(d);
  }
  // config.manualHolidays 也并入（用户已核验的 2026 中秋/国庆安排），同样剔除周末项
  for (const d of (config.manualHolidays || [])) if (!isWeekend(d)) closed.add(d);

  // 显式交易日优先：从休市清单里剔除（调休补班）
  for (const d of trading) closed.delete(d);

  const coveredYears = [...new Set([...closed, ...trading].map((d) => Number(d.slice(0, 4))))].sort();

  const payload = {
    kind: 'trading-calendar',
    version: '1.0',
    generatedAt: new Date().toISOString(),
    source,
    upstream,
    // 覆盖范围如实写出来：超出 coveredTo 的日期状态为 unknown，
    // src/calendar.js 会回退旧规则并允许调用方感知，绝不假装已覆盖。
    coveredFrom: sessions.length ? sessions[0] : null,
    coveredTo,
    years: coveredYears,
    requestYears: YEARS,
    counts: { trading: trading.size, closed: closed.size, sessions: sessions.length },
    note: '休市日 = 上证指数在覆盖区间内的工作日中无日K的日期（由 scripts/fetch_calendar.mjs 反推）；'
      + 'trading = 有日K的周末日（调休补班）。周末默认休市，故不出现在 closed 中。'
      + '超出 coveredTo 的日期由 src/calendar.js 回退到「非周末即交易日」。',
    // 显式三态映射：便于人读与外部工具消费（与 closed/trading 两个数组等价）
    days: Object.fromEntries([
      ...[...closed].sort().map((d) => [d, DAY_KIND.closed]),
      ...[...trading].sort().map((d) => [d, DAY_KIND.trading]),
    ]),
    closed: [...closed].sort(),
    trading: [...trading].sort(),
    warnings,
  };

  // 写盘前自检：日历自相矛盾（同一天两种状态 / 补班日不是周末 / 清单纯周末）一律拒绝写盘。
  // 理由：日历是**判定层的地基**，一个错的休市日会让管道在开市日跳过、或在休市日死抓，
  // 而这两种故障在页面上都表现为"数据没更新"，极难归因。宁可不写，也不写错。
  const v = validateCalendar(payload);
  if (!v.ok) {
    console.error('[calendar] 自检失败，拒绝写盘：');
    for (const e of v.errors) console.error('  ✗ ' + e);
    process.exit(1);
  }

  atomicWriteJSON(OUT, JSON.stringify(payload, null, 1));
  console.log(`[calendar] 已写出 ${OUT}`);
  console.log(`  来源 ${source} | 覆盖 ${payload.coveredFrom || '—'} → ${payload.coveredTo || '—'} | 年份 ${coveredYears.join(',')}`);
  console.log(`  交易日 ${trading.size} 个（调休补班）| 休市日 ${closed.size} 个 | 日K ${sessions.length} 条`);
  for (const w of warnings) console.log('  ⚠ ' + w);

  // 回读校验：确认写出的文件能被 loadCalendar 解析，且三态判定符合预期
  const cal = loadCalendar({ reload: true, file: OUT });
  console.log('  回读：', JSON.stringify(calendarSummary(cal)));

  // 超出覆盖范围的提示（不假装覆盖了未来）
  const today = bjDate();
  if (coveredTo && coveredTo < today) {
    console.log(`  ⚠ 日历覆盖到 ${coveredTo}，已早于今天 ${today} —— 请尽快重跑本脚本续期`);
    console.log(`::warning::交易日历覆盖到 ${coveredTo}（早于 ${today}），新日期的休市判定已回退到「非周末即交易日」`);
  }
}

main().catch((e) => {
  console.error('[calendar] 失败：' + e.message);
  process.exit(1);
});
