#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// P2-α 旁路记账工具：三轨道每日纸面记账（纯新增，零生产改动）
// ─────────────────────────────────────────────────────────────────────────────
// 依据：docs/dual_track_framework.md（已批）：V5.2 独跑 + V5.3 全程陪跑披露 +
//       shift 次日帽影子记账。本工具是披露层与影子账本的第一个落地件。
//
// 三轨道（框架 §二）：
//   A 执行轨   V5.2 主信号——P2 模拟资金曲线的唯一真实轨道（executed: true）
//   B 参考线   V5.3-A 全量帽——每日计算逐日披露，永不执行（executed: false）
//     · 披露口径：regime=unknown → 保守档 0.2（CONSERVATIVE_BAND，框架 §三
//       "缺失显式化"；divergence.note 标注"状态缺失，参考线按保守档"）
//     · 锚点口径：unknown → null（与 experiment_dual_track 的 FULL 逐位一致，
//       仅供门禁②对账 v53；两口径差 = unknown 日的披露保守性，单独量化上报）
//   C 影子轨   shift 次日帽——三条线 {0.3,0.4,0.5} 同时记账（框架 §二：
//     "影子零成本，一次性把决策区间全记上"；晋升前不得收窄）
//     · 规则：T 日 regime=shift → T+1 日仓位帽 = C。实现 = positions() 的
//       maxPosByDay[T]=C（T+1 生效）——与 experiment_dual_track 的 T1 同一
//       代码路径，门禁③锁死逐位复现。
//
// 三重门禁（全样本重放，任一失败即终止不写盘）：
//   ① A ↔ data/backtest.json::v52（-1.50% / 13.79%）
//   ② B_锚点口径 ↔ v53（-3.71% / 8.78%）
//   ③ C0.3 ↔ 框架表 T1（-0.68% / 14.03% / 18 生效日；C0.4 ↔ +0.02% / 13.61%）
//
// 账本口径（本工具定义；JSON 的 notes 字段与报告重复声明，防读取端自造口径）：
//   premiumCum  = navA − navB（净值差，B=披露口径，日更）。正 = 整份保险累计保费；
//                 期末值 = 两轨 total 之差，与锚点严格可逆（2.21pp 口径见 gates）
//   coverageCum = A当前回撤 − B当前回撤（各自相对自身运行峰；日更状态量，
//                 框架 §三"回撤差口径"的字面实现）。整期保额另报 maxDd 差
//   shadowCum   = navC − navA（净值差）。正 = 影子线累计跑赢执行轨；
//                 期末值 = C.total − A.total，与实验 Δ 同口径
//                 ⚠ 框架 §三原文"Σ(A日收益−B日收益)"式算术和受复利路径影响系统性
//                   偏离锚点（首跑实测 2.86 vs 2.21pp），按"账本必须与锚点可逆"
//                   纪律改为净值差，"Σ(A−C)"的符号同误——两处待框架文档勘误确认
//   episodes    = 影子生效日计数（active 且池仓位真被压到 A 之下）= 晋升门禁
//                 分母（框架 §四：≥10 才可提案）
//
// 输出：
//   data/paper/dual_track.json         全史日频记录 + 账本（幂等全量重放）
//   data/paper/dual_track_latest.json  最新交易日快照（当日披露字段，框架 §三）
//   tools/backtest/reports/paper_dual_track.md  人读账本预览（呈审用）
//
// 用法：每日数据更新后 node tools/backtest/paper_dual_track.mjs（幂等重放，
//       账本随 archive 增长自动延长）。P2_START 目前为 null——模拟盘启动日
//       回填后，账本将增加以该日为基期的第二套累计（框架 §四门禁只认 P2 起的证据）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { atomicWriteJSON } from '../../src/fsutil.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import config from '../../src/config.js';
import { decodeArchive } from '../../src/lhb_codec.js';
import { classifySeries } from '../../src/regime.js';
import { bandFor, CONSERVATIVE_BAND, DISCLAIMER } from '../../src/position_policy.js';
import { BASE_PARAMS, scoreWith, positions, turnoverCost, metrics } from '../../src/backtest.js';
import { buildTrackNote, dualTrackBlock } from '../../src/dual_track.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const P2_START = null; // 模拟盘启动日（YYYY-MM-DD），启动后回填

