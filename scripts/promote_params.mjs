// 参数晋升门禁：params.train → params.live 的唯一合法通道（过拟合防线 · 2026-10-02 拍板）。
//
// 用法：
//   node scripts/promote_params.mjs                                 # 检查差异 + 跑样本外 20% 门禁，出报告（不改任何文件）
//   node scripts/promote_params.mjs --apply --why "理由" [--who 名字] # 门禁通过才把 train 写入 config.json
//                                                                    #   的 params.live 块（+ 同步顶层双写镜像）+ 追加 params_changelog.json
//
// 门禁规则（「样本外 20%」，与 scripts/backtest.mjs 同一引擎同一口径，不另写第二套）：
//   · 样本 = archive 里全部**非回填**交易日（回填天只有 s_net 占位值，混入即污染）；
//   · 切分：前 80% 为样本内，最后 20% 为样本外（OOS）；
//   · live 权重与 train 权重各算一版七因子分数 → 同一引擎（poolBacktest，含成本/风控，
//     参数取各自块）→ 只在 OOS 段上比较；
//   · 通过 = train 的 rankKey（回撤↑ → 夏普↓ → 年化↓，src/backtest.js 唯一排序口径）
//     不劣于 live。劣化 → 拒绝晋升（exit 1）。
//
// 诚实披露：当前真实样本仅 33 个交易日 → OOS ≈ 6 天。门禁是**流程防线**（防止
// 「改参数只看样本内」这一行为模式），不是统计证明。报告里如实写样本量。
import { readFileSync, writeFileSync } from 'node:fs';
import { atomicWriteJSON } from '../src/fsutil.js';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../src/config.js';
import { decodeArchive } from '../src/lhb_codec.js';
import { BASE_PARAMS, scoreWith, poolBacktest, rankKey } from '../src/backtest.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const whyArg = (() => { const i = args.indexOf('--why'); return i >= 0 ? args[i + 1] : null; })();
const whoArg = (() => { const i = args.indexOf('--who'); return i >= 0 ? args[i + 1] : null; })();
const r4 = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4);

// ── 1. 差异检查 ─────────────────────────────────────────────────────────────
const BLOCKS = ['weights', 'thresholds', 'stops', 'lookback', 'costModel'];
const deepEqual = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
const live = config.params.live;
const train = config.params.train;
const changed = BLOCKS.filter((b) => !deepEqual(live[b], train[b]));

if (!changed.length) {
  console.log('[promote] train 与 live 完全一致，无需晋升。');
  console.log('          要实验：改 config.json 的 params.train → 重跑本脚本。');
  process.exit(0);
}
console.log(`[promote] 检测到实验参数差异（${changed.length} 块）：${changed.join(' / ')}`);

// ── 2. 样本外 20% 门禁（与 backtest.mjs 同一数据口径）────────────────────────
const arch = decodeArchive(JSON.parse(readFileSync(path.join(ROOT, 'data', 'archive.json'), 'utf8')));
// 剔除回填天：只有 s_net 占位值不是综合分，混入会让每个指标都错且错得平滑（同 backtest.mjs 注）
// 样本口径（2026-10-05 拍板）：K线重建天（pools_caliber=kline-rebuild）按真值交叉验证
// （33 天零误差，src/zt_rebuild.js）视作有效样本计入——与回测/审计同一口径，audit B13 对账。
const days = (arch.all_days || []).filter((d) => d && d.trade_date && !(d.emotion && d.emotion._backfill));
if (days.length < 10) {
  console.error(`[promote] 真实样本不足（${days.length} 天 < 10），无法跑样本外门禁 —— 拒绝盲晋升。`);
  process.exit(1);
}
{
  const kr = days.filter((d) => d.summary && d.summary.pools_caliber === 'kline-rebuild').length;
  console.log(`[promote] 样本口径：${days.length} 天 = EM 真实采集 ${days.length - kr} + K线重建 ${kr}`
    + '（重建天经 33 天真值交叉验证，视作有效样本——2026-10-05 拍板，见 audit B13）');
}
const n = days.length;
const oosStart = Math.floor(n * 0.8); // 最后 20% 为样本外
const factorsByDay = days.map((d) => d.emotion?.factors || {});
const dates = days.map((d) => d.trade_date);
const ASSETS = config.backtest.assets;
const retsByAsset = {};
for (const a of ASSETS) {
  retsByAsset[a] = days.map((d) => {
    const v = d.indexes?.[a];
    return Number.isFinite(v) ? v / 100 : 0; // 存档为百分比 → 小数收益
  });
}

