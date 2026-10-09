// V5.3 领涨标的市值快照采集（P0-1 市场状态识别的第五输入：领涨标的市值分布）
//
// 目标：为 regime 的「市值分布」判据积累数据——领涨标的（涨停池 = 领涨的极端形式）
//       的流通市值分布特征（小盘占比/中位数/大盘占比）。小盘占比高 = 投机盘主导
//       （情绪退潮期风险大），大盘占比高 = 权重搭台（主升期特征）。
//
// 数据源：东财 push2 ulist.np 批量行情（scripts/probe_sources.mjs 同接口探针已验证），
//         fields=f12(代码),f14(名称),f20(总市值),f21(流通市值)——单位均为元。
//         secid 前缀：沪 1. / 深 0.（含创业板 30x）。
//
// 设计纪律（与 fetch_breadth.mjs 同族，但量级小得多故**不分片**——涨停池通常 <100 只，
//   单批 ulist 可带全）：
//   • 快照型：只记当日，落盘 data/mcap-latest.json（+ 逐日累积 data/mcap-daily.json
//     供历史分布判据用；判据需逐日累积后才不缺——历史无回填，缺=显式 null）。
//   • 重试收敛：util.fetchWithRetry 唯一出处；结构校验（data.diff 缺失视同失败）在
//     opts.read 里 → 计入重试范围。
//   • 缺失显式化：部分代码拉不到市值 → misses 清单落盘，不静默丢；全失败 → 退出非 0。
//   • 只增量追加当日：重复运行同一天覆盖 latest、daily 去重（幂等，与 breadth 同款）。
//
// 用法：node scripts/fetch_mcap.mjs [--archive data/archive.json] [--date 20260930]
//   --date 不传则取档案最新交易日。盘中运行拿的是**实时**市值（约等于当日收盘值）。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { atomicWriteJSON } from '../src/fsutil.js';
import { decodeArchive } from '../src/lhb_codec.js';
import { bjStamp } from '../src/time.js';
import { fetchWithRetry } from '../src/util.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36';
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ARCHIVE = argOf('--archive', 'data/archive.json');
const OUT_LATEST = new URL('../data/mcap-latest.json', import.meta.url);
const OUT_DAILY = new URL('../data/mcap-daily.json', import.meta.url);

// ── 1. 从档案取领涨标的（最新交易日涨停池）──────────────────────────────
const arch = decodeArchive(JSON.parse(readFileSync(ARCHIVE, 'utf8')));
const days = (arch.all_days || []).filter((d) => d && d.trade_date);
if (!days.length) { console.error('[mcap] 档案无交易日，退出'); process.exit(1); }
const last = days[days.length - 1];
const argDate = argOf('--date');
const date = argDate || last.trade_date.replace(/-/g, '');
const day = argDate ? days.find((d) => d.trade_date.replace(/-/g, '') === date) : last;
if (!day) { console.error(`[mcap] 档案中无 ${date} 这一天，退出`); process.exit(1); }

// ⚠ 存档形态：涨停池个股摊平在 day.summary（zt_codes/zt_lb），day.pools 是抓取中间
//   形态、不落档（实测全档 241 天 pools 段为 0，summary.zt_codes 才是权威出处）。
const summary = day.summary || {};
const ztCodes = Array.isArray(summary.zt_codes) ? summary.zt_codes : [];
const ztLb = summary.zt_lb || {};
if (!ztCodes.length) {
  console.error(`[mcap] ${day.trade_date} 涨停池为空（summary.zt_codes 缺失），无从取领涨标的，退出`);
  process.exit(1);
}

// ── 2. 批量拉市值（ulist.np，100 只/批）────────────────────────────────
const secidOf = (code) => {
  const c = String(code);
  if (/^(6|9)/.test(c)) return `1.${c}`;       // 沪主板/科创（688 → 1.688xxx）
  if (/^(0|2|3)/.test(c)) return `0.${c}`;     // 深主板/创业板
  if (/^(4|8)/.test(c)) return `0.${c}`;       // 北交所（本池口径通常不含）
  return `0.${c}`;
};
const LIST_URL = (secids) => `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${secids}&fields=f12,f14,f20,f21&ut=fa5fd1943c7b386f172d6893dbfba10b`;