// ── 输入重建（与 experiment_dual_track.mjs 逐行同款） ──
const arch = decodeArchive(JSON.parse(readFileSync(join(ROOT, 'data', 'archive.json'), 'utf8')));
const days = (arch.all_days || []).filter((d) => d && d.trade_date && !(d.emotion && d.emotion._backfill));
if (days.length < 5) { console.error('[paper] 样本不足'); process.exit(1); }
const dates = days.map((d) => d.trade_date);
const factorsByDay = days.map((d) => d.emotion?.factors || {});
const ASSETS = config.backtest.assets;
const retsByAsset = {};
for (const a of ASSETS) {
  retsByAsset[a] = days.map((d) => {
    const v = d.indexes?.[a];
    return Number.isFinite(v) ? v / 100 : 0;
  });
}
// ── 轨道状态（P1 回滚执行面，2026-10-06 拍板：scripts/rollback_track.mjs）──
// 唯一事实源 = data/paper/track_state.json（pipeline 不触碰；本工具每次运行读取）。
// activeTrack === 'A_fallback' → 轨道 A 参数取冻结快照（bd77fed 提交的 params 五块，
// data/paper/track_fallback_params.json），不再跟随 params.train——"5 分钟切回 V5.2
// 基线"的执行面：参数晋升/漂移都被快照隔离。重放口径 = 全史统一参数（幂等不变）；
// 当前 train ≡ 快照（基线未晋升）→ 切换零差异；未来"晋升后又回滚"时切换日前历史
// 按快照口径重放（非当时真实路径）——如实披露。分段重放已裁决 No-Go（2026-10-06，
// 用户拍板）：推迟到 P2-β 之后的迭代——当前"全史统一参数"口径下零差异无影响，
// 引入分段重放徒增代码复杂度与测试矩阵，属"未来可能需要的优化"而非"现在不装会爆的雷"。
// 门禁①在 fallback 下同样必须过（快照 = bd77fed.train = v52 锚点口径）——它同时是
// 快照完整性守卫：快照被手改 → 门禁红 → 本工具拒写盘。
const STATE_FILE = join(ROOT, 'data', 'paper', 'track_state.json');
let trackState = null;
try { trackState = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { /* 无状态文件 = 轨道 A（未回滚常态） */ }
const FALLBACK = trackState?.activeTrack === 'A_fallback';
// 降级策略（P2-β 契约，schemas/track-state.schema.json 头注唯一出处）：
// 文件在但 activeTrack 缺失/非法 → 默认轨道 A + warn 日志（缺字段≠错误渲染）
if (trackState && trackState.activeTrack !== 'A' && trackState.activeTrack !== 'A_fallback') {
  console.warn(`[paper] ⚠ track_state.activeTrack 缺失或非法（${JSON.stringify(trackState.activeTrack)}）→ 降级轨道 A（契约降级策略：缺字段 = A + warn）`);
}
const FB = FALLBACK ? JSON.parse(readFileSync(join(ROOT, 'data', 'paper', 'track_fallback_params.json'), 'utf8')) : null;
const TR = FALLBACK ? FB.params : config.params.train;
if (FALLBACK) console.log(`[paper] 轨道 A 参数面 = A_fallback 冻结快照（@${FB.commit}，生效 ${trackState.fallback?.effectiveDate || '[待确认]'}；触发 ${trackState.fallback?.trigger || '?'}）`);
else if (trackState) console.log(`[paper] 轨道 A 参数面 = config.json params.train（activeTrack=${trackState.activeTrack}）`);
const plainW = {};
for (const [wk, pk] of Object.entries(config.factorKeyMap)) plainW[pk] = TR.weights[wk];
const pV52 = { ...BASE_PARAMS, ...TR.thresholds, ...TR.stops, ...TR.costModel };
const scores = scoreWith(factorsByDay, plainW);
const n = scores.length;

const regimeDays = days.map((d) => ({
  trade_date: d.trade_date,
  value: d.emotion ? d.emotion.value : null,
  pct_rank: d.emotion ? d.emotion.pct_rank : null,
  seal_pct: d.summary ? d.summary.seal_pct : null,
}));
const regimeSeries = classifySeries(regimeDays);
const regimeKeys = regimeSeries.map((s) => s.key);
const capOf = (k) => { const b = bandFor(k); return b ? b.maxPos : null; };
const capsAnchor = regimeKeys.map((k) => capOf(k)); // unknown→null（门禁②对账口径）
const capsDisc = regimeKeys.map((k) => (k === 'unknown' ? CONSERVATIVE_BAND.maxPos : capOf(k))); // 披露口径
const SHADOW = [0.3, 0.4, 0.5];
const capsShadow = (c) => regimeKeys.map((k) => (k === 'shift' ? c : null));

// ── 池合成（等权，含成本；positions() 为生产引擎唯一出处） ──
function poolRun(p) {
  const strat = new Array(n).fill(0);
  const pos = new Array(n).fill(0);
  const posByAsset = {};
  let opens = 0;
  for (const a of ASSETS) {
    const pa = positions(scores, retsByAsset[a], p);
    posByAsset[a] = pa;
    const ca = turnoverCost(pa, p);
    for (let i = 0; i < n; i++) {
      strat[i] += (retsByAsset[a][i] * pa[i] - ca[i]) / ASSETS.length;
      pos[i] += pa[i] / ASSETS.length;
      if (pa[i] > 0 && (i === 0 || pa[i - 1] === 0)) opens++;
    }
  }
  return { strat, pos, posByAsset, perf: metrics(strat, pos, opens, 0) };
}

const A = poolRun(pV52);
const Bref = poolRun({ ...pV52, maxPosByDay: capsAnchor });
const Bdisc = poolRun({ ...pV52, maxPosByDay: capsDisc });
const C = {};
for (const c of SHADOW) C[c] = poolRun({ ...pV52, maxPosByDay: capsShadow(c) });

// ── 三重门禁 ──
const refJson = JSON.parse(readFileSync(join(ROOT, 'data', 'backtest.json'), 'utf8'));
const pct = (x) => (x * 100).toFixed(2) + '%';
const fmt = (x, d = 3) => x.toFixed(d);
const r = (x, d = 6) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);
function gateAnchor(run, ref, label) {
  const bad = [];
  if (Math.abs(run.perf.total - ref.total) > 6e-5) bad.push(`total ${pct(run.perf.total)}≠${pct(ref.total)}`);
  if (Math.abs(run.perf.maxDd - ref.maxDd) > 6e-5) bad.push(`maxDd ${pct(run.perf.maxDd)}≠${pct(ref.maxDd)}`);
  if (bad.length) { console.error(`[paper] 门禁失败：${label} → ${bad.join('；')}，终止`); process.exit(1); }
  console.log(`[paper] 门禁通过：${label}（${pct(run.perf.total)} / ${pct(run.perf.maxDd)}）`);
}
gateAnchor(A, refJson.v52, '① 轨道A ↔ v52');
gateAnchor(Bref, refJson.v53, '② 轨道B（锚点口径 unknown→null） ↔ v53');

