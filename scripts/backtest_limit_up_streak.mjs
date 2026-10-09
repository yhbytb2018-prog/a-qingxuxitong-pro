// 连板概率回溯：T+1 是否会再涨停（= 连板 +1）
//
// 为什么需要单独跑这个：
//   src/predict.js 现有的因子回答的是「T+1 是否上涨」，但用户要的是
//   「**大概率连板**」——这是不同的目标（涨停 ≠ 上涨：实测有 44.7% 的涨停股
//   T+1 是下跌的，但它们几乎不会再涨停）。所以要独立统计「T+1 再涨停」的条件概率，
//   并且必须按 T+1 涨停的**判定口径**（主板 ≥9.8%、创业板/科创 ≥19.8%）来算，
//   不能拿「涨幅>0」凑数。
//
// 数据源：腾讯前复权日K（web.ifzq.gtimg.cn），单只查询（多只分号拼接会 param error）。
// 用法：node scripts/backtest_limit_up_streak.mjs [--archive data/archive.json] [--out data/streak_backtest.json]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { atomicWriteJSON } from '../src/fsutil.js';
import { dirname } from 'node:path';
import { decodeArchive } from '../src/lhb_codec.js';

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ARCHIVE = argOf('--archive', 'data/archive.json');
const OUT = argOf('--out', 'data/streak_backtest.json');
const CACHE = 'data/.kline_cache.json';

const r2 = (v) => Math.round(v * 100) / 100;

// ── 板段与涨停判定（与 src/lhb.js / paper 的板段口径一致） ──
function boardOf(code) {
  const c = String(code || '');
  if (/^(688|689)/.test(c)) return { key: 'star', limit: 0.20, label: '科创板' };
  if (/^30/.test(c)) return { key: 'gem', limit: 0.20, label: '创业板' };
  if (/^(4|8|920)/.test(c)) return { key: 'bj', limit: 0.30, label: '北交所' };
  return { key: 'main', limit: 0.10, label: '主板' };
}
/** T+1 是否涨停：涨幅 ≥ 板段涨停幅 − 0.2pt（留出四舍五入余量，与模拟器口径一致） */
const isLimitUp = (code, pct) => Number.isFinite(pct) && pct >= boardOf(code).limit * 100 - 0.2;

function symOf(code) {
  const c = String(code || '');
  if (/^(6|9)/.test(c)) return 'sh' + c;
  if (/^(0|3)/.test(c)) return 'sz' + c;
  if (/^(4|8|920)/.test(c)) return 'bj' + c;
  return null;
}

// ── 抓日K（带磁盘缓存，避免重复跑 33 天 × 上千只） ──
// ⚠ 接口选择有坑（2026-10-01 实测）：
//   `web.ifzq.gtimg.cn/appstock/app/fqkline/get` → 被腾讯 WAF 拦（501 反爬页），不可用；
//   `web.ifzq.gtimg.cn/appstock/app/kline/kline`  → 可用，但**不复权**；
//   `proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get` → 可用且返回 **qfqday（前复权）**，
//     节点名是 `qfqday`，每行 [日期, 开, 收, 高, 低, 量, {}, ...]。本脚本用它。
// 复权很重要：不复权时除权日会出现 −30% 的假暴跌，会把「T+1 涨幅」统计污染掉。
let cache = {};
if (existsSync(CACHE)) { try { cache = JSON.parse(readFileSync(CACHE, 'utf8')); } catch (e) { cache = {}; } }
let cacheDirty = false;

async function kline(code) {
  const sym = symOf(code);
  if (!sym) return null;
  // 空数组视为「抓过但失败」，重试一次；非空直接用缓存
  if (Array.isArray(cache[code]) && cache[code].length) return cache[code];
  const url = `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=${sym},day,2026-06-01,2026-10-10,320,qfq`;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { Referer: 'https://finance.qq.com', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' } });
      const j = await res.json();
      const node = j?.data?.[sym] || {};
      const rows = node.qfqday || node.day || [];
      const out = rows.map((r) => ({ d: r[0], c: +r[2] })).filter((r) => r.d && Number.isFinite(r.c));
      if (out.length) { cache[code] = out; cacheDirty = true; return out; }
    } catch (e) { /* 重试 */ }
    await new Promise((r) => setTimeout(r, 250 * (i + 1)));
  }
  cache[code] = [];
  cacheDirty = true;
  return [];
}

// ── 构建「交易日 → 全市场收盘价」用于算 T+1 涨幅 ──
const arch = decodeArchive(JSON.parse(readFileSync(ARCHIVE, 'utf8')));
const days = (arch.all_days || []).filter((d) => d && d.trade_date);
const allDates = days.map((d) => d.trade_date);