const rows = [];
const misses = [];
const BATCH = 100;
for (let i = 0; i < ztCodes.length; i += BATCH) {
  const batch = ztCodes.slice(i, i + BATCH);
  const secids = batch.map(secidOf).join(',');
  // 结构校验进 read：data.diff 缺失/字段缺 → 抛错进重试（与 fetch_calendar 同模式）
  const diff = await fetchWithRetry(LIST_URL(secids), {
    headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
    timeout: 15000,
    read: async (r) => {
      const j = await r.json();
      const d = j?.data?.diff;
      if (!Array.isArray(d) || !d.length) throw new Error('返回结构异常：缺少 data.diff');
      return d;
    },
  }, 3, 1200);
  const byCode = new Map(diff.map((x) => [String(x.f12), x]));
  for (const c of batch) {
    const x = byCode.get(String(c));
    const circMv = x && Number.isFinite(Number(x.f21)) ? Number(x.f21) : null;
    const totalMv = x && Number.isFinite(Number(x.f20)) ? Number(x.f20) : null;
    if (circMv == null && totalMv == null) { misses.push(String(c)); continue; }
    rows.push({
      code: String(c),
      name: x && x.f14 ? String(x.f14) : null,
      circMvYi: circMv != null ? Math.round(circMv / 1e8 * 100) / 100 : null,   // 亿
      totalMvYi: totalMv != null ? Math.round(totalMv / 1e8 * 100) / 100 : null, // 亿
      lb: ztLb[c] ?? null,  // 连板数（档案直读，缺失即 null）
    });
  }
}

if (!rows.length) {
  console.error(`[mcap] ${ztCodes.length} 只领涨标的全部拉取失败，退出非 0（缺=显式失败，不落空档）`);
  process.exit(1);
}

// ── 3. 市值分布统计（判据消费的形态：小盘/中盘/大盘占比 + 中位数）───────
const YI = 1e8;
const circ = rows.map((r) => r.circMvYi).filter((v) => v != null).sort((a, b) => a - b);
const med = circ.length ? circ[Math.floor(circ.length / 2)] : null;
const smallCapPct = circ.length ? Math.round(circ.filter((v) => v < 50).length / circ.length * 1000) / 10 : null;   // <50亿
const bigCapPct = circ.length ? Math.round(circ.filter((v) => v >= 500).length / circ.length * 1000) / 10 : null;   // ≥500亿
const p25 = circ.length ? circ[Math.floor(circ.length * 0.25)] : null;
const p75 = circ.length ? circ[Math.floor(circ.length * 0.75)] : null;

const payload = {
  date: day.trade_date,
  generatedAt: bjStamp(),
  source: 'push2.eastmoney.com/api/qt/ulist.np（f20 总市值/f21 流通市值，元→亿）',
  universe: { kind: '涨停池（pools.zt_codes）', count: ztCodes.length, fetched: rows.length, misses },
  // 分布特征（regime 市值判据的消费口径；判据接入见后续——先积累快照，历史缺失=显式 null）
  stats: {
    circMvMedianYi: med,
    circMvP25Yi: p25, circMvP75Yi: p75,
    smallCapPct,   // <50亿占比：高=投机盘主导
    bigCapPct,     // ≥500亿占比：高=权重搭台
  },
  stocks: rows,
  note: '市值分布是 V5.3 市场状态识别的第五输入；快照从 2026-10 起累积，历史无回填，'
    + '判据在样本足够前一律输出 null（缺失显式化，不拿中位数猜）。',
};

atomicWriteJSON(fileURLToPath(OUT_LATEST), JSON.stringify(payload, null, 1));

// 逐日累积（幂等：同日覆盖）
let daily = { days: [] };
try { if (existsSync(OUT_DAILY)) daily = JSON.parse(readFileSync(OUT_DAILY, 'utf8')); } catch { daily = { days: [] }; }
if (!Array.isArray(daily.days)) daily.days = [];
const compact = {
  date: payload.date,
  stats: payload.stats,
  n: rows.length,
  misses: misses.length,
};
const idx = daily.days.findIndex((d) => d.date === payload.date);
if (idx >= 0) daily.days[idx] = compact; else daily.days.push(compact);
daily.days.sort((a, b) => (a.date < b.date ? -1 : 1));
atomicWriteJSON(fileURLToPath(OUT_DAILY), JSON.stringify(daily, null, 1));

console.log(`[mcap] ${payload.date} 领涨标的 ${rows.length}/${ztCodes.length} 只`
  + `${misses.length ? `（${misses.length} 只拉取失败已记 misses）` : ''}`);
console.log(`[mcap] 流通市值中位数 ${med}亿 | <50亿占比 ${smallCapPct}% | ≥500亿占比 ${bigCapPct}%`);
console.log(`[mcap] 写出 data/mcap-latest.json 与 data/mcap-daily.json（累积 ${daily.days.length} 天）`);
