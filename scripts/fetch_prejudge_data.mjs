#!/usr/bin/env node
// ── 盘中预判数据采集（data/prejudge_detail.json）────────────────────────────
//
// 用途：东财 push2 clist 拉**创业板+科创板全量**快照（含 f160 10日涨幅），
//   复现模板策略链路：10日涨幅前60 → 逐票硬过滤 → 通过池 → 主力资金交叉
//   验证 → 板块合力评级。产物喂活 reports_html/ 的盘中预判栏目。
//
// 用法：
//   node scripts/fetch_prejudge_data.mjs                 # 默认前60
//   node scripts/fetch_prejudge_data.mjs --n 80
//
// 口径（对齐模板 prejudge/20261009.html 第九节前的规则）：
//   硬过滤淘汰项：冲高回落>2% ／ 换手>15% ／ 涨停买不进 ／ 当前涨幅>15% ／
//     10日涨幅>80% ／ 超高价>250元 ／ 当前下跌
//   组合A：通过池 ∩ 主力净额≥1亿；组合B：通过池 ∩ 主力净额≥5000万
//   涨停线：创业板 19.9%+（20cm）；冲高回落 = (日内高 − 现价) / 昨收
//
// 依赖：push2.eastmoney.com（clist）。本地网络拉不通时产物缺失 → 页面按
//   缺失标注降级；GitHub Actions runner 网络可达（主生成环境）。
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const N = (() => { const i = argv.indexOf('--n'); return i >= 0 ? Math.max(10, Number(argv[i + 1]) || 60) : 60; })();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
// 创业板(0+t:80) + 科创板(1+t:81)；f160=10日涨跌幅, f62=主力净额, f8=换手, f15=日内高, f18=昨收
const CLIST = (fid, pn) => `https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=${fid}` +
  `&fs=m:0+t:80,m:1+t:81&fields=f12,f14,f2,f3,f5,f6,f8,f9,f15,f16,f17,f18,f62,f100,f109,f160,f24`;

const fetchJson = async (url) => {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/center/' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (!j?.data?.diff) throw new Error('响应无 data.diff');
  return j;
};

const grab = async (url) => { try { return await fetchJson(url); } catch (e) { console.error(`[prejudge] 抓取失败 ${url.slice(30, 80)}…: ${e.message}`); return null; } };

// ── 1) 10日涨幅榜（创科全量按 f160 降序，取前 N；pagesz=100 → 1 页够 60）────
const rankJson = await grab(CLIST('f160', 1));
if (!rankJson) {
  console.error('[prejudge] push2 不可达，不写文件（页面将按缺失标注降级）');
  process.exit(1);
}
const all = Object.values(rankJson.data.diff).map((d) => ({
  code: String(d.f12 ?? ''), name: d.f14 ?? null,
  price: d.f2, pct: d.f3,               // 现价 / 当日涨跌幅 %
  volume: d.f5, amount: d.f6,           // 量（手）/ 成交额（元）
  turnover: d.f8,                       // 换手率 %
  pe: d.f9, high: d.f15, low: d.f16, open: d.f17, prevClose: d.f18,
  mainNet: d.f62,                       // 主力净额（元）'-' → null
  industry: d.f100 ?? null,
  pct5d: d.f109, pct10d: d.f160, pct60d: d.f24,
}));
const rankTop = all.slice(0, N);

// ── 2) 主力资金榜（全创科按 f62 降序，前 3 页）─────────────────────────────
const fundsRows = [];
for (let pn = 1; pn <= 3; pn++) {
  const j = await grab(CLIST('f62', pn));
  if (!j) break;
  fundsRows.push(...Object.values(j.data.diff).map((d) => ({ code: String(d.f12 ?? ''), name: d.f14 ?? null, mainNet: d.f62, pct: d.f3, turnover: d.f8, pe: d.f9, industry: d.f100 ?? null })));
}
const mainFunds = fundsRows.filter((r) => typeof r.mainNet === 'number' && r.mainNet >= 5e7)
  .sort((a, b) => b.mainNet - a.mainNet).slice(0, 30);

