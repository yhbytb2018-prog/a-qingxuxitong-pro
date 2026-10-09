// V5.3 归因分解：V5.2-pro（增强口径）回测弱于基准（BASE）的根因拆账（P0 前置分析）
//
// 用途：V5.3 需求前置判断——「增强版本回测弱于基准版」到底是哪些参数块拖累的，
//       每块贡献多少。避免在没查清根因时就动手改引擎（奥卡姆剃刀：先归因再动刀）。
//
// 做法（纯参数化调 poolBacktest，src/backtest.js 数值路径一行不动）：
//   阶梯累积分解——从 BASE（全关）逐块打开 V5.2-pro 的四个参数块，相邻两档的
//   指标差 = 该块的累积贡献：
//     ① BASE     满仓、无成本、无平滑、无止损、无降仓（V5 原始口径）
//     ② +成本    comm 0.0003 / stamp 0.0005 / slip 0.0002（真实交易摩擦）
//     ③ +平滑    maxPosChg 0.2（仓位变动限幅）
//     ④ +止损    stopLoss -0.08（单笔硬止损）
//     ⑤ +降仓    ddTrigger -0.15（回撤动态降仓）＝ V52 全开
//   顺序固定为「摩擦 → 风控」（成本是最外层硬摩擦，先加；风控在其上叠加）。
//   ⚠ 口径披露：单块贡献与加入顺序相关（块间有交互），本表是**累积口径**的
//     顺序分解，不是独立贡献的正交分解——交互项不单独列，藏在后加块的数字里。
//
// 样本维度：全样本 + 样本外 20%（与 scripts/promote_params.mjs 同一切分口径
//   oosStart = floor(n*0.8)，前 80% 样本内 / 后 20% 样本外）——直接对齐 V5.3
//   验收标准「样本内/外指标衰减幅度」。
//
// 附加扫描：悲观滑点敏感性（V5.3 P0-2.3「悲观滑点下收益崩塌则弃用」的量化依据）——
//   slip 从基准 0.0002 扫到 0.005（小盘冲击按 25 倍悲观上限），看年化/回撤衰减曲线。
//
// 用法：node scripts/attribution_v52.mjs [--archive data/archive.json]
//   只读不写盘（分析工具，不产出数据文件，避免 need_rebuild 依赖面扩大）。
import { readFileSync } from 'node:fs';
import config from '../src/config.js';
import { decodeArchive } from '../src/lhb_codec.js';
import { BASE_PARAMS, poolBacktest, scoreWith } from '../src/backtest.js';

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ARCHIVE = argOf('--archive', 'data/archive.json');

const arch = decodeArchive(JSON.parse(readFileSync(ARCHIVE, 'utf8')));
// 与 scripts/backtest.mjs 同一纪律：剔除回填天（占位情绪分会污染每个指标）
const days = (arch.all_days || []).filter((d) => d && d.trade_date && !(d.emotion && d.emotion._backfill));
if (days.length < 5) {
  console.error(`[attribution] 样本不足（${days.length} 个交易日），退出`);
  process.exit(1);
}

const TR = config.params.train;
const { assets: ASSETS } = config.backtest;
const TH = TR.thresholds;
const COSTS = TR.costModel;
const { maxPos, stopLoss, ddTrigger, maxPosChg } = TR.stops;
const baseW = { ...TR.weights };
const plainW = {};
for (const [wk, pk] of Object.entries(config.factorKeyMap)) plainW[pk] = baseW[wk];

const pBase = { ...BASE_PARAMS, ...TH };
const factorsByDay = days.map((d) => d.emotion?.factors || {});
const retsByAsset = {};
for (const a of ASSETS) {
  retsByAsset[a] = days.map((d) => {
    const v = d.indexes?.[a];
    return Number.isFinite(v) ? v / 100 : 0;
  });
}
const scored = scoreWith(factorsByDay, plainW);

// ── 阶梯定义（顺序 = 摩擦 → 风控，口径见文件头）──────────────────────────
const LADDER = [
  { name: 'BASE（全关）', params: { ...pBase } },
  { name: '+交易成本', params: { ...pBase, comm: COSTS.comm, stamp: COSTS.stamp, slip: COSTS.slip } },
  { name: '+仓位平滑', params: { ...pBase, ...COSTS, maxPosChg } },
  { name: '+单笔止损', params: { ...pBase, ...COSTS, maxPosChg, stopLoss } },
  { name: '+回撤降仓（=V52全开）', params: { ...pBase, ...COSTS, maxPosChg, stopLoss, ddTrigger, maxPos } },
];

// ── 样本内/外切分（与 promote_params.mjs 同一口径）────────────────────────
const n = days.length;
const oosStart = Math.floor(n * 0.8);
const dates = days.map((d) => d.trade_date);
const inRets = Object.fromEntries(ASSETS.map((a) => [a, retsByAsset[a].slice(0, oosStart)]));
const oosRets = Object.fromEntries(ASSETS.map((a) => [a, retsByAsset[a].slice(oosStart)]));