// 门禁③：影子线 ↔ 框架表 T1（experiment_dual_track 实测数的两位小数舍入值）
// 锚点样本截止日：锚点验证的是「实现一致性」（影子轨代码 ↔ 实验 T1 实测），
// 必须在**同一样本窗**上比对；实验窗之后新增的交易日不参与锚点比对——否则
// 数据一延伸必挂（2026-10-08 实录：total -1.17%≠-0.68% 不是实现漂移，是样本
// 窗不同；当天账本被锁死无法滚动 → 下游 post_market 报告日期锚定滞后）。
// 锚点滚动需人工更新 T1REF/T1_END 并附 experiment 复跑证据。样本窗内行为与
// 历史版本完全一致（窗口等于全样本时退化为此前的全样本比对）。
const T1_END = '2026-09-30';
const T1REF = { 0.3: { total: -0.0068, maxDd: 0.1403 }, 0.4: { total: 0.0002, maxDd: 0.1361 } };
// 锚点样本窗末日下标（不含）：首个 trade_date > T1_END 的位置，无则全样本
const t1Cut = (() => { const idx = days.findIndex((d) => d.trade_date > T1_END); return idx === -1 ? n : idx; })();
let episodes = { 0.3: 0, 0.4: 0, 0.5: 0 };
let activeDays = 0;
for (let i = 1; i < n; i++) {
  const active = regimeKeys[i - 1] === 'shift';
  if (!active) continue;
  activeDays++;
  if (i < t1Cut) for (const c of SHADOW) if (C[c].pos[i] < A.pos[i] - 1e-9) episodes[c]++;
}
for (const c of [0.3, 0.4]) {
  // 锚点比对用截断窗绩效（total/maxDd 只由 strat 累乘得出，opens 不参与，截断重算安全）
  const perfT1 = t1Cut >= n ? C[c].perf : metrics(C[c].strat.slice(0, t1Cut), C[c].pos.slice(0, t1Cut), 0, 0);
  const bad = [];
  if (Math.abs(perfT1.total - T1REF[c].total) > 2e-4) bad.push(`total ${pct(perfT1.total)}≠${pct(T1REF[c].total)}`);
  if (Math.abs(perfT1.maxDd - T1REF[c].maxDd) > 2e-4) bad.push(`maxDd ${pct(perfT1.maxDd)}≠${pct(T1REF[c].maxDd)}`);
  if (bad.length) { console.error(`[paper] 门禁失败：③ 影子C${c} ↔ 实验T1（样本窗截至 ${T1_END}）→ ${bad.join('；')}，终止`); process.exit(1); }
}
if (episodes[0.3] !== 18) {
  console.error(`[paper] 门禁失败：③ 影子C0.3 生效日 ${episodes[0.3]} ≠ 实验T1 的 18，终止`);
  process.exit(1);
}
console.log(`[paper] 门禁通过：③ 影子C0.3 ↔ 实验T1 样本窗 ${T1_END}（${pct(t1Cut >= n ? C[0.3].perf.total : metrics(C[0.3].strat.slice(0, t1Cut), C[0.3].pos.slice(0, t1Cut), 0, 0).total)} / ${episodes[0.3]} 生效日；全样本现为 ${pct(C[0.3].perf.total)} / ${pct(C[0.3].perf.maxDd)}）；C0.4 全样本 ${pct(C[0.4].perf.total)} / ${pct(C[0.4].perf.maxDd)}`);

