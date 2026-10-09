// V5.3 参数敏感性分析（P0-2.4 参数精简：「剔除对收益贡献 <1% 的冗余参数」的证据生成器）
//
// 用途：对 config.params.train 的每个可调参数做**单变量扰动**，量化其对
//       年化/夏普/最大回撤的边际影响，输出"冗余候选"清单（|Δ年化| < 1% 且
//       |Δ夏普| < 0.1 的参数）。与 scripts/attribution_v52.mjs（参数块级归因）
//       互补：归因看块，敏感性看单参数。
//
// 方法纪律：
//   • 同一装配口径：与 scripts/promote_params.mjs / backtest.mjs 完全一致
//     （剔回填天、factorKeyMap 去档位后缀、indexes 百分比→小数、train 锚点）。
//   • 单变量扰动：每次只动一个参数，其余固定在 train 值——度量的是**边际**敏感度，
//     不含参数间交互（交互在网格/帕累托里看，不在此重复）。
//   • 双指标判冗余：年化变动与夏普变动**都**低于阈值才算冗余候选（只看一个指标
//     会把"年化不动但回撤大改"的风险参数误判成冗余）。
//   • 纯参数化调 poolBacktest：src/backtest.js 数值路径一行不动，parity 夹具不受影响。
//
// 用法：node scripts/sensitivity_params.mjs [--archive data/archive.json]
//   只读不写盘（分析工具；结论供人工决策，不自动改 config——参数改动唯一通道
//   仍是 scripts/promote_params.mjs 样本外门禁 + params_changelog 留痕）。
import { readFileSync } from 'node:fs';
import config from '../src/config.js';
import { decodeArchive } from '../src/lhb_codec.js';
import { BASE_PARAMS, poolBacktest, scoreWith } from '../src/backtest.js';

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ARCHIVE = argOf('--archive', 'data/archive.json');

// ── 装配（与 promote_params.mjs 同一口径）────────────────────────────────
const arch = decodeArchive(JSON.parse(readFileSync(ARCHIVE, 'utf8')));
const days = (arch.all_days || []).filter((d) => d && d.trade_date && !(d.emotion && d.emotion._backfill));
if (days.length < 5) { console.error(`[sensitivity] 样本不足（${days.length} 天）`); process.exit(1); }

const TR = config.params.train;
const { assets: ASSETS } = config.backtest;
const factorsByDay = days.map((d) => d.emotion?.factors || {});
const retsByAsset = {};
for (const a of ASSETS) {
  retsByAsset[a] = days.map((d) => {
    const v = d.indexes?.[a];
    return Number.isFinite(v) ? v / 100 : 0;
  });
}
const plainW = {};
for (const [wk, pk] of Object.entries(config.factorKeyMap)) plainW[pk] = TR.weights[wk];
const scored = scoreWith(factorsByDay, plainW);

const n = days.length;
const oosStart = Math.floor(n * 0.8);
const oosRets = Object.fromEntries(ASSETS.map((a) => [a, retsByAsset[a].slice(oosStart)]));

const trainParams = () => ({
  ...BASE_PARAMS, ...TR.thresholds,
  maxPos: TR.stops.maxPos, stopLoss: TR.stops.stopLoss,
  ddTrigger: TR.stops.ddTrigger, maxPosChg: TR.stops.maxPosChg,
  ...TR.costModel,
});

const pct = (v) => (Number.isFinite(v) ? (v * 100).toFixed(2) + '%' : '—');
const n2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');

const run = (p) => poolBacktest(scored, retsByAsset, p).perf;
const runOos = (p) => poolBacktest(scored.slice(oosStart), oosRets, p).perf;

// ── 扰动方案（单变量；扰动幅度对齐 gridSteps 量级）───────────────────────
const probes = [];
for (const [wk, wv] of Object.entries(TR.weights)) {
  probes.push({ group: '权重', key: wk, lo: wv * 0.8, hi: wv * 1.2 });
}
for (const [tk, tv] of Object.entries(TR.thresholds)) {
  probes.push({ group: '阈值', key: tk, lo: Math.max(0, tv - 4), hi: Math.min(100, tv + 4) });
}
{
  const s = TR.stops;
  if (s.maxPosChg) probes.push({ group: '风控', key: 'maxPosChg', lo: s.maxPosChg - 0.05, hi: s.maxPosChg + 0.05 });
  if (s.stopLoss) probes.push({ group: '风控', key: 'stopLoss', lo: s.stopLoss * 0.75, hi: s.stopLoss * 1.25 });
  if (s.ddTrigger) probes.push({ group: '风控', key: 'ddTrigger', lo: s.ddTrigger * 0.8, hi: s.ddTrigger * 1.2 });
  // maxPos=1.0 是满仓上限语义，不扰动；成本是真实摩擦非调参对象，不扰动
}