const evalOnOOS = (pBlock) => {
  // 权重带档位后缀（s_net20）→ 存档因子键（s_net），与 backtest.mjs 的 plainW 同口径
  const plainW = {};
  for (const [wk, pk] of Object.entries(config.factorKeyMap)) plainW[pk] = pBlock.weights[wk];
  const scores = scoreWith(factorsByDay, plainW);
  const p = {
    ...BASE_PARAMS,
    ...pBlock.thresholds,
    maxPos: pBlock.stops.maxPos, stopLoss: pBlock.stops.stopLoss,
    ddTrigger: pBlock.stops.ddTrigger, maxPosChg: pBlock.stops.maxPosChg,
    ...pBlock.costModel,
  };
  const oosRets = Object.fromEntries(ASSETS.map((a) => [a, retsByAsset[a].slice(oosStart)]));
  // ⚠ poolBacktest 返回 { strat, pos, perf } —— 指标在 .perf 下（实测踩坑：
  //   取错层级会拿到 undefined 指标，NaN 比较让字典序退化成「通过」= 缺失当真值）。
  const { perf } = poolBacktest(scores.slice(oosStart), oosRets, p);
  return { metrics: perf, rank: rankKey(perf) };
};

const liveRes = evalOnOOS(live);
const trainRes = evalOnOOS(train);
// 指标加固：三指标任一非有限数 → 无法判定 → 一律拒绝晋升（缺失禁当真值，
// 「拉不到就如实报不可用，不许编数」与 #6 探针同一条纪律）。
const fin = (v) => Number.isFinite(v);
const metricsUsable = [liveRes, trainRes].every((r) => fin(r.metrics.maxDd) && fin(r.metrics.sharpe) && fin(r.metrics.annual));
if (!metricsUsable) {
  console.error('[promote] 样本外指标缺失（非有限数），无法判定 —— 拒绝晋升（缺失禁当真值）。');
  process.exit(1);
}
// rankKey = [maxDd, -sharpe, -annual]（升序更优，与 src/backtest.js sortByRank 同语义）：
// 「train 不劣于 live」= 字典序 train ≤ live（首个差异分量上 train 更优，或完全相等）
const lexCompare = (a, b) => {
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 1e-12) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
};
const pass = lexCompare(trainRes.rank, liveRes.rank) <= 0;

console.log('\n── 样本外 20% 门禁（同 backtest.mjs 引擎/口径）─────────────────');
console.log(`样本: ${n} 个真实交易日 | 样本外: ${n - oosStart} 天（${dates[oosStart]} ~ ${dates[n - 1]}）`);
console.log(`live  : 回撤 ${r4(liveRes.metrics.maxDd)} | 夏普 ${liveRes.metrics.sharpe?.toFixed(3)} | 年化 ${r4(liveRes.metrics.annual)}`);
console.log(`train : 回撤 ${r4(trainRes.metrics.maxDd)} | 夏普 ${trainRes.metrics.sharpe?.toFixed(3)} | 年化 ${r4(trainRes.metrics.annual)}`);
console.log(`结论  : ${pass ? '通过（train 样本外不劣于 live）' : '拒绝（train 样本外劣化 —— 过拟合嫌疑，不许晋升）'}`);
if (n < 60) console.log(`⚠ 样本仅 ${n} 天（OOS ${n - oosStart} 天）：门禁是流程防线，不构成统计证明。`);

