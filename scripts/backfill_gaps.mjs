// 真实采集日的字段缺口补齐（backfill_factors.mjs 的姊妹篇）
//
// 背景：六因子历史回填（012aab1）覆盖了 208 个回填天，但**真实采集日**里也有缺口——
//   · 2026-08-14 ~ 09-03（14 天）：EM 池采集整体失败（zt/dt/zb/up/down 全缺）
//   · 2026-09-04 ~ 09-24（16 天）：池正常但涨跌家数采集失败（up/down/flat 缺）
// 健康面板「全市场涨跌家数 近20日 3/20」就是这段。原料与回填天同源（不复权 K 线重建），
// 走同一条 recalcAll 生产路径——s_pos 从龙虎榜代理转真实宽度、14 个缺池日的
// s_hot/s_zdt/s_zbl 从中性补位转真实值。
//
// 用法：
//   node scripts/backfill_gaps.mjs            # 门禁：重建值 vs 档案真值交叉验证
//   node scripts/backfill_gaps.mjs --check    # 统计缺口与将写入的字段，不写盘
//   node scripts/backfill_gaps.mjs --apply    # 落盘（writeArchiveSafely + recalcAll + 切片）
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeArchive, writeArchiveSafely, appendNote } from '../src/lhb_codec.js';
import { recalcAll } from '../src/pipeline.js';
import { rebuildPoolsByDate, poolsOf } from '../src/zt_rebuild.js';
import * as fsMod from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(ROOT, 'data', 'archive.json');
const KLINE_DIR = path.join(ROOT, 'data', 'bt_kline');

const MODE = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--check') ? 'check' : 'validate';
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

const archive = decodeArchive(JSON.parse(readFileSync(MAIN, 'utf8')));
const days = archive.all_days || [];
if (!existsSync(KLINE_DIR) || !readdirSync(KLINE_DIR).length) {
  console.error('[gap] ⚠ data/bt_kline 为空——先跑 scripts/fetch_raw_kline.mjs');
  process.exit(1);
}

// 缺口分类：A=整池缺（zt_count 也无）· B=只缺涨跌家数
const gapA = days.filter((d) => d.summary && d.summary.zt_count == null && !d.emotion?._backfill);
const gapB = days.filter((d) => d.summary && d.summary.zt_count != null && d.summary.up_count == null);
console.log(`[gap] 档案 ${days.length} 天 · 缺口A（整池）${gapA.length} 天 · 缺口B（仅涨跌家数）${gapB.length} 天`);

// ── 门禁：对照日重建 vs 档案真值 ──
//   对照1：有 up_count 的天（211 天，其中 208 天回填时已零误差验证）重比 up/down
//   对照2：有 EM 池真值的天（缺池前后的真实日）重比 zt——此前 18 池真值日零误差
const ctrl = days.filter((d) => d.summary?.up_count != null);
const ctrlDates = new Set(ctrl.map((d) => d.trade_date));
const ctrlPools = rebuildPoolsByDate(KLINE_DIR, ctrlDates);
let bad = 0, ztExact = 0, ztWarn = 0, upDiff = 0;
for (const d of ctrl) {
  const r = ctrlPools.get(d.trade_date);
  if (!r) { console.log(`  ✗ ${d.trade_date}: K 线无该日`); bad++; continue; }
  if (Math.abs(r.up - d.summary.up_count) > 80) { console.log(`  ✗ ${d.trade_date}: up ${r.up} ≠ ${d.summary.up_count}`); bad++; }
  else upDiff += Math.abs(r.up - d.summary.up_count);
  if (d.summary.zt_count != null) {
    const pz = poolsOf(r).zt;
    const dz = Math.abs(pz - d.summary.zt_count);
    if (dz === 0) ztExact++;
    else if (dz <= 2) { ztWarn++; console.log(`  ⚠ ${d.trade_date}: zt ${pz} ≠ ${d.summary.zt_count}（差 ${dz}，已知残差类：除权漏判/ST 漂移/新股口径）`); }
    else { console.log(`  ✗ ${d.trade_date}: zt ${pz} ≠ ${d.summary.zt_count}（差 ${dz} 超容差）`); bad++; }
  }
}
console.log(`[gate] 对照 ${ctrl.length} 天 · 异常 ${bad} · zt 精确 ${ztExact} / 残差内 ${ztWarn} · up 累计差 ${upDiff}`);
if (bad > 0) { console.error('[gate] ✘ 存在超阈值对照日——禁止 --apply'); process.exit(1); }
console.log('[gate] ✔ 门禁通过');

