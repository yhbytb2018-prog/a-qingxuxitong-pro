// 指数日收益历史回填（2026-10-05 拍板）：补齐 archive 存量天的 indexes 缺口。
//
// 背景（诊断发现，tools/backtest/diagnose_v52.mjs）：
//   archive 的 indexes（三指数日涨跌幅）只有 2026-08-14 起的 33 天有值，此前 208 天
//   为 null。scripts/backtest.mjs 的回退分支把缺失日按 **0 收益** 处理——V5.2 回测的
//   「6% 持仓日胜率」「-1.255 夏普」等全部数字里，86% 的样本日是算术产物而非市场行为。
//   缺失还让 version_regression 的主样本（需次日收益）从 240 天缩到 33 天。
//
// 数据源：腾讯 ifzq 指数日K（与 src/sources.js fetchIndexes 的实时源同 vendor——
//   同源可对账；前复权对指数无差异，收盘价即真值）。涨跌幅 = 相邻两根日K收盘的
//   r2((close/prev-1)*100)，与 fetchIndexes 的 f[32]（涨跌幅，r2）同口径。
//
// 口径留痕（硬纪律）：回填日的 summary.indexes_caliber = 'kline-backfill'——
//   与 pools_caliber 同款语义。存量 EM 采集天不_touch_（无留痕 = 实时采集），
//   消费方据此区分「指数值可直读但 hot[] 是空壳」的回填天与 EM 采集天
//   （test/merge_ui.test.mjs 的判据同步更新，见该测试注释）。
//
// 门禁（对账优先于写盘）：
//   重叠期（已有 EM 真值的 33 天）逐日比对存档值 vs K线重算值，**三个指数全部
//   |diff| ≤ 0.01** 才放行——对不上的说明口径假设错了，此时回填的 208 天同样不可信。
//
// 用法：
//   node scripts/backfill_indexes.mjs                  # 门禁对账 + 缺口统计（不写盘）
//   node scripts/backfill_indexes.mjs --apply          # 填值 + recalcAll 全档重算 + 留痕 + 写盘 + 重建切片
//   node scripts/backfill_indexes.mjs --apply --recalc # 无新增缺口时仍强制 recalcAll（修复中间态：
//                                                     #   已填值但未重算——recalcAll 的派生字段
//                                                     #   （industry_relative 等）依赖 indexes，
//                                                     #   填值后必须全档重算一次才能恢复
//                                                     #   「磁盘 = recalcAll 规范形」的幂等不变量）
import dns from 'node:dns';
import { atomicWriteJSON } from '../src/fsutil.js';
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeArchive, writeArchiveSafely, appendNote } from '../src/lhb_codec.js';
import { recalcAll } from '../src/pipeline.js';

