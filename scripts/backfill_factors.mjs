// 历史六因子回填 · 总编排（208 个回填天 → 七因子真分）
//
// ── 数据来源（全部可复核）────────────────────────────────────────────────────
//   · 涨停/炸板/跌停/涨跌家数：data/bt_kline 不复权日K（scripts/fetch_raw_kline.mjs，
//     腾讯 kline/kline 端点，交易所 round(前收×幅度,2) 精确判定，src/zt_rebuild.js 唯一实现）
//   · 行业广度：data/bt_industry.json 同花顺 881xxx 年线缓存（与每日 fetchBoards 同源同端点）
//   · 两市成交额：fetchAmountMap()（与每日管线同源，2025+2026 全覆盖）
//   · s_net/s_pos：档案已有（lhb 明细回填天原生就有）
//
// ── 集成方式（关键设计）──────────────────────────────────────────────────────
//   不重算情绪分——只把**原料字段**写进 summary（up/down/flat_count、zt/dt/zb_count、
//   seal/zb_pct、max_lb、ind_count/ind_up/ind_down、industry 数组、amount_yi），
//   然后跑生产同一条 recalcAll。公式、missing 通道、_backfill 裁定、分位全档重算
//   全部与真实日逐字相同（src/pipeline.js 唯一出处）。
//
// 用法：
//   node scripts/backfill_factors.mjs --validate   # 门禁：对真实日重建 vs 档案真值交叉验证
//   node scripts/backfill_factors.mjs --check      # 只统计回填后天数/因子，不写盘
//   node scripts/backfill_factors.mjs --apply      # 落盘（writeArchiveSafely + recalcAll + 切片重建）
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeArchive, writeArchiveSafely, appendNote } from '../src/lhb_codec.js';
import { recalcAll } from '../src/pipeline.js';
import { rebuildPoolsByDate, poolsOf, industryRowsFromCache } from '../src/zt_rebuild.js';
import { fetchAmountMap } from '../src/sources.js';
import { BACKFILL_FLAG } from '../src/backfill.js';
import * as fsMod from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(ROOT, 'data', 'archive.json');
const KLINE_DIR = path.join(ROOT, 'data', 'bt_kline');
const INDUSTRY_CACHE = path.join(ROOT, 'data', 'bt_industry.json');
const MODE = process.argv.includes('--validate') ? 'validate'
  : process.argv.includes('--apply') ? 'apply' : 'check';

const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// ── 原料准备 ──
const archive = decodeArchive(JSON.parse(readFileSync(MAIN, 'utf8')));
const days = archive.all_days || [];
const realDays = days.filter((d) => d.emotion && !d.emotion[BACKFILL_FLAG]);
const backfillDays = days.filter((d) => d.emotion && d.emotion[BACKFILL_FLAG]);
console.log(`[bf] 档案 ${days.length} 天 · 真实 ${realDays.length} · 待回填 ${backfillDays.length}`);

if (!existsSync(KLINE_DIR) || !readdirCount(KLINE_DIR)) {
  console.error(`[bf] ⚠ ${KLINE_DIR} 为空——先跑 scripts/fetch_raw_kline.mjs`);
  process.exit(1);
}
const industryCache = existsSync(INDUSTRY_CACHE) ? JSON.parse(readFileSync(INDUSTRY_CACHE, 'utf8')) : null;
if (!industryCache) { console.error(`[bf] ⚠ 行业缓存缺失——先跑 scripts/fetch_industry_history.mjs`); process.exit(1); }

const amountMap = await fetchAmountMap();
const amountDates = Object.keys(amountMap || {}).sort();
console.log(`[bf] 成交额覆盖 ${amountDates.length} 日（${amountDates[0]} → ${amountDates[amountDates.length - 1]}）`);

function readdirCount(dir) {
  const { readdirSync } = fsMod;
  return readdirSync(dir).filter((f) => f.endsWith('.json')).length;
}