// ── 3) 硬过滤（rankTop 逐票）────────────────────────────────────────────────
const pctNum = (v) => (typeof v === 'number' ? v : null);
const limitPct = (code) => (code.startsWith('30') || code.startsWith('68') ? 19.9 : 9.9); // 创科 20cm
const evaluated = rankTop.map((s) => {
  const p = pctNum(s.pct), high = pctNum(s.high), prev = pctNum(s.prevClose), t = pctNum(s.turnover), p10 = pctNum(s.pct10d);
  const pullback = high != null && p != null && prev ? Number((((high - s.price) / prev) * 100).toFixed(2)) : null;
  const reasons = [];
  if (pullback != null && pullback > 2) reasons.push(`冲高回落${pullback}%`);
  if (t != null && t > 15) reasons.push(`换手${t}%`);
  if (p != null && prev && p >= limitPct(s.code)) reasons.push('涨停买不进');
  if (p != null && p > 15) reasons.push(`当前涨幅${p}%`);
  if (p10 != null && p10 > 80) reasons.push(`10日涨幅${p10}%`);
  if (s.price != null && s.price > 250) reasons.push('超高价>250元');
  if (p != null && p < 0) reasons.push('当前下跌');
  return { ...s, pullback, eliminated: reasons.length > 0, reasons };
});
const passed = evaluated.filter((s) => !s.eliminated);
const eliminated = evaluated.filter((s) => s.eliminated);

// 淘汰原因计数（按第一命中原因）
const reasonCount = {};
for (const e of eliminated) {
  const key = (e.reasons[0] ?? '').replace(/[\d.]+%?.*$/, (m) => m).replace(/^冲高回落.*/, '冲高回落>2%')
    .replace(/^换手.*/, '换手>15%').replace(/^当前涨幅.*/, '当前涨幅>15%').replace(/^10日涨幅.*/, '10日涨幅>80%');
  reasonCount[key] = (reasonCount[key] ?? 0) + 1;
}

// ── 4) 组合 A/B（资金门槛；主力净额缺失 → 门槛判定缺失不臆造）───────────────
const combA = passed.filter((s) => typeof s.mainNet === 'number' && s.mainNet >= 1e8);
const combB = passed.filter((s) => typeof s.mainNet === 'number' && s.mainNet >= 5e7);
const fundsAvailable = passed.some((s) => typeof s.mainNet === 'number');

// ── 5) 板块合力评级（通过池按行业聚合，涨幅>3% 计强势票）────────────────────
const syn = new Map();
for (const s of passed) {
  const k = s.industry ?? '未分类';
  if (!syn.has(k)) syn.set(k, []);
  syn.get(k).push(s);
}
const synergy = [...syn.entries()].map(([k, rs]) => ({
  industry: k,
  strong: rs.filter((s) => (pctNum(s.pct) ?? 0) > 3).length,
  count: rs.length,
  members: rs.map((s) => `${s.name} ${(s.pct ?? 0) >= 0 ? '+' : ''}${s.pct}%`).join(' / '),
})).sort((a, b) => b.strong - a.strong || b.count - a.count);

const out = {
  kind: 'prejudge-detail',
  version: 1,
  generatedAt: new Date().toISOString(),
  source: 'eastmoney-push2-clist (f160 排序)',
  rankN: N,
  counts: {
    rank: rankTop.length,
    passed: passed.length,
    eliminated: eliminated.length,
    mainFunds: mainFunds.length,
    combA: combA.length,
    combB: combB.length,
    fundsAvailable,
  },
  reasonCount,
  passed, eliminated, mainFunds,
  combA, combB, synergy,
};
const path = join(ROOT, 'data', 'prejudge_detail.json');
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify(out, null, 1) + '\n');
console.log(`[prejudge] 10日涨幅前${N}：通过 ${passed.length} / 淘汰 ${eliminated.length}；主力≥5000万 ${mainFunds.length} 只；组合A ${combA.length} / B ${combB.length} → data/prejudge_detail.json`);
