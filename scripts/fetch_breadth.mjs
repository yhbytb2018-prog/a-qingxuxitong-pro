// 全市场 K 线扫描 → 多维宽度（#3）
//
// ── 为什么必须分片（用户的硬要求：不能一把梭）────────────────────────────────
// 全市场约 5400 只 A 股，每只要 ≥251 根日 K（算 MA20 + 250 日回看）。
//   · 一次性并发拉：腾讯接口会限流（实测连续 8 并发约 3000 只后开始大量超时），
//     且单次运行可能持续十几分钟，中途失败就全废——没有任何断点续跑能力。
//   · 内存里同时持有 5400 × 251 ≈ 135 万个数据点（约 40MB 原始 JSON），
//     再加上解析对象，Node 默认堆会有压力。
// 故本脚本拆成两段：
//   ① **抓取分片**：把代码清单切成 N 片（默认 8 片），一片一个进程/一次循环，
//      每片独立落盘到 `data/.breadth_kline/<shard>.json`（缓存）。已存在的片直接跳过，
//      这样中途失败重跑只补缺的片，不用从头再来。
//   ② **汇总**：读所有分片缓存 → 逐只算宽度 → 写 `data/breadth-latest.json`
//      （轻量计数结果，约几 KB）+ 追加到 `data/breadth-daily.json`（逐日累积序列）。
//
// ── 缓存策略（用户拍板）──────────────────────────────────────────────────────
//   主存：轻量计数缓存（breadth-latest.json，只存占比/家数，不存原始 K 线）
//   副存：分片原始 K 线压缩（data/.breadth_kline/*.json，供未来扩展；默认只留 90 天）
//   拒绝"每次现算 1.25M 数据点"——那是分钟级等待，不可接受。
//
// ── 用法 ────────────────────────────────────────────────────────────────────
//   node scripts/fetch_breadth.mjs                  # 抓取缺的分片 + 汇总
//   node scripts/fetch_breadth.mjs --shards 12      # 指定分片数
//   node scripts/fetch_breadth.mjs --summary-only   # 只用已有缓存重新汇总
//   node scripts/fetch_breadth.mjs --date 2026-09-30# 指定"当日"日期
//   node scripts/fetch_breadth.mjs --limit 200      # 只扫前 N 只（冒烟/调试）
//   node scripts/fetch_breadth.mjs --dry            # 不写盘（含分片缓存），只打印
//                                                   # 仍会完成抓取与汇总，便于冒烟
//
// ⚠ 沙箱限制：东财列表接口（PB 源、全市场清单）在本沙箱 fetch failed（与项目既有记录
//   一致）。故：
//     · 代码清单有兜底：paper_universe.json（3558 只，覆盖沪深主板/创业/科创/北交所）
//     · PB 源不可用 → 破净率恒为 null → 页面显示「未计算」
//   两者在 CI（GitHub Actions）上均正常。

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { atomicWriteJSON } from '../src/fsutil.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeBreadth, breadthVerdict, buildBreadthSeries, BREADTH_THRESHOLDS, MIN_BARS } from '../src/breadth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname + '/..';

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const SHARDS = Math.max(1, Math.min(32, +argOf('--shards', '8') || 8));
const LIMIT = +argOf('--limit', '0') || 0;
const DATE_ARG = argOf('--date', '') || null;
const CACHE_DIR = join(ROOT, 'data', '.breadth_kline');
const OUT = join(ROOT, 'data', 'breadth-latest.json');
const DAILY = join(ROOT, 'data', 'breadth-daily.json');
const SUMMARY_ONLY = has('--summary-only');
const DRY = has('--dry');

/** 副存保留的 K 线根数。**必须 ≥ 新高/新低回看窗口 + 1**，否则「创一年新高」
 *  永远判不出（会被静默降级成"未计算"，看着像没数据，其实是缓存被截断）。
 *  用户拍板的"90 天"是**体积预算口径**；而 250 日回看是**口径正确性硬要求**，
 *  两者冲突时口径优先——故这里取 max(预算, 回看窗口+1)。 */