// 披露口径 vs 锚点口径差（unknown 日的保守性量化）
const unknownIdx = regimeKeys.map((k, i) => (k === 'unknown' ? i : -1)).filter((i) => i >= 0);
const discDelta = Bdisc.perf.total - Bref.perf.total;
console.log(`[paper] 披露口径核查：unknown ${unknownIdx.length} 日（${unknownIdx.map((i) => dates[i]).join('、') || '无'}），B_披露 vs B_锚点 Δtotal=${fmt(discDelta * 100, 4)}pp（unknown 日 A 有仓且>0.2 时才非零）\n`);

// ── 逐日记录 + 账本 ──
// 口径修正（首跑发现）：premium/shadow 的累计用**净值差**（navA−navB / navC−navA），
// 期末值与锚点严格可逆（= 两轨 total 之差：保费 2.21pp、影子C0.3 +0.82pp 完全对账）。
// 框架 §三原文"Σ(A日收益−B日收益)"的算术和受复利路径影响系统性偏离锚点
// （实测 2.86pp vs 2.21pp）——按"账本必须与锚点可逆"纪律改净值差，待框架勘误确认。
const records = [];
let navA = 1, navB = 1, peakA = 1, peakB = 1;
// ── S3-1 即时轨估值锚（2026-10-07）：页面日内权益的数字唯一出处 ──
// 轨道 A 是账户级仓位模拟（指数池 × targetPos，无个股持仓），当日日内权益 =
//   equity_prev × (1 + Σ pos_today[a] × 指数实时涨幅% ÷ 池资产数)
// （消费端 src/intraday_live.js，公式两端单测锁死）。nav_series 为全史日权益
// （元口径 = Π(1+dayReturns.A) × INIT_CASH），供 accountStats 历史峰值口径用。
const INIT_CASH = 1000000; // 元口径基期（轨道 A 本体是 1.0 基期比例模拟，元化只为报告可读）
const IDX_CODE = { 上证指数: 'sh000001', 深证成指: 'sz399001', 创业板指: 'sz399006' }; // 腾讯行情代码映射（未知资产 code=null → 页面该资产跳过并如实降级）
const navSeries = [];
const navC = { 0.3: 1, 0.4: 1, 0.5: 1 };
let premiumCum = 0;
const shadowCum = { 0.3: 0, 0.4: 0, 0.5: 0 };
const epRun = { 0.3: 0, 0.4: 0, 0.5: 0 };
let activeRun = 0;
for (let i = 0; i < n; i++) {
  navA *= 1 + A.strat[i];
  navB *= 1 + Bdisc.strat[i];
  navSeries.push({ date: dates[i], equity: r(navA * INIT_CASH, 2) }); // S3-1 估值锚（元口径，分位精度）
  for (const c of SHADOW) navC[c] *= 1 + C[c].strat[i];
  peakA = Math.max(peakA, navA);
  peakB = Math.max(peakB, navB);
  const ddA = 1 - navA / peakA;
  const ddB = 1 - navB / peakB;
  premiumCum = navA - navB;
  for (const c of SHADOW) shadowCum[c] = navC[c] - navA;
  const active = i > 0 && regimeKeys[i - 1] === 'shift';
  if (active) activeRun++;
  const biting = {};
  for (const c of SHADOW) {
    shadowCum[c] += C[c].strat[i] - A.strat[i];
    const bit = active && C[c].pos[i] < A.pos[i] - 1e-9;
    biting[c] = bit;
    if (bit) epRun[c]++;
  }
  const key = regimeKeys[i];
  const label = regimeSeries[i].label;
  const reasons = key === 'shift' && regimeSeries[i].caution
    ? String(regimeSeries[i].caution).split('；') : [];
  const posGap = A.pos[i] - Bdisc.pos[i];
  records.push({
    date: dates[i],
    score: r(scores[i], 2),
    regime: {
      key, label,
      cap: capsDisc[i] == null ? null : r(capsDisc[i], 2),
      reasons,
      note: key === 'unknown' ? '状态缺失，参考线按保守档 0~20%' : null,
    },
    trackA: {
      targetPos: Object.fromEntries(ASSETS.map((a) => [a, r(A.posByAsset[a][i], 4)])),
      poolPos: r(A.pos[i], 4),
      executed: true,
    },
    trackB: {
      refPos: Object.fromEntries(ASSETS.map((a) => [a, r(Bdisc.posByAsset[a][i], 4)])),
      poolPos: r(Bdisc.pos[i], 4),
      executed: false,
    },
    divergence: {
      posGap: r(posGap, 4),
      note: posGap > 1e-9
        ? `分歧 = 保险当日保费敞口（A 池仓位 − B 池仓位）${key === 'unknown' ? '；状态缺失，参考线按保守档' : ''}`
        : null,
    },
    trackC: {
      active,
      shadowPos: Object.fromEntries(SHADOW.map((c) => [String(c), r(C[c].pos[i], 4)])),
      biting: Object.fromEntries(SHADOW.map((c) => [String(c), biting[c]])),
    },
    dayReturns: {
      A: r(A.strat[i]),
      B: r(Bdisc.strat[i]),
      ...Object.fromEntries(SHADOW.map((c) => [`C${c}`, r(C[c].strat[i])])),
    },
    ledger: {
      since: dates[0],
      premiumCum: r(premiumCum),
      coverageCum: r(ddA - ddB),
      shadowCum: Object.fromEntries(SHADOW.map((c) => [String(c), r(shadowCum[c])])),
      episodes: { ...epRun },
      activeDays: activeRun,
    },
  });
}