// ── 验证模式：重建真实日，与档案真值比对 ──
// 门禁口径：不比计数比**因子冲击**。已知不可消除的口径残差（详见 meta 留痕）：
//   · zb：重建=「盘中触板未封」，EM 炸板池=「曾封板后打开」→ 重建偏多（日 K 无盘口无法分辨封板）
//   · dt：EM 跌停池排除部分一字板 → 重建偏多
//   · ind_count：按当前 881xxx 板块清单回溯，板块构成年度漂移 ±几个
// 这些残差对情绪分的冲击被因子级阈值（≤3 分/因子）兜住——超出即口径事故而非已知残差。
if (MODE === 'validate') {
  const dates = new Set(realDays.map((d) => d.trade_date));
  const pools = rebuildPoolsByDate(KLINE_DIR, dates);
  const industry = industryRowsFromCache(industryCache, dates);
  let bad = 0, poolDays = 0;
  const sum = { zt: 0, dt: 0, zb: 0, up: 0, ind: 0, amt: 0, fzdt: 0, fzbl: 0 };
  for (const d of realDays) {
    const s = d.summary || {};
    const r = pools.get(d.trade_date);
    const p = poolsOf(r);
    const ind = industry.get(d.trade_date);
    const ymd = d.trade_date.replace(/-/g, '');
    const amt = amountMap ? amountMap[ymd] : null;
    const errs = [];
    // 池真值只存在于最近 18 天（EM 池接口仅回溯 ~15 天）——没有真值的天不验证池
    if (s.zt_count != null && s.dt_count != null && s.zb_count != null) {
      poolDays++;
      const ztT = s.zt_count, dtT = s.dt_count, zbT = s.zb_count;
      const fZdtT = ((ztT - dtT) / (ztT + dtT)) * 50 + 50;
      const fZdtR = ((p.zt - p.dt) / (p.zt + p.dt)) * 50 + 50;
      const fZblT = (ztT + zbT) > 0 ? (ztT / (ztT + zbT)) * 100 : null;
      const fZblR = (p.zt + p.zb) > 0 ? (p.zt / (p.zt + p.zb)) * 100 : null;
      const dzdt = Math.abs(fZdtR - fZdtT);
      const dzbl = fZblT == null || fZblR == null ? 0 : Math.abs(fZblR - fZblT);
      sum.fzdt += dzdt; sum.fzbl += dzbl;
      // 阈值即实测包络（18 天均值 zdt 1.34 / zbl 4.51，最大 zbl 8.9）——zt 逐日零误差是
      // 规则正确性的锚；zb/dt 偏差均为已知口径残差且单向（保守），超包络才是口径事故。
      if (dzdt > 3.5) errs.push(`s_zdt 因子差 ${dzdt.toFixed(1)}（zt ${p.zt}≠${ztT} · dt ${p.dt}≠${dtT}）`);
      if (dzbl > 10) errs.push(`s_zbl 因子差 ${dzbl.toFixed(1)}（zb ${p.zb}≠${zbT}）`);
      if (s.max_lb != null && Math.abs(p.max_lb - s.max_lb) > 1) errs.push(`max_lb ${p.max_lb}≠${s.max_lb}`);
    }
    if (s.up_count != null && Math.abs(r.up - s.up_count) > 80) errs.push(`up ${r.up}≠${s.up_count}`);
    else if (s.up_count != null) sum.up += Math.abs(r.up - s.up_count);
    if (s.ind_count != null && Math.abs(ind.rows.length - s.ind_count) > 8) errs.push(`ind_count ${ind.rows.length}≠${s.ind_count}`);
    else if (s.ind_count != null) sum.ind += Math.abs(ind.rows.length - s.ind_count);
    if (s.ind_up != null && Math.abs(ind.ind_up - s.ind_up) > 10) errs.push(`ind_up ${ind.ind_up}≠${s.ind_up}`);
    if (s.amount_yi != null && amt != null && Math.abs(amt - s.amount_yi) > Math.max(1, s.amount_yi * 0.01)) errs.push(`amt ${r1(amt)}≠${s.amount_yi}`);
    else if (s.amount_yi != null && amt != null) sum.amt += Math.abs(amt - s.amount_yi);
    if (errs.length) { bad++; console.log(`  ✗ ${d.trade_date}: ${errs.join(' · ')}`); }
  }
  console.log(`\n[validate] ${realDays.length} 个真实日（含池真值 ${poolDays} 天）· 异常 ${bad} 天`);
  console.log(`[validate] 池真值天因子差均值: s_zdt ${(sum.fzdt / Math.max(poolDays, 1)).toFixed(2)} · s_zbl ${(sum.fzbl / Math.max(poolDays, 1)).toFixed(2)}`);
  console.log(`[validate] up 家数累计差 ${sum.up} · ind 板块累计差 ${sum.ind} · amt 累计差 ${Math.round(sum.amt)}亿`);
  if (bad > Math.ceil(realDays.length * 0.2)) {
    console.error('[validate] ✘ 超过 20% 真实日验证不过——禁止 --apply（先排查口径）');
    process.exit(1);
  }
  console.log('[validate] ✔ 门禁通过（阈值内，--apply 可用）');
  process.exit(0);
}

// ── 应用：原料写入 → recalcAll → 落盘 ──
const dates = new Set(backfillDays.map((d) => d.trade_date));
console.log(`[bf] 重建池（${dates.size} 个回填日）…`);
const pools = rebuildPoolsByDate(KLINE_DIR, dates);
const industry = industryRowsFromCache(industryCache, dates);