// ── 3. 报告落盘（晋升证据链）───────────────────────────────────────────────
const report = {
  at: new Date().toISOString(),
  changedBlocks: changed,
  sample: { realDays: n, oosDays: n - oosStart, oosRange: [dates[oosStart], dates[n - 1]], excludedBackfillDays: (arch.all_days || []).length - n },
  oos: {
    live: { maxDd: r4(liveRes.metrics.maxDd), sharpe: Math.round((liveRes.metrics.sharpe || 0) * 1000) / 1000, annual: r4(liveRes.metrics.annual) },
    train: { maxDd: r4(trainRes.metrics.maxDd), sharpe: Math.round((trainRes.metrics.sharpe || 0) * 1000) / 1000, annual: r4(trainRes.metrics.annual) },
  },
  rankKey: { live: liveRes.rank, train: trainRes.rank },
  pass,
  applied: false,
  disclaimer: '历史回测 ≠ 未来；样本外 20% 门禁为流程防线（防只看样本内调参），非统计证明。',
};
atomicWriteJSON(path.join(ROOT, 'data', 'params_promotion_report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n报告已写入 data/params_promotion_report.json`);

// ── 4. --apply：过门禁才执行晋升（机器重写 LIVE_PARAMS + 追加 changelog）───
if (!APPLY) {
  console.log('检查模式（未改任何文件）。通过后执行：node scripts/promote_params.mjs --apply --why "..."');
  process.exit(pass ? 0 : 1);
}
if (!pass) {
  console.error('[promote] 门禁未通过，拒绝晋升（--apply 无效）。');
  process.exit(1);
}
if (!whyArg || !whyArg.trim()) {
  console.error('[promote] --apply 必须带 --why "<改动理由>"（changelog 留痕纪律：who/when/why 缺一不可）。');
  process.exit(1);
}

// 4a. 机器重写 config.json 的 params.live（train 五块 → live）+ 同步顶层双写镜像。
//     镜像字段是前端直接读的扁平层（index.html 内联桥挂 ASENT_CONFIG / check_frontend 平铺
//     config.json），漏同步即「报告说 A、算的是 B」——故由本脚本一并机器写入，守卫测试逐位锁定。
//     JSON.parse 级重写不做文本手术；结构性错误由 src/config.js 加载时兜底
//     （权重和/阈值序/键集合不符会启动即 throw）。
const cfgPath = path.join(ROOT, 'config.json');
const json = JSON.parse(readFileSync(cfgPath, 'utf8'));
if (!json.params || !json.params.live || !json.params.train) {
  console.error('[promote] config.json 缺 params.live/train 双套结构 —— 拒绝改写（防误伤）。');
  process.exit(1);
}
for (const b of BLOCKS) {
  if (!json.params.live[b] || !json.params.train[b]) {
    console.error(`[promote] config.json params.live/train 缺 ${b} 块 —— 拒绝改写（防误伤）。`);
    process.exit(1);
  }
}
const trainSnapshot = Object.fromEntries(BLOCKS.map((b) => [b, JSON.parse(JSON.stringify(train[b]))]));
json.params.live = trainSnapshot;
// 顶层双写镜像（与 params.live 逐位相等，test/params_governance.test.mjs 锁定）
json.weights = trainSnapshot.weights;
json.lookback = trainSnapshot.lookback;
json.backtest.thresholds = trainSnapshot.thresholds;
json.backtest.costs = trainSnapshot.costModel;
json.backtest.rolling = trainSnapshot.lookback.rolling;
json.backtest.maxPos = trainSnapshot.stops.maxPos;
json.backtest.stopLoss = trainSnapshot.stops.stopLoss;
json.backtest.ddTrigger = trainSnapshot.stops.ddTrigger;
json.backtest.maxPosChg = trainSnapshot.stops.maxPosChg;
json.momentumRecent = trainSnapshot.lookback.momentumRecent;
json.momentumPrev = trainSnapshot.lookback.momentumPrev;
atomicWriteJSON(cfgPath, JSON.stringify(json, null, 2) + '\n');

// 4b. 追加 changelog entry（含 liveAfter 快照与门禁证据）
const logPath = path.join(ROOT, 'params_changelog.json');
const log = JSON.parse(readFileSync(logPath, 'utf8'));
let who = whoArg;
if (!who) {
  try { who = execSync('git config user.name').toString().trim() || 'unspecified'; }
  catch { who = 'unspecified'; }
}
log.entries.push({
  at: new Date().toISOString(),
  who,
  what: `晋升实验参数（${changed.join(' / ')}）：params.train → params.live`,
  why: whyArg.trim(),
  validation: {
    type: 'oos-20pct', pass: true, oosDays: n - oosStart,
    oosRange: [dates[oosStart], dates[n - 1]],
    live: report.oos.live, train: report.oos.train,
    report: 'data/params_promotion_report.json',
  },
  liveAfter: trainSnapshot,
});
atomicWriteJSON(logPath, JSON.stringify(log, null, 2) + '\n');

console.log(`\n[promote] ✅ 晋升完成：config.json params.live 已更新（${changed.join(' / ')}）`);
console.log('          顶层双写镜像（weights/lookback/backtest.*/momentum*）已同步。');
console.log('          params_changelog.json 已追加记录。');
console.log('          下一步：node --test 全量回归（golden/lineage/governance 守卫都过才算数）。');
report.applied = true;
atomicWriteJSON(path.join(ROOT, 'data', 'params_promotion_report.json'), JSON.stringify(report, null, 2) + '\n');
process.exit(0);