dns.setDefaultResultOrder('ipv4first');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(ROOT, 'data', 'archive.json');
const KDIR = path.join(ROOT, 'data', '.bt_kline');
const APPLY = process.argv.includes('--apply');
const FORCE_RECALC = process.argv.includes('--recalc');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36';
const ASSETS = ['上证指数', '深证成指', '创业板指'];
const SYMS = { 上证指数: 'sh000001', 深证成指: 'sz399001', 创业板指: 'sz399006' };
const r2 = (v) => Math.round(v * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── K 线获取（缓存优先；与 scripts/backtest_strategies.mjs getKline 同款协议）──
// 缓存形态 {date,open,close}[] 与 .bt_kline 既有缓存一致（该目录 gitignore、可重建）。
async function getKline(sym, minLen = 380) {
  const cache = path.join(KDIR, sym + '.json');
  if (existsSync(cache)) {
    const k = JSON.parse(readFileSync(cache, 'utf8'));
    if (Array.isArray(k) && k.length >= minLen) return k;
  }
  for (let att = 0; att < 3; att++) {
    try {
      const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},day,,,500,qfq`;
      const j = await (await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' } })).json();
      const node = j && j.data && j.data[sym];
      const rows = node && (node.qfqday || node.day);
      if (!Array.isArray(rows) || rows.length < minLen) throw new Error(`K线过短(${rows ? rows.length : 0} < ${minLen})`);
      const k = rows.map((r) => ({ date: String(r[0]), open: +r[1], close: +r[2] }))
        .filter((x) => Number.isFinite(x.open) && x.open > 0 && Number.isFinite(x.close) && x.close > 0);
      mkdirSync(KDIR, { recursive: true });
      atomicWriteJSON(cache, JSON.stringify(k));
      return k;
    } catch (e) {
      if (att === 2) throw new Error(`${sym} 指数日K获取失败: ${e.message}`);
      await sleep(800 * (att + 1));
    }
  }
}

// ── 主流程 ──
const arc = decodeArchive(JSON.parse(readFileSync(MAIN, 'utf8')));
const days = (arc.all_days || []).filter((d) => d && d.trade_date);
if (days.length < 5) { console.error('[idx-backfill] 档案天数不足'); process.exit(1); }

// 三指数日K → 逐日涨跌幅（相邻收盘；首根无前收 → 无值）
const pctByAsset = {};
for (const name of ASSETS) {
  const k = await getKline(SYMS[name]);
  const pct = new Map();
  for (let i = 1; i < k.length; i++) {
    if (k[i - 1].close > 0) pct.set(k[i].date, r2((k[i].close / k[i - 1].close - 1) * 100));
  }
  pctByAsset[name] = pct;
  console.log(`[idx-backfill] ${SYMS[name]} ${name}: 日K ${k.length} 根（${k[0].date} ~ ${k[k.length - 1].date}），可算涨跌幅 ${pct.size} 天`);
}

// 缺口分类：全缺（三指数皆无 → 回填对象）/ 全有（EM 真值 → 对账样本）/ 半缺（口径异常，不碰）
const gapDays = [], emDays = [], partialDays = [];
for (const d of days) {
  const idx = d.indexes || {};
  const present = ASSETS.filter((a) => Number.isFinite(idx[a]));
  if (present.length === ASSETS.length) emDays.push(d);
  else if (present.length === 0) gapDays.push(d);
  else partialDays.push({ date: d.trade_date, present });
}
console.log(`[idx-backfill] 档案 ${days.length} 天：EM 真值 ${emDays.length} · 全缺（回填对象）${gapDays.length} · 半缺（口径异常）${partialDays.length}`);

// ── 门禁：重叠期对账（EM 真值 vs K 线重算，逐日逐指数） ──
let cmpDays = 0, cmpVals = 0, exact = 0, worst = 0;
const badDiffs = [];
for (const d of emDays) {
  const row = [];
  let any = false;
  for (const a of ASSETS) {
    const kv = pctByAsset[a].get(d.trade_date);
    if (kv == null) { row.push(`${a}:K线无该日`); continue; }
    const diff = Math.abs(kv - d.indexes[a]);
    cmpVals++;
    if (diff === 0) exact++;
    worst = Math.max(worst, diff);
    if (diff > 0.01) { any = true; row.push(`${a}: ${kv} ≠ ${d.indexes[a]}(Δ${diff.toFixed(2)})`); }
    else if (diff > 0) row.push(`${a}: Δ${diff.toFixed(2)}`);
  }
  if (row.length) cmpDays++;
  if (any) badDiffs.push(`  ${d.trade_date}: ${row.join(' · ')}`);
}
console.log(`[gate] 对账 ${emDays.length} 天 / ${cmpVals} 值：精确 ${exact} · 最大偏差 ${worst.toFixed(2)} · 超容差(>0.01) ${badDiffs.length}`);
if (badDiffs.length) {
  console.error('[gate] ✘ 重叠期对账失败——K线口径与 EM 实时快照不一致，回填值不可信：');
  console.error(badDiffs.slice(0, 10).join('\n'));
  process.exit(1);
}
console.log('[gate] ✔ 对账通过（K 线重算与 EM 实时快照同口径）');

// ── 回填预演：缺口日 → 三指数K线涨跌幅 ──
let fillable = 0, noAnchor = [];
for (const d of gapDays) {
  const vals = {};
  let ok = true;
  for (const a of ASSETS) {
    const v = pctByAsset[a].get(d.trade_date);
    if (v == null) { ok = false; break; }
    vals[a] = v;
  }
  if (ok) { fillable++; d._fill = vals; } else noAnchor.push(d.trade_date);
}
console.log(`[plan] 可回填 ${fillable}/${gapDays.length} 天${noAnchor.length ? ` · 无K线锚点 ${noAnchor.length} 天（保持 null，如实缺失）: ${noAnchor.slice(0, 5).join('、')}${noAnchor.length > 5 ? '…' : ''}` : ''}`);
if (partialDays.length) {
  console.warn(`[plan] ⚠ 半缺日（有部分指数真值）不回填，需人工核口径：${partialDays.map((p) => `${p.date}(${p.present.join(',')})`).join('、')}`);
}

if (!APPLY) { console.log('[idx-backfill] 未带 --apply，仅对账与统计，不写盘'); process.exit(0); }

// ── 落盘（带口径留痕 + 全档重算） ──
let written = 0;
for (const d of gapDays) {
  if (!d._fill) continue;
  d.indexes = { ...d._fill };
  d.summary = d.summary || {};
  d.summary.indexes_caliber = 'kline-backfill';
  delete d._fill;
  written++;
}
const backfilledTotal = days.filter((d) => d.summary?.indexes_caliber === 'kline-backfill').length;
if (written === 0 && !FORCE_RECALC) {
  console.log('[idx-backfill] 无新增缺口（已回填过），未带 --recalc，跳过重算与写盘');
  process.exit(0);
}

// 全档重算（对齐 backfill_gaps.mjs 的 --apply 模式）：indexes 是 recalcAll 派生字段
// （industry_relative 的 vs 上证基准）的输入——填值后必须重算一次，否则磁盘态
// 与 recalcAll 输出分裂（test/pipeline_scope.test.mjs 的「skip 的天逐字节不变」会红）。
console.log('[idx-backfill] recalcAll 全档重算…');
recalcAll(arc.all_days);

const at = new Date().toISOString();
arc.meta = arc.meta || {};
arc.meta.note = appendNote(arc,
  `指数日收益回填 ${at.slice(0, 10)}：${backfilledTotal} 个存量日的 indexes 缺口（三指数日涨跌幅）由腾讯指数日K重建`
  + `（相邻收盘 r2((close/prev-1)*100)，与实时源同 vendor 同口径），summary.indexes_caliber='kline-backfill' 留痕；`
  + `门禁逐日对账 ${emDays.length} 天/${cmpVals} 值（EM 真值交叉验证 + 回填日复核）最大偏差 ${worst.toFixed(2)}，零异常。`
  + '回测/回归的次日收益原料自此覆盖全档（此前 208 天缺失被按 0 收益回退，见 2026-10-05 诊断事故）。'
  + '派生字段经 recalcAll 全档重算（industry_relative 由中位数降级恢复 vs 上证双基准）。');

writeArchiveSafely(MAIN, arc, { writeFileSync, renameSync, unlinkSync });
console.log(`[idx-backfill] ✔ 已写入 ${written} 天新增（累计回填 ${backfilledTotal} 天），主档 ${MAIN}`);

// 切片重建（主档变了，切片必须同源——与 backfill_gaps 同款 spawn）
const { spawnSync } = await import('node:child_process');
const rr = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'split_archive.mjs')], { stdio: 'inherit' });
if (rr.status !== 0) { console.error('[idx-backfill] ⚠ 切片重建失败——主档已更新，请手动跑 split_archive'); process.exit(1); }
console.log('[idx-backfill] 切片已重建 · 完成。后续必跑：backtest → version_regression → node --test');