// ── 汇总统计 ──
let posGap02 = 0, posGap03 = 0, posGapMax = 0, posGapMaxDate = null;
for (let i = 0; i < n; i++) {
  const g = A.pos[i] - Bdisc.pos[i];
  if (g > 0.02) posGap02++;
  if (g > 0.03) posGap03++;
  if (g > posGapMax) { posGapMax = g; posGapMaxDate = dates[i]; }
}
const shiftEpisodes = [];
for (let i = 1; i < n; i++) {
  if (regimeKeys[i - 1] !== 'shift') continue;
  shiftEpisodes.push({
    date: dates[i],
    prevDate: dates[i - 1],
    aRet: A.strat[i],
    c03: C[0.3].strat[i],
    c04: C[0.4].strat[i],
    c05: C[0.5].strat[i],
    d03: C[0.3].strat[i] - A.strat[i],
    bit03: C[0.3].pos[i] < A.pos[i] - 1e-9,
    bit04: C[0.4].pos[i] < A.pos[i] - 1e-9,
    bit05: C[0.5].pos[i] < A.pos[i] - 1e-9,
  });
}

// ── 输出 JSON ──
const NOTES = {
  trackA: '执行轨：V5.2 主信号（scoreWith + positions 四档阈值，唯一真实执行）',
  trackB: '参考线：V5.3-A 全量帽，每日计算逐日披露、永不执行；unknown → 保守档 0.2（CONSERVATIVE_BAND，缺失显式化）',
  trackC: '影子轨：T 日 regime=shift → T+1 日仓位帽 = C，三线 {0.3,0.4,0.5} 同记，晋升前不得收窄',
  premiumCum: '净值差 navA − navB（B=披露口径），日更；期末值 = 两轨 total 之差，与锚点严格可逆。正 = 整份保险累计保费',
  coverageCum: 'A当前回撤 − B当前回撤（各自相对自身运行峰，日更状态量）；整期保额见 summary.coverageMax',
  shadowCum: '净值差 navC − navA；正 = 影子线累计跑赢执行轨（期末值 = C.total − A.total，与实验 Δ 同口径；框架 §三"Σ(A−C)"符号与公式均有误，待勘误）',
  episodes: '影子生效日（前日 shift 且池仓位真被压到 A 之下）计数；晋升门禁分母（≥10 才可提案）',
  disclaimer: DISCLAIMER,
};
const outJson = {
  tool: 'paper_dual_track',
  spec: 'docs/dual_track_framework.md §二/§三',
  generatedAt: new Date().toISOString(),
  trackState: {
    activeTrack: FALLBACK ? 'A_fallback' : 'A',
    paramsSource: FALLBACK ? `冻结快照 @${FB.commit}（data/paper/track_fallback_params.json）` : 'config.json params.train',
    fallback: FALLBACK ? trackState.fallback || null : null,
    note: '唯一事实源 data/paper/track_state.json；回滚/恢复唯一通道 = scripts/rollback_track.mjs（P1，2026-10-06 拍板）',
  },
  sample: { from: dates[0], to: dates[n - 1], days: n },
  p2Start: P2_START,
  p2StartNote: P2_START ? `账本以 ${P2_START} 为基期第二套累计见 ledgerP2` : '模拟盘启动日回填后启用 P2 基期账本；当前 ledger 为全样本重放（锚点验证 + 曲线）',
  gates: {
    trackA_v52: { total: r(A.perf.total), maxDd: r(A.perf.maxDd), ref: 'data/backtest.json::v52' },
    trackB_v53: { total: r(Bref.perf.total), maxDd: r(Bref.perf.maxDd), ref: 'data/backtest.json::v53', note: '锚点口径 unknown→null；披露口径见 trackB' },
    shadowC_t1: {
      0.3: { total: r(C[0.3].perf.total), maxDd: r(C[0.3].perf.maxDd), episodes: episodes[0.3] },
      0.4: { total: r(C[0.4].perf.total), maxDd: r(C[0.4].perf.maxDd), episodes: episodes[0.4] },
    },
    disclosureDelta: { unknownDays: unknownIdx.length, dates: unknownIdx.map((i) => dates[i]), deltaTotal: r(discDelta) },
  },
  summary: {
    trackA: { total: r(A.perf.total), maxDd: r(A.perf.maxDd), sharpe: r(A.perf.sharpe) },
    trackB: { total: r(Bdisc.perf.total), maxDd: r(Bdisc.perf.maxDd), sharpe: r(Bdisc.perf.sharpe) },
    trackC: Object.fromEntries(SHADOW.map((c) => [String(c), {
      total: r(C[c].perf.total), maxDd: r(C[c].perf.maxDd), sharpe: r(C[c].perf.sharpe),
      episodes: episodes[c], shadowCumEnd: r(shadowCum[c]),
    }])),
    ledgerEnd: records[n - 1].ledger,
    coverageMax: r(A.perf.maxDd - Bdisc.perf.maxDd),
    divergence: { daysGt02: posGap02, daysGt03: posGap03, max: r(posGapMax, 4), maxDate: posGapMaxDate, thresholds: '0.02/0.03 为 P2 观察清单第一节 [待确认] 告警/暂停阈值' },
    regimeCensus: Object.fromEntries([...new Set(regimeKeys)].map((k) => [k, regimeKeys.filter((x) => x === k).length])),
    activeDays, shiftEpisodes: shiftEpisodes.length,
  },
  notes: NOTES,
  days: records,
};
mkdirSync(join(ROOT, 'data', 'paper'), { recursive: true });
atomicWriteJSON(join(ROOT, 'data', 'paper', 'dual_track.json'), JSON.stringify(outJson));
atomicWriteJSON(join(ROOT, 'data', 'paper', 'dual_track_latest.json'), JSON.stringify({
  tool: 'paper_dual_track',
  generatedAt: outJson.generatedAt,
  trackState: outJson.trackState,
  sample: outJson.sample,
  gates: outJson.gates,
  day: records[n - 1],
  // S3-1 即时轨估值锚（optional 段，schemas/dual-track-latest.schema.json 同步）：
  // 老档无此段 → 页面采样器待命不冒充；新档 = 页面 fetch 本文件即齐活（免拉全史 dual_track.json）。
  intraday_valuation: {
    equity_prev: navSeries[n - 1].equity,
    init_cash: INIT_CASH,
    pos_today: records[n - 1].trackA.targetPos,
    pool: ASSETS.map((a) => ({ name: a, code: IDX_CODE[a] ?? null })),
    nav_series: navSeries,
  },
  summary: outJson.summary,
  notes: NOTES,
}), 'utf8');