// ── 基线 ────────────────────────────────────────────────────────────────
const baseP = trainParams();
const base = run(baseP);
const baseOos = runOos(baseP);

console.log('══ V5.3 参数敏感性分析（单变量扰动，train 锚点）══');
console.log(`样本: ${n} 个真实交易日（样本内 ${oosStart} / 样本外 ${n - oosStart}，promote 同口径）`);
console.log(`基线（train 全参数）: 年化 ${pct(base.annual)} | 夏普 ${n2(base.sharpe)} | 回撤 ${pct(base.maxDd)} | 样本外夏普 ${n2(baseOos.sharpe)}\n`);

const setParam = (p, probe, v) => {
  if (probe.group === '权重') {
    const w = { ...plainW };
    const pk = config.factorKeyMap[probe.key] || probe.key;
    w[pk] = v;
    return { params: p, weights: w };
  }
  return { params: { ...p, [probe.key]: v }, weights: plainW };
};

const results = [];
for (const pr of probes) {
  const row = { ...pr, dAnnual: [], dSharpe: [], dDd: [], dOosSharpe: [] };
  for (const side of ['lo', 'hi']) {
    const { params, weights } = setParam(baseP, pr, pr[side]);
    const sc = scoreWith(factorsByDay, weights);
    const perf = poolBacktest(sc, retsByAsset, params).perf;
    const oosPerf = poolBacktest(sc.slice(oosStart), oosRets, params).perf;
    row.dAnnual.push(Math.abs(perf.annual - base.annual));
    row.dSharpe.push(Math.abs(perf.sharpe - base.sharpe));
    row.dDd.push(Math.abs(perf.maxDd - base.maxDd));
    row.dOosSharpe.push(Math.abs(oosPerf.sharpe - baseOos.sharpe));
  }
  row.maxDAnnual = Math.max(...row.dAnnual);
  row.maxDSharpe = Math.max(...row.dSharpe);
  row.maxDDd = Math.max(...row.dDd);
  results.push(row);
}

// 冗余判定：年化与夏普的边际影响都低于阈值（双指标，防误杀风险参数）
const REDUNDANT_D_ANNUAL = 0.01;  // 1% 年化
const REDUNDANT_D_SHARPE = 0.10;
for (const r of results) {
  r.redundant = r.maxDAnnual < REDUNDANT_D_ANNUAL && r.maxDSharpe < REDUNDANT_D_SHARPE;
}
results.sort((a, b) => b.maxDAnnual - a.maxDAnnual);

console.log('参数 | 组 | Δ年化(max) | Δ夏普(max) | Δ回撤(max) | Δ样本外夏普 | 判定');
console.log('─'.repeat(92));
for (const r of results) {
  console.log(`${r.key.padEnd(10)} | ${r.group} | ${pct(r.maxDAnnual)} | ${n2(r.maxDSharpe)} | ${pct(r.maxDDd)} | ${n2(Math.max(...r.dOosSharpe))} | ${r.redundant ? '冗余候选' : '有效'}`);
}
console.log('─'.repeat(92) + '\n');

const redundant = results.filter((r) => r.redundant);
const effective = results.filter((r) => !r.redundant);
console.log(`── 结论（判定口径：|Δ年化| < ${REDUNDANT_D_ANNUAL * 100}% 且 |Δ夏普| < ${REDUNDANT_D_SHARPE}）──`);
console.log(`有效参数 ${effective.length} 个：${effective.map((r) => `${r.group}:${r.key}`).join('、')}`);
console.log(`冗余候选 ${redundant.length} 个：${redundant.length ? redundant.map((r) => `${r.group}:${r.key}`).join('、') : '（无）'}`);
if (redundant.length) {
  console.log('\n⚠ 冗余≠可删：');
  console.log('  · 停损/降仓类参数"零敏感"可能反映**池回测语义下从未触发**（指数日收益触及单笔 -8% 的情形不存在），');
  console.log('    不代表个股实盘语义下无用——见 attribution_v52.mjs 的边界披露；删除前须先明确回测对象的语义。');
  console.log('  · 阈值参数与 config 五档风险分界共用唯一出处，删除=改产品口径，须走 promote_params 门禁。');
  console.log('  · 本报告只给证据；参数改动唯一通道仍是 promote_params.mjs（样本外 20% 门禁 + changelog 留痕）。');
}
console.log('\n⚠ 免责：单变量扰动不含参数间交互；样本外仅 ' + (n - oosStart) + ' 天，样本外敏感度仅流程参考、非统计证明。');
console.log('本脚本只读不写盘；src/backtest.js 数值路径未改动（Python parity 夹具不受影响）。');