const KEEP_BARS = Math.max(90, BREADTH_THRESHOLDS.NEW_HIGH_LOOKBACK + 1);
/** 单分片内的并发数（腾讯接口友好值）。 */
const CONC = 6;
/** 每只票请求的回看天数（需 ≥ MIN_BARS=21，留足 250 回看则要 251+）。 */
const FETCH_BARS = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 代码清单 ────────────────────────────────────────────────────────────────
// 优先用东财全市场清单（含 PB）；不可用时回退 paper_universe.json（无 PB）。
async function loadUniverse() {
  const em = await fetchEastmoneyList();
  if (em && em.length) {
    console.log(`[breadth] 清单来源：东财全市场（${em.length} 只，含 PB）`);
    return em;
  }
  const p = join(ROOT, 'data', 'paper_universe.json');
  if (!existsSync(p)) {
    console.error('[breadth] 无可用代码清单（东财不可用且缺 paper_universe.json）');
    return [];
  }
  const u = JSON.parse(readFileSync(p, 'utf8'));
  const codes = Object.keys(u.symbols || {});
  console.log(`[breadth] 清单来源：paper_universe.json（${codes.length} 只，无 PB → 破净率未计算）`);
  return codes.map((c) => ({ code: c, name: (u.symbols[c] || {}).name || '', pb: null }));
}