// ── 控制台呈报 ──
const censusOrder = ['ice', 'ebb', 'recover', 'neutral', 'climax', 'shift', 'unknown'];
console.log('═══ 档位普查（全样本重放） ═══');
console.log(censusOrder.filter((k) => outJson.summary.regimeCensus[k]).map((k) => `${k}×${outJson.summary.regimeCensus[k]}`).join('  '));
console.log(`影子 activeDays（前日 shift）=${activeDays}，生效日（真咬合）0.3/0.4/0.5 = ${episodes[0.3]}/${episodes[0.4]}/${episodes[0.5]}`);

const last = records[n - 1];
console.log(`\n═══ 最新交易日三轨快照（${last.date}） ═══`);
console.log(`  regime=${last.regime.key}（${last.regime.label}）帽=${last.regime.cap}  情绪分=${last.score}`);
console.log(`  A 执行轨   池仓位 ${fmt(last.trackA.poolPos)}   当日 ${pct(last.dayReturns.A)}`);
console.log(`  B 参考线   池仓位 ${fmt(last.trackB.poolPos)}   当日 ${pct(last.dayReturns.B)}   分歧 posGap=${fmt(last.divergence.posGap, 3)}`);
console.log(`  C 影子轨   active=${last.trackC.active}  池仓位 ${SHADOW.map((c) => `${c}:${fmt(last.trackC.shadowPos[String(c)])}`).join(' ')}  当日 ${SHADOW.map((c) => `${c}:${pct(last.dayReturns[`C${c}`])}`).join(' ')}`);

console.log('\n═══ 账本总览（全样本重放） ═══');
console.log(`  保费 premiumCum   = ${fmt(premiumCum * 100, 2)}pp（净值差 navA−navB；A ${pct(A.perf.total)} vs B 披露口径 ${pct(Bdisc.perf.total)}）`);
console.log(`  锚点对账          = 披露口径期末 ${fmt(premiumCum * 100, 2)}pp vs 锚点口径（B_锚 unknown→null）${fmt((A.perf.total - Bref.perf.total) * 100, 2)}pp，差 = unknown ${unknownIdx.length} 日保守档`);
console.log(`  保额 coverageMax  = ${fmt((A.perf.maxDd - Bdisc.perf.maxDd) * 100, 2)}pp（A maxDd ${pct(A.perf.maxDd)} vs B ${pct(Bdisc.perf.maxDd)}）；当前回撤差 ${fmt(last.ledger.coverageCum * 100, 2)}pp`);
for (const c of SHADOW) {
  console.log(`  影子 C${c}        = 累计 ${fmt(shadowCum[c] * 100, 2)}pp / ${episodes[c]} 生效日 / maxDd ${pct(C[c].perf.maxDd)} / 夏普 ${fmt(C[c].perf.sharpe)}`);
}
console.log(`  分歧统计          = posGap>2% [待确认] ${posGap02} 日 / >3% [待确认] ${posGap03} 日 / 最大 ${fmt(posGapMax, 3)}（${posGapMaxDate}）`);
console.log(`  ⚠ 校准警告        = A−B 分歧是保险保费敞口（结构性常态，${posGap02}/${n} 日 >2%）——框架 §六将其接入 2%/3% 告警阈值的接线会天天触发"暂停调仓"；该阈值应属轨道 A 的执行残差（意图 vs 实际），A−B 分歧只披露不告警。待框架 §六勘误`);

