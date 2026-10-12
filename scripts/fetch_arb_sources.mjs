#!/usr/bin/env node
// ── 转债/正股联动背离采集（data/arb_sources.json · 套利日报数据源）──────────
//
// 用途：拉在市可转债清单（东财数据中心，DELIST_DATE 为空 = 在市）→
//   腾讯行情批量抓转债与正股当日涨跌幅 → 算「转债-正股涨跌幅差」，
//   喂活 reports_html/ 的 arb 栏目（联动背离 = 转债短线套利的主要扫描面）。
//
// 用法：node scripts/fetch_arb_sources.mjs
//
// 纪律：只写 data/arb_sources.json；接口失败置 null 不补 0；差值是两个
//   行情字段之差（同一时点快照），不属于口径复算。
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 1) 在市转债清单（东财数据中心，翻页取全）────────────────────────────────
const cbList = [];
for (let page = 1; page <= 10; page++) {
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_BOND_CB_LIST&columns=SECURITY_CODE,SECURITY_NAME_ABBR,TRADE_MARKET,DELIST_DATE,CONVERT_STOCK_CODE&pageSize=500&pageNumber=${page}&source=WEB&client=WEB`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`CB list HTTP ${res.status}`);
  const j = await res.json();
  const rows = j?.result?.data ?? [];
  cbList.push(...rows);
  if (page >= (j?.result?.pages ?? 1)) break;
}
const alive = cbList.filter((x) => !x.DELIST_DATE && x.CONVERT_STOCK_CODE);
if (!alive.length) {
  console.error('[arb] 在市转债清单为空（接口失败或全页翻空），不写文件');
  process.exit(1);
}

// ── 2) 腾讯批量行情（转债 + 正股，60 个一批）────────────────────────────────
const tencentCode = (code) => {
  const c = String(code);
  if (/^(11|50)/.test(c)) return `sh${c}`;
  if (/^(12|51)/.test(c)) return `sz${c}`;
  if (/^(3|0)/.test(c)) return `sz${c}`;
  return `sh${c}`; // 6 开头 → 沪
};
const quote = async (codes) => {
  if (!codes.length) return {};
  const res = await fetch(`https://qt.gtimg.cn/q=${codes.join(',')}`, {
    headers: { Referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`quote HTTP ${res.status}`);
  const text = new TextDecoder('gbk').decode(await res.arrayBuffer());
  const map = {};
  for (const m of text.matchAll(/v_(?:[a-z]+)(\w{6})="([^"]*)"/g)) {
    const f = m[2].split('~');
    if (f.length < 33) continue;
    map[m[1]] = { name: f[1], price: Number(f[3]) || null, pct: f[32] !== '' ? Number(f[32]) : null };
  }
  return map;
};

const bondCodes = alive.map((x) => x.SECURITY_CODE);
const stockCodes = [...new Set(alive.map((x) => x.CONVERT_STOCK_CODE))];
const qBond = await quote(bondCodes.map(tencentCode));
const qStock = await quote(stockCodes.map(tencentCode));

// ── 3) 组装：转债-正股涨跌幅差排序 ──────────────────────────────────────────
const items = alive.map((x) => {
  const b = qBond[x.SECURITY_CODE] ?? null;
  const s = qStock[x.CONVERT_STOCK_CODE] ?? null;
  const gap = b?.pct != null && s?.pct != null ? Number((b.pct - s.pct).toFixed(2)) : null;
  return {
    bondCode: x.SECURITY_CODE,
    bondName: b?.name ?? x.SECURITY_NAME_ABBR,
    price: b?.price ?? null,
    pct: b?.pct ?? null,
    stockCode: x.CONVERT_STOCK_CODE,
    stockName: s?.name ?? null,
    stockPct: s?.pct ?? null,
    gap, // 转债% − 正股%，正 = 转债强于正股
  };
}).filter((x) => x.pct != null || x.stockPct != null);

items.sort((a, b) => (b.gap ?? -999) - (a.gap ?? -999));

const out = {
  kind: 'arb-sources',
  version: 1,
  generatedAt: new Date().toISOString(),
  tradeDate: new Date().toISOString().slice(0, 10),
  source: 'eastmoney-cb-list + tencent-quote',
  counts: { listed: alive.length, quoted: items.length },
  items,
};
writeFileSync(join(ROOT, 'data', 'arb_sources.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`[arb] 在市 ${alive.length} 只，有报价 ${items.length} 只 → data/arb_sources.json`);