/** 每只候选：{date, code, name, streak, turnoverPct, netWan, isZt, close} */
const candidates = [];
for (const d of days) {
  const s = d.summary || {};
  const ztCodes = new Set(Array.isArray(s.zt_codes) ? s.zt_codes : []);
  const ztLb = (s.zt_lb && typeof s.zt_lb === 'object') ? s.zt_lb : {};
  const hot = new Map((Array.isArray(d.hot) ? d.hot : []).map((h) => [h.code, h]));
  const seen = new Set();
  const push = (code, seed) => {
    if (!code || seen.has(code)) return;
    seen.add(code);
    candidates.push({ date: d.trade_date, code, ...seed });
  };
  for (const l of (Array.isArray(d.lhb) ? d.lhb : [])) {
    if (!l || !l.code || l.is_range) continue;
    push(l.code, {
      name: l.name, streak: ztCodes.has(l.code) ? (+ztLb[l.code] || 1) : null,
      turnoverPct: l.turnover_pct, netWan: l.net_buy_wan, isZt: ztCodes.has(l.code),
      close: l.close, changePct: l.change_pct,
    });
  }
  for (const code of ztCodes) {
    const h = hot.get(code);
    push(code, {
      name: h ? h.name : code, streak: +ztLb[code] || 1,
      turnoverPct: h ? h.huanshou : null, netWan: null, isZt: true,
      close: h ? h.close : null, changePct: h ? h.change_pct : null,
    });
  }
}

// 去重后逐只抓K线（并发 8）
const codes = [...new Set(candidates.map((c) => c.code))];
process.stderr.write(`[streak] 候选 ${candidates.length} 条 / ${codes.length} 只，抓日K中…\n`);
let done = 0;
const CONC = 8;
for (let i = 0; i < codes.length; i += CONC) {
  await Promise.all(codes.slice(i, i + CONC).map((c) => kline(c)));
  done += Math.min(CONC, codes.length - i);
  if (done % 80 === 0 || done === codes.length) process.stderr.write(`  ${done}/${codes.length}\n`);
}
if (cacheDirty) atomicWriteJSON(CACHE, JSON.stringify(cache));

// ── 逐条算 T+1 涨幅 / 是否再涨停 / T+3 ──
const recs = [];
for (const c of candidates) {
  const kl = cache[c.code] || [];
  const i = kl.findIndex((r) => r.d === c.date);
  if (i < 0 || i + 1 >= kl.length) continue;
  const base = kl[i].c, t1 = kl[i + 1].c;
  if (!(base > 0)) continue;
  const t1Pct = (t1 / base - 1) * 100;
  const t3Pct = (i + 3 < kl.length) ? (kl[i + 3].c / base - 1) * 100 : null;
  // T+1 是否再涨停（连板成功）
  const again = isLimitUp(c.code, t1Pct);
  // T+1 开盘价（若有）→ 衡量「开盘追高」的代价
  recs.push({
    ...c, board: boardOf(c.code).key, t1Pct: r2(t1Pct), t3Pct: t3Pct == null ? null : r2(t3Pct),
    again, up: t1Pct > 0, ztNow: !!c.isZt, streakNow: c.isZt ? (+c.streak || 1) : 0,
    lowTurn: c.turnoverPct != null && +c.turnoverPct < 10,
    bigFund: c.netWan != null && +c.netWan >= 20000,
  });
}

// ── 分组统计 ──
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : r2((s[m - 1] + s[m]) / 2); };
function group(label, filter) {
  const g = recs.filter(filter);
  if (!g.length) return { label, n: 0 };
  return {
    label, n: g.length,
    againPct: r2(g.filter((r) => r.again).length / g.length * 100),   // 连板成功率
    upPct: r2(g.filter((r) => r.up).length / g.length * 100),
    t1Mean: r2(g.reduce((a, r) => a + r.t1Pct, 0) / g.length),
    t1Med: med(g.map((r) => r.t1Pct)),
    t3Med: med(g.filter((r) => r.t3Pct != null).map((r) => r.t3Pct)),
  };
}

const all = group('全部候选（有T+1数据）', () => true);
const ztAll = group('全部涨停股', (r) => r.ztNow);
const groups = [
  all, ztAll,
  group('涨停·首板', (r) => r.ztNow && r.streakNow === 1),
  group('涨停·2连板', (r) => r.ztNow && r.streakNow === 2),
  group('涨停·3连板', (r) => r.ztNow && r.streakNow === 3),
  group('涨停·4连板及以上', (r) => r.ztNow && r.streakNow >= 4),
  group('涨停·首板&换手<10%', (r) => r.ztNow && r.streakNow === 1 && r.lowTurn),
  group('涨停·2连板&换手<10%', (r) => r.ztNow && r.streakNow === 2 && r.lowTurn),
  group('涨停·3连板&换手<10%', (r) => r.ztNow && r.streakNow === 3 && r.lowTurn),
  group('涨停·3连板以上&换手<10%', (r) => r.ztNow && r.streakNow >= 3 && r.lowTurn),
  group('涨停·换手>=25%', (r) => r.ztNow && r.turnoverPct != null && +r.turnoverPct >= 25),
  group('涨停·换手10~25%', (r) => r.ztNow && r.turnoverPct != null && +r.turnoverPct >= 10 && +r.turnoverPct < 25),
  group('涨停·净买>=2亿', (r) => r.ztNow && r.bigFund),
  group('涨停·创业板/科创板(20%)', (r) => r.ztNow && r.board === 'gem'),
  group('涨停·科创板', (r) => r.ztNow && r.board === 'star'),
  group('涨停·主板(10%)', (r) => r.ztNow && r.board === 'main'),
  group('非涨停·净买>=2亿', (r) => !r.ztNow && r.bigFund),
  group('非涨停·净买<2亿', (r) => !r.ztNow && !r.bigFund),
];