console.log(`\n═══ 影子生效日全列（shift 次日帽逐日账，${shiftEpisodes.length} 个 active 日） ═══`);
console.log('生效日        前日(shift)   A当日     C0.3      C0.4      C0.5      Δ(C0.3−A)  咬合(0.3/0.4/0.5)');
for (const e of shiftEpisodes) {
  console.log(`${e.date}  ${e.prevDate}  ${pct(e.aRet).padStart(8)}  ${pct(e.c03).padStart(8)}  ${pct(e.c04).padStart(8)}  ${pct(e.c05).padStart(8)}  ${fmt(e.d03 * 100, 2).padStart(7)}pp  ${e.bit03 ? 'Y' : '-'}/${e.bit04 ? 'Y' : '-'}/${e.bit05 ? 'Y' : '-'}`);
}

// ── Markdown 报告（呈审用） ──
const md = [];
md.push('# P2-α 三轨道纸面记账：首跑全样本重放');
md.push('');
md.push(`生成：node tools/backtest/paper_dual_track.mjs · 样本 ${dates[0]} ~ ${dates[n - 1]}（${n} 交易日）`);
md.push('');
md.push('三重门禁全绿：① 轨道A ↔ v52（-1.50%/13.79%）② 轨道B 锚点口径 ↔ v53（-3.71%/8.78%）③ 影子C0.3 ↔ 实验T1（-0.68%/14.03%/18 生效日）。');
md.push(`披露口径核查：unknown ${unknownIdx.length} 日（${unknownIdx.map((i) => dates[i]).join('、') || '无'}），B_披露 vs B_锚点 Δtotal=${fmt(discDelta * 100, 4)}pp。`);
md.push('');
md.push('## 轨道与账本口径');
md.push('');
md.push(`- **A 执行轨**：${NOTES.trackA}`);
md.push(`- **B 参考线**：${NOTES.trackB}`);
md.push(`- **C 影子轨**：${NOTES.trackC}`);
md.push(`- **premiumCum**：${NOTES.premiumCum}`);
md.push(`- **coverageCum**：${NOTES.coverageCum}`);
md.push(`- **shadowCum**：${NOTES.shadowCum}`);
md.push(`- **episodes**：${NOTES.episodes}`);
md.push('');
md.push('## 账本总览');
md.push('');
md.push('| 项目 | 数值 |');
md.push('|---|---|');
md.push(`| 保费 premiumCum（净值差） | ${fmt(premiumCum * 100, 2)}pp（A ${pct(A.perf.total)} vs B 披露口径 ${pct(Bdisc.perf.total)}） |`);
md.push(`| 锚点对账 | 披露口径期末 ${fmt(premiumCum * 100, 2)}pp vs 锚点口径 ${fmt((A.perf.total - Bref.perf.total) * 100, 2)}pp，差 = unknown ${unknownIdx.length} 日保守档 |`);
md.push(`| 保额 coverageMax | ${fmt((A.perf.maxDd - Bdisc.perf.maxDd) * 100, 2)}pp（A ${pct(A.perf.maxDd)} vs B ${pct(Bdisc.perf.maxDd)}） |`);
for (const c of SHADOW) {
  md.push(`| 影子 C${c} | 累计 ${fmt(shadowCum[c] * 100, 2)}pp / ${episodes[c]} 生效日 / maxDd ${pct(C[c].perf.maxDd)} / 夏普 ${fmt(C[c].perf.sharpe)} |`);
}
md.push(`| 分歧 posGap | >2% ${posGap02} 日 / >3% ${posGap03} 日 / 最大 ${fmt(posGapMax, 3)}（${posGapMaxDate}） |`);
md.push('');
md.push(`⚠ **posGap 校准警告（首跑发现，待框架 §六勘误）**：A−B 分歧是保险保费敞口（结构性常态，${posGap02}/${n} 日 >2%）。框架 §六将 divergence.posGap 接入"仓位残差监控"的 2% 告警 / 3% 暂停阈值，会天天触发"暂停调仓"。该阈值应属轨道 A 的执行残差（意图仓位 vs 实际成交，需实盘数据），A−B 分歧只披露不告警。`);
md.push('');
md.push('## 最新交易日快照');
md.push('');
md.push('```jsonc');
md.push(JSON.stringify({ date: last.date, regime: last.regime, trackA: last.trackA, trackB: last.trackB, divergence: last.divergence, trackC: last.trackC, dayReturns: last.dayReturns, ledger: last.ledger }, null, 2));
md.push('```');
md.push('');
md.push('## 影子生效日逐日账（shift 次日帽）');
md.push('');
md.push('| 生效日 | 前日(shift) | A当日 | C0.3 | C0.4 | C0.5 | Δ(C0.3−A) | 咬合(0.3/0.4/0.5) |');
md.push('|---|---|---|---|---|---|---|---|');
for (const e of shiftEpisodes) {
  md.push(`| ${e.date} | ${e.prevDate} | ${pct(e.aRet)} | ${pct(e.c03)} | ${pct(e.c04)} | ${pct(e.c05)} | ${fmt(e.d03 * 100, 2)}pp | ${e.bit03 ? 'Y' : '-'}/${e.bit04 ? 'Y' : '-'}/${e.bit05 ? 'Y' : '-'} |`);
}
md.push('');
md.push('## 晋升门禁进度（框架 §四）');
md.push('');
md.push('| 条件 | 门槛 | 当前（全样本重放） | 状态 |');
md.push('|---|---|---|---|');
md.push(`| 样本量 | P2 影子生效日 ≥ 10 | 历史重放 ${episodes[0.3]} 日（C0.3） | P2 基期启动后从 0 重计 |`);
const sameSign = Math.sign(shadowCum[0.3]) === Math.sign(shadowCum[0.4]) && Math.sign(shadowCum[0.3]) === Math.sign(shadowCum[0.5]);
md.push(`| 方向一致性 | 三线累计增益同号 | ${SHADOW.map((c) => `${fmt(shadowCum[c] * 100, 2)}pp`).join(' / ')} | ${sameSign ? '同号' : '分裂'} |`);
md.push(`| 结构占比 | 生效日贡献/净增益 ≥ 50% | 见 experiment_dual_track ⑧（结构 +2.70pp / 级联 -1.87pp） | 历史：约 59% |`);
md.push('| 残差纪律 | 生效日后 5 日额外仓位 ≤ 0.05 | 压仓类规则天然满足 | 留门禁记录 |');
md.push('');
md.push(`> ${DISCLAIMER}`);
md.push('');
mkdirSync(join(ROOT, 'tools', 'backtest', 'reports'), { recursive: true });
writeFileSync(join(ROOT, 'tools', 'backtest', 'reports', 'paper_dual_track.md'), md.join('\n'), 'utf8');