async function fetchEastmoneyList() {
  // 沪深主板 + 创业板 + 科创板 + 北交所全量。fields: f12=代码 f14=名称 f23=PB
  const fs = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
  const out = [];
  try {
    for (let pn = 1; pn <= 60; pn++) {
      const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${fs}&fields=f12,f14,f23`;
      const r = await fetch(url, { headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0 Chrome/120' } });
      const j = await r.json();
      const diff = j && j.data && Array.isArray(j.data.diff) ? j.data.diff : null;
      if (!diff || !diff.length) break;
      for (const d of diff) {
        const code = String(d.f12 || '');
        if (!/^\d{6}$/.test(code)) continue;
        out.push({ code, name: d.f14 || '', pb: d.f23 != null && d.f23 !== '-' ? +d.f23 : null });
      }
      if (diff.length < 100) break;
      await sleep(120);
    }
  } catch (e) {
    console.error('[breadth] 东财清单不可用：', e.message);
    return null;
  }
  return out.length ? out : null;
}

// ── K 线抓取（腾讯前复权；与 backtest_limit_up_streak.mjs 同源）────────────
function symOf(code) {
  const c = String(code || '');
  if (/^(6|9)/.test(c)) return 'sh' + c;
  if (/^(0|3)/.test(c)) return 'sz' + c;
  if (/^(4|8|920)/.test(c)) return 'bj' + c;
  return null;
}

async function kline(code) {
  const sym = symOf(code);
  if (!sym) return [];
  const url = `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=${sym},day,2024-01-01,2030-12-31,${FETCH_BARS},qfq`;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { Referer: 'https://finance.qq.com', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' } });
      const j = await res.json();
      const node = (j && j.data && j.data[sym]) || {};
      const rows = node.qfqday || node.day || [];
      const out = rows.map((r) => ({ d: r[0], c: +r[2] })).filter((x) => x.d && Number.isFinite(x.c) && x.c > 0);
      if (out.length) return out;
    } catch (e) { /* 重试 */ }
    await sleep(200 * (i + 1));
  }
  return [];
}

// ── ① 抓取分片 ──────────────────────────────────────────────────────────────
// 返回本次真正抓到的数据（用于 --dry 时不落盘也能汇总）。
async function fetchShards(universe) {
  if (!existsSync(CACHE_DIR) && !DRY) mkdirSync(CACHE_DIR, { recursive: true });
  const per = Math.ceil(universe.length / SHARDS);
  let fetched = 0, skipped = 0, total = 0;
  const live = new Map(); // code → [{d,c}]（本次抓到的，供 dry 用）

  for (let s = 0; s < SHARDS; s++) {
    const slice = universe.slice(s * per, (s + 1) * per);
    if (!slice.length) continue;
    const file = join(CACHE_DIR, `shard-${String(s).padStart(2, '0')}.json`);
    // 断点续跑：分片已存在则跳过（这就是"分片"相对"一把梭"的核心收益）
    if (existsSync(file) && !has('--force') && !DRY) {
      skipped += slice.length;
      continue;
    }
    const store = {};
    for (let i = 0; i < slice.length; i += CONC) {
      const batch = slice.slice(i, i + CONC);
      await Promise.all(batch.map(async (item) => {
        const kl = await kline(item.code);
        if (kl.length) {
          // 副存压缩：只留最近 KEEP_BARS 根，且只存 [日期, 收盘]（不存开高低量）
          store[item.code] = kl.slice(-KEEP_BARS);
        }
      }));
      if ((i / CONC) % 20 === 0) {
        process.stderr.write(`\r[breadth] 分片 ${s + 1}/${SHARDS}  ${Math.min(i + CONC, slice.length)}/${slice.length}  `);
      }
    }
    if (!DRY) atomicWriteJSON(file, JSON.stringify(store));
    for (const [code, kl] of Object.entries(store)) live.set(code, kl);
    fetched += slice.length;
    total += Object.keys(store).length;
    process.stderr.write(`\r[breadth] 分片 ${s + 1}/${SHARDS} 完成：${Object.keys(store).length}/${slice.length} 只有 K 线\n`);
  }
  console.log(`[breadth] 抓取：新抓 ${fetched} 只、跳过已有 ${skipped} 只、有效缓存 ${total} 只`);
  return live;
}

// ── ② 汇总 ──────────────────────────────────────────────────────────────────
function readCache() {
  const map = new Map(); // code → [{d,c}]
  if (!existsSync(CACHE_DIR)) return map;
  for (const f of readdirSync(CACHE_DIR).filter((x) => x.endsWith('.json'))) {
    try {
      const obj = JSON.parse(readFileSync(join(CACHE_DIR, f), 'utf8'));
      for (const [code, kl] of Object.entries(obj)) if (Array.isArray(kl) && kl.length) map.set(code, kl);
    } catch (e) { /* 单片损坏不影响其他片 */ }
  }
  return map;
}

function summarize(universe, cache) {
  // "当日"= 缓存里出现最多的那个日期（各票最后一天应一致；取众数最稳）
  const dateVotes = new Map();
  for (const kl of cache.values()) {
    const d = kl[kl.length - 1] && kl[kl.length - 1].d;
    if (d) dateVotes.set(d, (dateVotes.get(d) || 0) + 1);
  }
  let targetDate = DATE_ARG;
  if (!targetDate) {
    let best = null;
    for (const [d, n] of dateVotes) if (!best || n > best.n) best = { d, n };
    targetDate = best ? best.d : null;
  }
  if (!targetDate) return null;

  const stocks = [];
  for (const item of universe) {
    const kl = cache.get(item.code);
    if (!kl || !kl.length) continue;
    // 截到目标日（含）。目标日之后的数据不得进入——那是**前视偏差**。
    const upto = kl.filter((r) => r.d <= targetDate);
    if (!upto.length) continue;
    stocks.push({
      code: item.code,
      pb: item.pb ?? null,
      close: upto[upto.length - 1].c,
      closes: upto.map((r) => r.c),
      asOf: upto[upto.length - 1].d,
    });
  }
  // 样本日期一致性守卫：若某票的"最后一根"明显早于目标日（停牌/退市），
  // 它的 close 就不是当日的 → 会污染涨跌家数与新高判定。剔掉这些（不静默）。
  const stale = stocks.filter((s) => s.asOf !== targetDate);
  const fresh = stocks.filter((s) => s.asOf === targetDate);

  const b = computeBreadth(fresh);
  return { targetDate, breadth: b, stale: stale.length, freshCount: fresh.length };
}

// ── 打印报告（--dry 与正常路径共用；口径唯一）────────────────────────────────
function report(res) {
  const { targetDate, breadth, stale, freshCount } = res;
  const verdict = breadthVerdict(breadth);
  console.log(`\n[breadth] 目标日 ${targetDate} · 有效样本 ${breadth.scanned} / 请求 ${breadth.requested}` +
    (stale ? ` · 剔除陈旧/停牌 ${stale} 只` : ''));
  console.log(`[breadth] 站上${BREADTH_THRESHOLDS.MA_WINDOW}日线 ${(breadth.aboveMa.ratio == null ? '未计算' : (breadth.aboveMa.ratio * 100).toFixed(1) + '%')}` +
    ` (${breadth.aboveMa.n}/${breadth.aboveMa.den}) · 新高 ${(breadth.newHigh.ratio == null ? '未计算' : (breadth.newHigh.ratio * 100).toFixed(1) + '%')}` +
    ` · 新低 ${(breadth.newLow.ratio == null ? '未计算' : (breadth.newLow.ratio * 100).toFixed(1) + '%')}` +
    ` · 破净 ${(breadth.brokenPb.ratio == null ? '未计算（PB 源不可用）' : (breadth.brokenPb.ratio * 100).toFixed(1) + '%')}`);
  console.log(`[breadth] 涨跌家数 ${breadth.updown ? `${breadth.updown.up}↑ ${breadth.updown.down}↓ ${breadth.updown.flat}— (${breadth.updown.src})` : '未计算'}`);
  console.log(`[breadth] 结论：${verdict.label} — ${verdict.detail}`);
  return verdict;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const universe0 = await loadUniverse();
const universe = LIMIT ? universe0.slice(0, LIMIT) : universe0;
if (!universe.length) {
  console.error('[breadth] 无标的可扫，退出');
  process.exit(2);
}

if (!SUMMARY_ONLY) {
  const live = await fetchShards(universe);
  if (DRY) {
    // --dry 时用内存里本次抓到的数据直接汇总（磁盘上没有分片可读）
    const cacheDry = new Map([...readCache(), ...live]);
    const resDry = summarize(universe, cacheDry);
    if (resDry) report(resDry);
    console.log('[breadth] --dry，不写盘');
    process.exit(0);
  }
}

const cache = readCache();
const res = summarize(universe, cache);
if (!res) {
  console.error('[breadth] 无 K 线缓存，无法汇总');
  process.exit(2);
}

report(res);
const { targetDate, breadth, stale } = res;
const verdict = breadthVerdict(breadth);

// ── 写盘：轻量计数（主）+ 逐日序列 ──────────────────────────────────────────
const payload = {
  meta: {
    generatedAt: new Date().toISOString(),
    tradeDate: targetDate,
    source: 'tencent-qfq-kline',
    scanned: breadth.scanned,
    requested: breadth.requested,
    staleExcluded: stale,
    thresholds: breadth.thresholds,
    note: '宽度指标由全市场真实前复权日K计算（非 hot 榜单样本）。'
      + '占比分母是当次扫描到的有效样本数，不是全市场总数。'
      + '样本不足时比例字段为 null（显示「未计算」），绝不填 0。'
      + '破净率依赖 PB 源（东财列表），不可用时恒为 null。'
      + '不构成投资建议。',
  },
  date: targetDate,
  ...breadth,
  verdict,
};
atomicWriteJSON(OUT, JSON.stringify(payload, null, 0));
console.log(`[breadth] 已写出 ${OUT}（${(Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(1)}KB）`);

// 逐日累积序列（append/更新当日）
let daily = { kind: 'breadth-daily', version: 1, rows: [] };
if (existsSync(DAILY)) {
  try { daily = JSON.parse(readFileSync(DAILY, 'utf8')); } catch (e) { /* 重置 */ }
}
if (!Array.isArray(daily.rows)) daily.rows = [];
daily.rows = daily.rows.filter((r) => r.date !== targetDate);
daily.rows.push({
  date: targetDate, breadth,
});
daily.rows.sort((a, b) => (a.date < b.date ? -1 : 1));
daily.meta = { updatedAt: new Date().toISOString(), days: daily.rows.length };
atomicWriteJSON(DAILY, JSON.stringify(daily));
const series = buildBreadthSeries(daily.rows);
console.log(`[breadth] 已写出 ${DAILY}（累积 ${series.length} 天，最新 ${series.length ? series[series.length - 1].date : '—'}）`);