if (MODE === 'validate') process.exit(0);

// ── 应用 ──
const gapDates = new Set([...gapA, ...gapB].map((d) => d.trade_date));
const pools = rebuildPoolsByDate(KLINE_DIR, gapDates);
let fillA = 0, fillB = 0, noPool = 0;
const at = new Date().toISOString();
for (const d of [...gapA, ...gapB]) {
  const s = d.summary;
  const p = poolsOf(pools.get(d.trade_date));
  const r = pools.get(d.trade_date);
  if (!r || p.zt == null) { noPool++; continue; }

  if (s.zt_count == null) {
    // 缺口A：整池重建（字段集与 backfill_factors.mjs 逐字对齐）
    s.zt_count = p.zt; s.dt_count = p.dt; s.zb_count = p.zb;
    const seal = (p.zt + p.zb) > 0 ? r1(p.zt / (p.zt + p.zb) * 100) : null;
    s.seal_pct = seal;
    s.zb_pct = seal != null ? r1(100 - seal) : null;
    s.zbl_pct = s.zb_pct;
    s.seal_den = p.zt + p.zb;
    s.max_lb = p.max_lb; s.lb2_count = p.lb2;
    s.zt_codes = p.zt_codes; s.zt_lb = p.zt_lb;
    s.pools_caliber = 'kline-rebuild';
    s.gap_fill = { pool: 'kline-rebuild', breadth: 'kline-rebuild', at };
    fillA++;
  } else {
    // 缺口B：池是 EM 真值，只补涨跌家数（不动 zt/zb——不拿重建值覆盖真值）
    s.gap_fill = { breadth: 'kline-rebuild', at };
    fillB++;
  }
  s.up_count = r.up; s.down_count = r.down; s.flat_count = r.flat;
  s.breadth_scope = '沪深两市A股（K线重建口径，不含北交所）';
}
console.log(`[gap] 写入: 缺口A ${fillA} 天（整池）· 缺口B ${fillB} 天（仅宽度）· 缺K线 ${noPool}`);

if (MODE === 'check') {
  console.log('[gap] --check 未写盘。缺口A首日样例:');
  const s0 = gapA[0]?.summary;
  if (s0) console.log(JSON.stringify({ date: gapA[0].trade_date, zt: s0.zt_count, dt: s0.dt_count, zb: s0.zb_count, up: s0.up_count, flat: s0.flat_count }));
  process.exit(0);
}

console.log('[gap] recalcAll 全档重算…');
recalcAll(days);
const noUp = days.filter((d) => d.summary?.up_count == null).length;
const noZt = days.filter((d) => d.summary?.zt_count == null).length;
console.log(`[gap] 重算后: up_count 缺 ${noUp} · zt_count 缺 ${noZt}`);

archive.meta = archive.meta || {};
// appendNote：签名去重——重跑只更新日期与计数，不堆叠重复段
archive.meta.note = appendNote(archive,
  `真实日字段缺口补齐 ${at.slice(0, 10)}：${fillA + fillB} 个真实采集日（${gapA[0]?.trade_date}~${gapB[gapB.length - 1]?.trade_date}）的缺口由不复权K线重建——${fillA} 天整池缺失（EM 采集失败，zt/dt/zb/宽度全补，summary.pools_caliber=kline-rebuild）、${fillB} 天仅涨跌家数缺失（EM 池真值保留不动，只补 up/down/flat）；门禁对 ${ctrl.length} 个对照日重建 vs 真值零异常。情绪分经 recalcAll 生产路径重算。`);

writeArchiveSafely(MAIN, archive, fsMod);
console.log('[gap] 已写盘（码表+提子，含往返自检）');

const { spawnSync } = await import('node:child_process');
const rr = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'split_archive.mjs')], { stdio: 'inherit' });
if (rr.status !== 0) { console.error('[gap] ⚠ 切片重建失败——主档已更新，请手动跑 split_archive'); process.exit(1); }
console.log('[gap] 切片已重建 · 完成');