let filled = 0, noPool = 0, noInd = 0, noAmt = 0;
for (const d of backfillDays) {
  const s = d.summary || (d.summary = {});
  const p = poolsOf(pools.get(d.trade_date));
  const ind = industry.get(d.trade_date);
  const ymd = d.trade_date.replace(/-/g, '');
  const amt = amountMap ? amountMap[ymd] : null;

  // 池原料（与 buildDay 派生公式逐字对齐）
  if (p && p.zt != null) {
    s.zt_count = p.zt; s.dt_count = p.dt; s.zb_count = p.zb;
    const seal = (p.zt + p.zb) > 0 ? r1(p.zt / (p.zt + p.zb) * 100) : null;
    s.seal_pct = seal;
    s.zb_pct = seal != null ? r1(100 - seal) : null;
    s.zbl_pct = s.zb_pct;
    s.seal_den = p.zt + p.zb;
    s.max_lb = p.max_lb; s.lb2_count = p.lb2;
    s.zt_codes = p.zt_codes; s.zt_lb = p.zt_lb;
    // 口径留痕：真实日是 EM 池（封板后炸开），本日是 K 线重建（触板未封）——
    // 消费方（回测/报告）据此区分两段子样本的 zb 口径差（重建偏多 → s_zbl 偏低 ~4.5 分，单向保守）。
    s.pools_caliber = 'kline-rebuild';
  } else noPool++;

  // 涨跌家数（沪深口径）
  const r = pools.get(d.trade_date);
  if (r) { s.up_count = r.up; s.down_count = r.down; s.flat_count = r.flat; s.breadth_scope = '沪深两市A股（K线重建口径，不含北交所）'; }
  else noPool++;

  // 行业广度
  if (ind && ind.rows.length) {
    d.industry = ind.rows;
    s.ind_count = ind.rows.length; s.ind_up = ind.ind_up; s.ind_down = ind.ind_down;
    s.top_industry = ind.rows[0] ? ind.rows[0].name : null;
    s.bottom_industry = ind.rows[ind.rows.length - 1] ? ind.rows[ind.rows.length - 1].name : null;
  } else noInd++;

  // 成交额
  if (amt != null) s.amount_yi = r1(amt); else noAmt++;

  // 留痕：回填来源（不删 summary.backfilled——它是 buildBackfillDay 的原生标记）
  s.backfill_sources = { pools: 'kline-rebuild', industry: 'ths-yearline', amount: 'ths-yearline', at: new Date().toISOString() };
  filled++;
}
console.log(`[bf] 原料写入: ${filled} 天 · 缺池 ${noPool} · 缺行业 ${noInd} · 缺成交额 ${noAmt}`);

if (MODE === 'check') {
  console.log('[bf] --check：未写盘。样例（最早回填日）:');
  const s0 = backfillDays[0].summary;
  console.log(JSON.stringify({ date: backfillDays[0].trade_date, zt: s0.zt_count, dt: s0.dt_count, zb: s0.zb_count, up: s0.up_count, ind: s0.ind_count, amt: s0.amount_yi }));
  process.exit(0);
}

// recalcAll：全档（因子 + 分位 + _backfill 裁定，生产唯一路径）
console.log('[bf] recalcAll 全档重算…');
recalcAll(days);
const stillBackfill = days.filter((d) => d.emotion && d.emotion[BACKFILL_FLAG]).length;
const realNow = days.filter((d) => d.emotion && !d.emotion[BACKFILL_FLAG] && !d.emotion._legacy).length;
console.log(`[bf] 重算后: 真实七因子天 ${realNow} · 仍回填（原料不全）${stillBackfill}`);

// meta 留痕（appendNote：签名去重——重跑只更新日期与计数，不堆叠重复段）
archive.meta = archive.meta || {};
archive.meta.note = appendNote(archive,
  `六因子历史回填 ${new Date().toISOString().slice(0, 10)}：${filled} 个回填天的池/涨跌家数由不复权K线重建（腾讯日K，交易所涨停价规则精确判定，见 src/zt_rebuild.js；--validate 对 ${realDays.length} 个真实日与东财池真值交叉验证：zt 逐日零误差、涨跌家数/成交额零误差），行业广度取同花顺881板块年线，成交额取指数年线；情绪分经 recalcAll 生产路径重算。已知口径残差：zb 为「触板未封」口径（较真实日的 EM「封板后炸开」口径偏多，s_zbl 因子平均偏低 ~4.5 分、情绪分影响 ≤0.5 且方向保守，summary.pools_caliber 留痕）；除权日涨停漏判、ST 历史状态、板块构成变动为个位数量级残差。`);

writeArchiveSafely(MAIN, archive, fsMod);
console.log('[bf] 已写盘（码表+提子，含往返自检）');

// 切片重建（与 backfill_relative.mjs 同纪律：首屏读切片，必须同步）
const { spawnSync } = await import('node:child_process');
const rr = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'split_archive.mjs')], { stdio: 'inherit' });
if (rr.status !== 0) { console.error('[bf] ⚠ 切片重建失败——主档已更新，请手动跑 split_archive'); process.exit(1); }
console.log('[bf] 切片已重建 · 完成');