// 按「当日涨停家数」拆稀缺/拥挤
const ztCountByDate = new Map(days.map((d) => [d.trade_date, +((d.summary || {}).zt_count) || null]));
const scarce = [], crowded = [];
for (const r of recs) {
  if (!r.ztNow) continue;
  const z = ztCountByDate.get(r.date);
  if (!Number.isFinite(z)) continue;
  (z < 40 ? scarce : crowded).push(r);
}
const scarcity = [
  { label: '涨停·当日涨停家数<40（稀缺）', n: scarce.length, againPct: scarce.length ? r2(scarce.filter((r) => r.again).length / scarce.length * 100) : null, t1Med: med(scarce.map((r) => r.t1Pct)) },
  { label: '涨停·当日涨停家数≥40（拥挤）', n: crowded.length, againPct: crowded.length ? r2(crowded.filter((r) => r.again).length / crowded.length * 100) : null, t1Med: med(crowded.map((r) => r.t1Pct)) },
];

// 二维交叉：连板高度 × 换手档（找最强组合）
const grid = [];
for (const st of [1, 2, 3]) {
  for (const [tk, tf] of [['<10%', (r) => r.lowTurn], ['10~25%', (r) => r.turnoverPct != null && +r.turnoverPct >= 10 && +r.turnoverPct < 25], ['>=25%', (r) => r.turnoverPct != null && +r.turnoverPct >= 25]]) {
    const g = recs.filter((r) => r.ztNow && r.streakNow === st && tf(r));
    grid.push({ streak: st, turn: tk, n: g.length,
      againPct: g.length ? r2(g.filter((r) => r.again).length / g.length * 100) : null,
      t1Med: med(g.map((r) => r.t1Pct)) });
  }
}

// 日期范围
recs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
const meta = {
  version: 'streak-backtest-v1',
  generatedAt: new Date().toISOString().slice(0, 19),
  archive: ARCHIVE,
  tradeDays: allDates.length,
  dateFrom: allDates[0], dateTo: allDates[allDates.length - 1],
  candidates: candidates.length,
  withT1: recs.length,
  uniqueCodes: codes.length,
  note: 'T+1 涨停判定：主板 ≥9.8%、创业板/科创板 ≥19.8%、北交所 ≥29.8%（与模拟器板段口径一致）；'
    + '收益按 T 日收盘价买入算，前复权。',
};

if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
atomicWriteJSON(OUT, JSON.stringify({ meta, all, ztAll, groups, scarcity, grid, raw: recs }, null, 0));

process.stdout.write(`[streak] ${meta.dateFrom} ~ ${meta.dateTo}（${meta.tradeDays} 个交易日）\n`);
process.stdout.write(`[streak] 候选 ${meta.candidates} 条，有 T+1 数据 ${meta.withT1} 条，去重 ${meta.uniqueCodes} 只\n\n`);
const pad = (s, n) => String(s).padEnd(n, ' ');
const padL = (s, n) => String(s).padStart(n, ' ');
process.stdout.write(pad('分组', 30) + padL('n', 6) + padL('再涨停%', 9) + padL('上涨%', 8) + padL('T+1均', 8) + padL('T+1中位', 9) + padL('T+3中位', 9) + '\n');
for (const g of [...groups, ...scarcity]) {
  process.stdout.write(pad(g.label, 30) + padL(g.n ?? 0, 6) + padL(g.againPct == null ? '—' : g.againPct, 9)
    + padL(g.upPct == null ? '—' : g.upPct, 8) + padL(g.t1Mean == null ? '—' : g.t1Mean, 8)
    + padL(g.t1Med == null ? '—' : g.t1Med, 9) + padL(g.t3Med == null ? '—' : g.t3Med, 9) + '\n');
}
process.stdout.write('\n【连板高度 × 换手 交叉（再涨停率）】\n');
for (const g of grid) {
  process.stdout.write(`  ${g.streak}板 × 换手${pad(g.turn, 8)} n=${padL(g.n, 4)}  再涨停 ${padL(g.againPct == null ? '—' : g.againPct + '%', 7)}  T+1中位 ${g.t1Med == null ? '—' : g.t1Med}%\n`);
}