// ── 镜像自愈（P1）：signals-latest.json 的 active_track 展示镜像 ──
// 真相：signals-latest.json 是 pipeline 每轮抓取的重写产物，镜像字段会被冲掉——所以
// 本工具在 fallback 态下每次运行都补写（自愈）；A 态不写（生产文件保持零 diff，
// 恢复 = rollback_track.mjs --restore 时清除镜像）。契约：signals-latest.schema.json
// 未禁额外字段（additionalProperties 未设），check_contract 实测通过；正式字段化走
// P2-β schema 契约流程（用户已裁：P1 完成后一并走）。
if (FALLBACK) {
  try {
    const sigPath = join(ROOT, 'data', 'signals-latest.json');
    const sig = JSON.parse(readFileSync(sigPath, 'utf8'));
    // 文案唯一出处 src/dual_track.js::buildTrackNote；无条件对账事实源——「在场」≠「完整」
    // （E2E 终测实录：回滚写入的 note 六要素残缺时，旧逻辑看 active_track 已在场就跳过
    // 重写，残缺 note 存活到下一轮抓取冲刷——自愈必须按事实源逐字对账，漂移即重写）
    const note = buildTrackNote(trackState.fallback, FB.commit);
    // dualTrack 披露块同轮自愈（E2E 终测实录的第二处间隙：回滚后账本已切 fallback，
    // 披露块停留 A 态直到下轮抓取 → crossCheckDualTrack 门禁红窗口。块组装唯一出处
    // src/dual_track.js::dualTrackBlock——读的正是本工具刚写的 dual_track_latest.json，
    // 与抓取管线 dualTrackDisclosureFn 同源同构，无第二套口径）。
    const block = dualTrackBlock(JSON.parse(readFileSync(join(ROOT, 'data', 'paper', 'dual_track_latest.json'), 'utf8')));
    if (sig.active_track !== 'A_fallback' || sig.activeTrackNote !== note
      || (block && JSON.stringify(sig.dualTrack) !== JSON.stringify(block))) {
      sig.active_track = 'A_fallback';
      sig.activeTrackNote = note;
      if (block) sig.dualTrack = block;
      atomicWriteJSON(sigPath, JSON.stringify(sig, null, 2) + '\n');
      console.log('[paper] 已自愈 signals-latest.json 的 active_track 镜像 + dualTrack 披露块（按事实源逐字对账）');
    }
  } catch (e) { console.error(`[paper] ⚠ 镜像自愈失败（不阻塞账本）：${e.message}`); }
}

console.log('\n[paper] 已写 data/paper/dual_track.json + dual_track_latest.json + tools/backtest/reports/paper_dual_track.md');
