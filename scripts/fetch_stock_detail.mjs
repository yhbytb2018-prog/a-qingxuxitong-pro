#!/usr/bin/env node
// ── 个股级涨跌停明细采集（data/stock_detail.json）──────────────────────────
//
// 用途：从东方财富题材池 API 抓当日涨停池 / 跌停池 / 炸板池的**个股级**明细
//   （连板数、首次封板时间、封单额、炸板次数、行业板块），喂活 reports_html/
//   的 dualview / mainboard / mindmap / predict / prejudge / wave2 / auction
//   七个栏目——这是它们共同的个股级数据源。
//
// 用法：
//   node scripts/fetch_stock_detail.mjs                 # 抓最新交易日（默认今天）
//   node scripts/fetch_stock_detail.mjs --date 2026-10-12
//
// 纪律：只写 data/stock_detail.json 一个文件；缺失/失败置 null 不补 0；
//   涨跌幅等数值保持 API 原始精度，渲染层不做复算口径。
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const dateArg = (() => { const i = argv.indexOf('--date'); return i >= 0 ? argv[i + 1] : null; })();

const ymd = (dateArg ?? new Date().toISOString().slice(0, 10)).replaceAll('-', '');
const UT = '7eea3edcaed734bea9cbfc24409ed989';
const BASE = 'https://push2ex.eastmoney.com';

const fetchPool = async (kind) => {
  const url = `${BASE}/getTopic${kind}Pool?ut=${UT}&dpt=wz.ztzt&Pageindex=0&pagesize=1000&sort=fbt%3Aasc&date=${ymd}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${kind} HTTP ${res.status}`);
  const j = await res.json();
  return j?.data?.pool ?? null; // 非交易日 / 未出数据 → null
};

// 原始字段 → 渲染友好字段（只重命名/除权，不复算口径）
const norm = (r) => r && ({
  code: r.c,
  name: r.n,
  market: r.m,                    // 0=深 1=沪
  pct: r.zdp,                     // 涨跌幅 %
  price: r.p != null ? r.p / 1000 : null,      // 现价（API ×1000）
  amount: r.amount ?? null,       // 成交额 元
  floatMcap: r.ltsz ?? null,      // 流通市值 元
  lb: r.lbc ?? null,              // 连板数
  firstSeal: r.fbt ?? null,       // 首次封板 HHMMSS
  lastSeal: r.lbt ?? null,        // 最后封板 HHMMSS
  sealFund: r.fund ?? null,       // 封板资金 元
  brokenTimes: r.zbc ?? null,     // 炸板次数
  industry: r.hybk ?? null,       // 行业板块
  streak: r.zttj ? { days: r.zttj.days, count: r.zttj.ct } : null, // N天M板
});

const fail = [];
const grab = async (kind) => {
  try { return await fetchPool(kind); } catch (e) { fail.push(`${kind}: ${e.message}`); return null; }
};

const [ztRaw, dtRaw, zbRaw] = await Promise.all([grab('ZT'), grab('DT'), grab('ZB')]);

if (ztRaw == null && dtRaw == null && zbRaw == null) {
  console.error(`[stock-detail] 三池全部失败：${fail.join('；') || '非交易日或当日未出数据'}（不写文件）`);
  process.exit(1);
}

const out = {
  kind: 'stock-detail',
  version: 1,
  generatedAt: new Date().toISOString(),
  tradeDate: ymd,
  source: 'eastmoney-topic-pool',
  failed: fail.length ? fail : undefined,
  counts: { zt: ztRaw?.length ?? null, dt: dtRaw?.length ?? null, zb: zbRaw?.length ?? null },
  zt: ztRaw?.map(norm) ?? null,   // 涨停池（含连板梯队）
  dt: dtRaw?.map(norm) ?? null,   // 跌停池
  zb: zbRaw?.map(norm) ?? null,   // 炸板池
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(join(ROOT, 'data', 'stock_detail.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`[stock-detail] ${ymd} 涨停 ${out.counts.zt ?? '—'} / 跌停 ${out.counts.dt ?? '—'} / 炸板 ${out.counts.zb ?? '—'} → data/stock_detail.json${fail.length ? `（部分失败：${fail.join('；')}）` : ''}`);
