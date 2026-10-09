// 一次性修复：从存量 archive 的 seats.detail 里剔除「类别汇总行」污染，并**只扣减**这些行
// 在分项汇总里造成的虚增，不重算卖侧（存档 detail 多为 v1 仅买方，重算会把真实卖侧抹成 0）。
//
// 背景：东财席位明细接口对部分票（尤其区间累计榜）会返回
// 「自然人/中小投资者/机构/其他自然人」这类投资者结构汇总行，历史上被 classifySeat 判成 hot（游资）
// 计入 inst/north/hot 分项与买方集中度。
//
// 修复策略（最小改动、可复算）：
//   ① detail：剔除汇总行（净化落盘）；
//   ② 分项：从 inst/hot/north 的 buy/sell 里减去「总扣减额」——按被剔除行在**票内**的归属
//      （classifySeat）累计。由于汇总行一律判 hot，几乎只影响 hot_buy；仍按实际归类扣，避免想当然。
//   ③ 集中度：按净化后的买方明细重算 buy_top3_pct 与 conc_top（这两项只依赖买方，可安全重算）。
//
// 用法：node scripts/repair_seats_aggregate_rows.mjs [--dry]
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { isAggregateSeatRow } from '../src/seats.js';
import { decodeArchive, writeArchiveSafely } from '../src/lhb_codec.js';

const FILE = 'data/archive.json';
const DRY = process.argv.includes('--dry');
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const classifySeat = (name) => {
  const t = String(name || '');
  if (t.includes('机构专用')) return 'inst';
  if (t.includes('沪股通') || t.includes('深股通')) return 'north';
  return 'hot';
};

// 存档是压缩态（reason→rc 码表 + lhb 提子），读进来必须先解码成明文再改。
const a = decodeArchive(JSON.parse(readFileSync(FILE, 'utf8')));
let touchedDays = 0, removedRows = 0, affectedStocks = 0;

for (const d of a.all_days) {
  const s = d.summary && d.summary.seats;
  if (!s || !s.detail) continue;
  let dayTouched = false;
  // 按 classifySeat 归类累计「应扣减」金额（亿元），买卖分开
  const deduct = { inst_buy: 0, inst_sell: 0, north_buy: 0, north_sell: 0, hot_buy: 0, hot_sell: 0 };

  for (const [code, raw] of Object.entries(s.detail)) {
    const isArr = Array.isArray(raw);
    const b = isArr ? raw : (raw.b || []);
    const sv = isArr ? [] : (raw.s || []);
    const badB = b.filter(([nm]) => isAggregateSeatRow(nm));
    const badS = sv.filter(([nm]) => isAggregateSeatRow(nm));
    if (!badB.length && !badS.length) continue;
    removedRows += badB.length + badS.length;
    affectedStocks++;
    dayTouched = true;
    for (const [nm, wan] of badB) deduct[classifySeat(nm) + '_buy'] += wan / 1e4;
    for (const [nm, wan] of badS) deduct[classifySeat(nm) + '_sell'] += wan / 1e4;
    const nb = b.filter(([nm]) => !isAggregateSeatRow(nm));
    const ns = sv.filter(([nm]) => !isAggregateSeatRow(nm));
    s.detail[code] = isArr ? nb : { b: nb, s: ns };
  }
  if (!dayTouched) continue;
  touchedDays++;

  // ② 扣减分项（保留未被污染的原始卖侧，不重算）
  const before = {};
  for (const k of Object.keys(deduct)) {
    if (s[k] == null) { before[k] = s[k]; continue; }
    before[k] = s[k];
    s[k] = r2(s[k] - deduct[k]);
    if (s[k] < 0) s[k] = 0; // 防御：扣减后不应为负（若为负说明存档本身异常，钳到 0 并留痕）
  }

  // ③ 重算买方集中度（只依赖买方，安全）
  const concAll = [];
  const seatBuy = {};
  let buyAll = 0;
  for (const [code, raw] of Object.entries(s.detail)) {
    const rows = Array.isArray(raw) ? raw : (raw.b || []);
    if (rows.length >= 3) {
      const vals = rows.map((x) => x[1]).sort((x, y) => y - x);
      const tot = vals.reduce((x, y) => x + y, 0);
      if (tot > 0) concAll.push([code, r1(vals.slice(0, 3).reduce((x, y) => x + y, 0) / tot * 100)]);
    }
    for (const [nm, wan] of rows) { const yuan = wan * 1e4; seatBuy[nm] = (seatBuy[nm] || 0) + yuan; buyAll += yuan; }
  }
  const nameOf = new Map((d.lhb_aggr || []).map((l) => [l.code, l.name]));
  const beforeTop3 = s.buy_top3_pct, beforeConc = (s.conc_top || []).map(([n, p]) => `${n}(${p}%)`).join(' / ');
  s.conc_top = concAll.sort((x, y) => y[1] - x[1]).slice(0, 5).map(([c, p]) => [nameOf.get(c) || c, p]);
  if (buyAll > 0) {
    const tops = Object.entries(seatBuy).sort((x, y) => y[1] - x[1]).slice(0, 3);
    s.buy_top3_pct = r1(tops.reduce((x, [, v]) => x + v, 0) / buyAll * 100);
  }

  const f = (k) => `${k} ${before[k]}→${s[k]}`;
  console.log(`[${d.trade_date}] 扣减明细行 ${Object.entries(deduct).filter(([, v]) => v).map(([k, v]) => `${k} −${r2(v)}`).join(' ')}`);
  console.log(`        分项 机构买/卖 ${s.inst_buy}/${s.inst_sell}｜北向 ${s.north_buy}/${s.north_sell}｜游资 ${s.hot_buy}/${s.hot_sell}`);
  console.log(`        集中度 top3 ${beforeTop3}%→${s.buy_top3_pct}%｜个股TOP5 ${s.conc_top.map((x) => x.join(' ')).join(' / ')}`);
  if (beforeConc) console.log(`        （原）${beforeConc}`);
}

console.log('');
console.log(`整理：${touchedDays} 天受影响，剔除 ${removedRows} 行汇总行，涉及 ${affectedStocks} 只票`);
if (DRY) console.log('（--dry 未写盘）');
else {
  // 必须重编码写回（直接 stringify 会把压缩档解压成 9.2MB，且丢掉 rc 的可读性）
  writeArchiveSafely(FILE, a, { writeFileSync, renameSync, unlinkSync });
  console.log('已写盘', FILE);
}