const pct = (v) => (Number.isFinite(v) ? (v * 100).toFixed(2) + '%' : '—');
const num2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');

// 指数等权持有（对照基准：什么都不做的收益）
const holdNav = (() => {
  let acc = 1;
  for (let i = 0; i < n; i++) {
    const r = ASSETS.reduce((a, k) => a + retsByAsset[k][i], 0) / ASSETS.length;
    acc *= 1 + r;
  }
  return acc;
})();

console.log('══ V5.3 归因分解：V5.2-pro 相对 BASE 的逐块贡献 ══');
console.log(`样本: ${n} 个真实交易日（${dates[0]} ~ ${dates[n - 1]}）`);
console.log(`切分: 样本内 ${oosStart} 天 / 样本外 ${n - oosStart} 天（promote_params 同口径 80/20）`);
console.log(`指数等权持有（对照）: 总收益 ${pct(holdNav - 1)}\n`);

const rows = [];
for (const step of LADDER) {
  const all = poolBacktest(scored, retsByAsset, step.params);
  const oos = poolBacktest(scored.slice(oosStart), oosRets, step.params);
  const ins = poolBacktest(scored.slice(0, oosStart), inRets, step.params);
  rows.push({
    name: step.name,
    full: all.perf, oos: oos.perf, ins: ins.perf,
    oosSharpeDecayPct: Number.isFinite(ins.perf.sharpe) && ins.perf.sharpe > 1e-9
      ? (1 - oos.perf.sharpe / ins.perf.sharpe) * 100 : null,
  });
}

const show = (label, r) => [
  label,
  pct(r.full.annual), num2(r.full.sharpe), pct(r.full.maxDd), pct(r.full.winRate),
  num2(r.ins.sharpe), num2(r.oos.sharpe),
].join(' | ');

console.log('口径(累积顺序分解) | 年化 | 夏普 | 最大回撤 | 胜率 | 样本内夏普 | 样本外夏普');
console.log('─'.repeat(96));
for (const r of rows) console.log(show(r.name, r));
console.log('─'.repeat(96) + '\n');

console.log('── 逐块差值（相邻档之差 = 该块累积贡献；含块间交互，非正交分解）──');
for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1], b = rows[i];
  const dAnnual = b.full.annual - a.full.annual;
  const dSharpe = b.full.sharpe - a.full.sharpe;
  const dDd = b.full.maxDd - a.full.maxDd;
  console.log(`${b.name.padEnd(22, '　')} 年化 ${dAnnual >= 0 ? '+' : ''}${pct(dAnnual)} | 夏普 ${dSharpe >= 0 ? '+' : ''}${num2(dSharpe)} | 回撤 ${dDd >= 0 ? '+' : ''}${pct(dDd)}`);
}
console.log();

console.log('── 样本外衰减（V5.3 验收：衰减 > 50% 需警惕；⚠ OOS 天数少，仅流程参考）──');
for (const r of rows) {
  const decay = r.oosSharpeDecayPct;
  console.log(`${r.name.padEnd(22, '　')} 夏普样本内→外: ${num2(r.ins.sharpe)} → ${num2(r.oos.sharpe)}`
    + `${decay != null ? `（衰减 ${decay >= 0 ? '' : '+'}${decay.toFixed(1)}%）` : '（样本内夏普≈0，衰减不可算）'}`);
}
console.log();

// ── 悲观滑点扫描（P0-2.3：悲观滑点下收益崩塌则弃用该选股分支）──────────────
console.log('── 悲观滑点敏感性（V52 全开，仅扫 slip；其余参数不动）──');
console.log('slip | 年化 | 夏普 | 最大回撤 | 总收益');
console.log('─'.repeat(60));
const v52Params = LADDER[LADDER.length - 1].params;
for (const slip of [0.0002, 0.0005, 0.001, 0.002, 0.003, 0.005]) {
  const p = { ...v52Params, slip };
  const { perf } = poolBacktest(scored, retsByAsset, p);
  const total = perf.nav ? perf.nav[perf.nav.length - 1] - 1 : null;
  console.log(`${slip.toFixed(4)} | ${pct(perf.annual)} | ${num2(perf.sharpe)} | ${pct(perf.maxDd)} | ${pct(total)}`);
}

console.log('\n⚠ 免责：阶梯分解为顺序累积口径，块间交互项计入后加块；样本外仅 '
  + `${n - oosStart} 天，衰减数字是流程参考、非统计证明（与 promote_params 同一诚实披露）。`);
console.log('本脚本只读不写盘；数值路径 src/backtest.js 未改动（Python parity 夹具不受影响）。');
