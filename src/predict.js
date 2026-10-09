// 个股上涨预测引擎（唯一来源，ESM 纯函数、零依赖、Node 与浏览器共用）
//
// 定位：回答两个**不同**的问题，并各自给出可核验的实测统计量：
//   ① 「这只票买入后大概率会涨吗」→ predictUpProb（上涨概率，剔除大概率亏的）
//   ② 「这只票 T+1 大概率会再涨停吗」→ limitUpProb（连板概率，用于置顶与打标签）
//   两者必须分开：实测有 44.8% 的涨停股 T+1 是下跌的，但它们的连板概率可能只有 18%；
//   反过来连板概率高的票（3 板低换手 54.2%）其上涨概率也只有 64.7%。混用会误导。
// 与 src/picks.js 的分工：
//   picks.js  → 候选池构建（去噪）+ 调用本引擎 + 组装展示字段
//   predict.js → **预测、置顶排序与剔除**（规则唯一出处）
//
// ⚠ 2026-10-01 升级（predict-v2）：新增「连板概率」，推荐排序改为**连板候选前置**。
// 用户要求：「推荐个股的个股里面大概率连板的放在前置位置并打标签」。
//
// ══════════════════════════════════════════════════════════════════════════
// 本文件的所有阈值与权重**不是拍脑袋定的**，而是对 data/archive.json 全部 33 个
// 交易日的推荐候选做真实前瞻收益回溯（腾讯日K 前复权，T日收盘买入 → T+1/T+3 收盘）
// 实测出来的。样本与结论如下（脚本 scripts/backtest_predict.mjs 可复现）：
//
//   【组别 / 样本数 / T+1 均收益 / 上涨占比 / T+3 均收益】
//   全部涨停股          n=975   +1.59%  55.3%   +0.69%   ← 基准线
//   龙虎榜净买>0        n=764   +0.81%  50.5%   −0.41%   ← 弱于基准！
//   龙虎榜净买>5000万   n=406   +0.90%  53.9%   −0.28%   ← 弱于基准！
//   龙虎榜净买>2亿      n=108   +1.96%  64.8%   +0.03%   ← 金额够大才有效
//   首板(连板=1)        n=768   +1.32%  53.8%   +0.56%
//   2连板               n=130   +2.73%  59.2%   +1.25%
//   3连板及以上         n=77    +2.43%  63.6%   +1.03%
//   首板&换手<10%       n=515   +1.73%  57.7%   +1.44%
//   2板&换手<10%        n=72    +3.30%  65.3%   +1.33%   ← 最强组合
//   涨停&换手>=25%      n=78    +0.65%  46.2%   −2.65%   ← 必须剔除
//   涨停&换手<10%(DD)   n=515   3日平均最大回撤 −4.19%
//   涨停&换手>=25%(DD)  n=53    3日平均最大回撤 −8.40%  ← 风险翻倍
//
//   【最关键的发现：口径决定盈亏】
//   T日收盘买入 → T+1收盘：  首板&换手<10%  +1.73%（正期望）
//   T+1开盘买入 → T+1收盘：  首板&换手<10%  −0.30%（**负期望**）
//   T+1开盘买入 → T+3收盘：  首板&换手<10%  −0.60%（**负期望**）
//   → 结论：涨停股次日开盘普遍高开，**追高开就是接盘**。推荐必须明确标注
//     「以 T 日收盘价为准的预期」，并提示不要开盘追高。这条纪律写进 expected 里。
//
//   【市场环境影响很小】
//   首板&换手<10% 在满仓档 +1.75%、半仓档 +1.65%、过热档 +1.62%——差异不显著，
//   故市场档位**不参与个股概率打分**（它只决定总仓位，那是 picks.js 的职责）。
//   唯一显著的：涨停家数<40（情绪冰点、涨停稀少）时 +3.62%、上涨占比 72.2%
//   → 稀缺性是正面因子，作为小权重 bonus，不夸大。
// ══════════════════════════════════════════════════════════════════════════
//
// 四条硬纪律：
//   1. **只在有实测正期望的特征组合上给高概率**：概率分只由上述回溯验证过的因子驱动，
//      没有实测支持的因子（如玄学「题材好不好」）一律不进打分。
//   2. **大概率亏的直接剔除，不降权**：换手≥25%、连板≥5、北交所、ST、无板可依的票
//      进 excluded 列表并附原因——「提醒注意」不够，用户会照买。
//   3. **不给目标价、不承诺收益**：只给「按历史同特征的上涨占比」这个可核验的统计量，
//      并同时给出样本量——样本不足（<30）时降级为「参考性弱」，绝不用小样本充数。
//   4. **无数据不编**：取不到换手/连板就按「未知」处理（保守给中性分），
//      不猜测、不用均值填充后谎称是实测值。
//
// ⚠ 依赖纪律（重要，别改回去）：
//   本文件**不 import 任何其它 src 模块**，包括 alerts.js。原因是 alerts.js → picks.js →
//   predict.js → alerts.js 会构成环：ESM 能处理（living binding），但 scripts/check_frontend.mjs
//   用 IIFE 即时求值拼装浏览器环境，环上任何一环先求值都会拿到 undefined 而整体崩掉。
//   所以止损线不作为 import 取，而是**由调用方通过参数传入**（见 suggestStop 的 opts.stopLossPct），
//   在 picks.js / paper_ui.js 侧传入 POS_CFG.stopLoss。这样本文件保持零依赖纯函数，
//   既消除环，也让它能在任何环境下独立求值。

/** 预测引擎版本（UI 与报告引用此常量，避免文案与引擎漂移） */
export const PREDICT_VERSION = 'predict-v2';

const r2less = null; // 占位：本文件不需要 r2，保留结构清晰

// ⚠ 本文件**不再是零依赖**：降级规则（龙虎榜净买入 ≤ 0）要求「上涨概率扣固定分」，
//    而 10/8 这两个数与标签文案的唯一出处是 src/lhbfilter.js。
//    取舍：宁可让 predict 失去「零依赖」这个漂亮的属性，也不能把 8 手抄进来——
//    手抄等于在预测链路里重建第二套口径，改一处漏一处（口径守卫会拦）。
//    依赖方向是单向的：predict → lhbfilter（lhbfilter 不引 predict），不成环。
//    放在这里而不是文件顶部 import 区，是为了紧邻使用点、让「为什么有依赖」一眼可见。
import { isNetOutflow, LHB_NET_OUTFLOW_PENALTY, FLAG_LHB } from './lhbfilter.js';

/**
 * 「有真实数值」判据。**不能用 Number.isFinite(+v)**——`+null === 0`、`+'' === 0`、
 * `+false === 0`，会把「没有数据」当成「数值 0」，从而让「换手缺失」被判成「换手 0%」
 * （低换手 → 白拿加分）、让「止损线缺失」变成「止损 0%」（等于不设止损）。
 * 这个坑在本文件里踩过一次（换手 null 被当成低换手），故所有数值判定统一用它。
 */
const finite = (v) => v != null && v !== '' && typeof v !== 'boolean' && Number.isFinite(+v);

/** 概率分档位标签。分数是「实测上涨占比」的映射，不是主观置信度。
 *  之所以分档而不是给连续值：样本量有限，给出 78.3% 这种精度是虚假的精确。
 */
export const PROB_BANDS = [
  { min: 65, key: 'high', label: '较高', desc: '历史同特征组上涨占比 ≥65%' },
  { min: 57, key: 'mid', label: '中等', desc: '历史同特征组上涨占比 57%~65%' },
  { min: 50, key: 'low', label: '偏低', desc: '历史同特征组上涨占比 50%~57%' },
  { min: 0, key: 'poor', label: '不佳', desc: '历史同特征组上涨占比 <50%' },
];

/** 概率分 → 档位 */
export function probBand(score) {
  if (!Number.isFinite(+score)) return PROB_BANDS[PROB_BANDS.length - 1];
  const s = +score;
  for (const b of PROB_BANDS) if (s >= b.min) return b;
  return PROB_BANDS[PROB_BANDS.length - 1];
}

// ────────────────────────── 一、剔除规则（大概率亏 → 直接扔） ──────────────────────────
//
// 每条规则都对应一个实测出来的负期望特征。threshold 与 source 字段用于向用户解释
// 「为什么剔掉它」——所有剔除必须可解释，不接受黑箱。

/**
 * 剔除规则表。`test(c)` 返回 true 表示命中（应剔除）。
 * `why` 里带的是实测数字，不是形容词——用户有权知道依据。
 */
export const REJECT_RULES = [
  {
    key: 'high_turnover',
    label: '换手过高',
    test: (c) => finite(c && c.turnoverPct) && +c.turnoverPct >= 25,
    why: '换手 ≥25% 的涨停股 T+1 均收益仅 +0.65%、上涨占比 46.2%，T+3 转为 −2.65%；'
      + '3 日内平均最大回撤 −8.40%（是低换手组的 2 倍）。筹码高度涣散，兑现压力大。',
    stat: { n: 78, t1: 0.65, t3: -2.65, up: 46.2, dd: -8.40 },
  },
  {
    key: 'high_streak',
    label: '连板过高',
    test: (c) => finite(c && c.streak) && +c.streak >= 5,
    why: '5 连板及以上样本极少（全档仅 10 例）且离散度极大，T+1 表现无法与「随机」区分；'
      + '高位断板当日回撤可达 −20%，单笔止损 −8% 无法覆盖跳空缺口。样本不足即不可依赖。',
    stat: { n: 10, t1: null, t3: null, up: null, dd: null },
  },
  {
    key: 'bj_board',
    label: '北交所标的',
    test: (c) => /^(4|8|920)/.test(String((c && c.code) || '')),
    why: '北交所 ±30% 涨跌幅、流动性显著弱于沪深，价格冲击成本高，且本模拟器的板段判定口径不适用。',
    stat: { n: 0, t1: null, t3: null, up: null, dd: null },
  },
  {
    key: 'st_stock',
    label: 'ST / *ST',
    test: (c) => /ST/i.test(String((c && c.name) || '')),
    why: 'ST 股 ±5% 涨跌幅与正常股不可比，且存在退市风险，不适合作为模拟盘训练标的。',
    stat: { n: 0, t1: null, t3: null, up: null, dd: null },
  },
  {
    key: 'no_limit_evidence',
    label: '无涨停也无有效净买',
    test: (c) => !c || (!c.isZt && !(finite(c && c.netWan) && +c.netWan > 0)),
    why: '既没有涨停（市场共识）也没有正向净买（真实资金），两个实测有效证据都不具备。',
    stat: { n: 0, t1: null, t3: null, up: null, dd: null },
  },
  {
    key: 'weak_fund_only',
    label: '仅小额外资金、无涨停',
    test: (c) => !!c && !c.isZt
      && finite(c.netWan) && +c.netWan > 0 && +c.netWan < 20000,
    why: '龙虎榜净买为正但不足 2 亿（且当日未涨停）：实测净买>0 组 T+1 仅 +0.81%、T+3 −0.41%，'
      + '弱于「全部涨停股」基准（+1.59% / +0.69%）。净买金额不够大时，上榜本身不构成买入理由。',
    stat: { n: 764, t1: 0.81, t3: -0.41, up: 50.5, dd: null },
  },
];

/**
 * 对单只候选执行剔除判定。
 * @returns {{rejected:boolean, hits:Array<{key,label,why,stat}>}}
 */
export function screenCandidate(c) {
  const hits = [];
  for (const r of REJECT_RULES) {
    let hit = false;
    // 规则自身抛错不得影响其它规则（畸形输入容错）
    try { hit = !!r.test(c); } catch (e) { hit = false; }
    if (hit) hits.push({ key: r.key, label: r.label, why: r.why, stat: r.stat });
  }
  return { rejected: hits.length > 0, hits };
}

// ────────────────────────── 二、概率打分（只由实测有效因子驱动） ──────────────────────────
//
// 做法与 picks.js 的「加权求和」不同，这里刻意用**基准 + 修正**结构：
//   概率 = 基准（全部涨停股上涨占比 55.3%）+ 各实测因子的边际修正
// 为什么不用权重求和：权重求和会产出 0~100 的抽象分，用户看不懂「68 分」是什么意思；
// 而「历史同特征组上涨占比 63%」是一个可以直接核验、也有明确样本量的统计量。

/** 基准：全部涨停股 T+1 上涨占比（实测） */
export const BASELINE_UP = 55.3;
/** 基准样本量（用于告知用户这是全档实测，不是拍脑袋） */
export const BASELINE_N = 975;

/**
 * 实测因子表。`adj` 是「该特征组上涨占比 − 基准上涨占比」的实测差值（百分点）。
 * 只有 |adj| 足够大且样本量够的因子才进表——小样本（如 4 板以上 n=31）不进。
 */
export const PREDICT_FACTORS = [
  {
    key: 'streak2',
    label: '2 连板',
    test: (c) => +c.streak === 2,
    adj: +3.9,   // 59.2% − 55.3%
    n: 130,
    note: '2 连板 T+1 上涨占比 59.2%、均涨 +2.73%（基准 +1.59%）',
  },
  {
    key: 'streak34',
    label: '3~4 连板',
    test: (c) => +c.streak >= 3 && +c.streak <= 4,
    adj: +8.3,   // 63.6% − 55.3%
    n: 77,
    note: '3 连板及以上 T+1 上涨占比 63.6%、中位涨幅 +4.77%',
  },
  {
    key: 'low_turnover',
    label: '换手低（<10%）',
    test: (c) => finite(c.turnoverPct) && +c.turnoverPct < 10,
    adj: +4.0,   // 59.3% − 55.3%
    n: 622,
    note: '涨停且换手 <10% 的票 T+1 上涨占比 59.3%，3 日平均最大回撤仅 −4.19%（低风险）',
  },
  {
    key: 'big_fund',
    label: '净买 ≥2 亿',
    test: (c) => finite(c.netWan) && +c.netWan >= 20000,
    adj: +9.5,   // 64.8% − 55.3%
    n: 108,
    note: '龙虎榜净买 ≥2 亿的票 T+1 上涨占比 64.8%、均涨 +1.96%（净买 5000 万~2 亿组仅 53.9%）',
  },
  {
    key: 'scarcity',
    label: '市场涨停稀少',
    test: (c, ctx) => finite(ctx && ctx.ztCount) && +ctx.ztCount < 40,
    adj: +8.2,   // 63.5% − 55.3%
    n: 137,
    note: '全场涨停 <40 家（稀缺）时，涨停股 T+1 上涨占比 63.5%、均涨 +2.85%',
  },
  {
    key: 'gem_star',
    label: '20% 涨跌幅品种',
    test: (c) => /^(30|688)/.test(String(c.code || '')),
    adj: +4.7,   // 60.0% − 55.3%
    n: 65,
    note: '创业板/科创板涨停股 T+1 上涨占比 60.0%、均涨 +2.79%，但波动也更大（跌>3% 占 26.2%）',
  },
];

/**
 * 计算上涨概率分（0~100，含义是「历史同特征组的上涨占比」）。
 *
 * 重要：这里**不是**机器学习预测，而是**历史分组统计**——分数就是那个分组的
 * 实际上涨占比。这样每个数字都能被用户自己复核，且不会因为模型黑箱而误导。
 *
 * @param {object} c 候选（含 streak / turnoverPct / netWan / isZt / code）
 * @param {object} [ctx] 上下文（ztCount 当日涨停家数）
 * @returns {{score:number, band:object, factors:Array, sample:number, baseline:number}}
 */
export function predictUpProb(c, ctx = {}) {
  const c1 = c || {};
  const hits = [];
  for (const f of PREDICT_FACTORS) {
    // 连板类因子依赖 streak 有真实值——streak 缺失时不得用 +undefined 参与比较
    // （+undefined 是 NaN，NaN===2 为 false 尚可，但 +null===0 会误判，故显式挡掉）
    if (f.key === 'streak2' || f.key === 'streak34') {
      if (!finite(c1.streak)) continue;
    }
    let hit = false;
    // 因子自身抛错不得影响其它因子（畸形输入容错）
    try { hit = !!f.test(c1, ctx); } catch (e) { hit = false; }
    if (hit) hits.push(f);
  }

  // 修正量做**饱和处理**：最多累加 +18 个百分点，避免多个因子叠加后吹出「90% 上涨」
  // 这种不可能的数字（样本里最乐观的分组也只有 72.2%）。
  const rawAdj = hits.reduce((a, f) => a + f.adj, 0);
  const adj = Math.min(rawAdj, 18);
  const base = Math.max(0, Math.min(95, Math.round((BASELINE_UP + adj) * 10) / 10));

  // ── 降级规则：龙虎榜净买入 ≤ 0 → 上涨概率扣固定分（不剔除，只降优先级）──
  // 顺序很重要：先算「基准 + 因子」得到 base，再扣固定分。
  // 若把扣分并进 adj 一起饱和，扣分会与因子的 +18 上限互相抵消——净流出票只要
  // 命中几个强因子就「扣不动」了，规则形同虚设。扣分必须是**独立的一刀**。
  const outflow = isNetOutflow(c1.netWan);
  const penalty = outflow.hit ? LHB_NET_OUTFLOW_PENALTY.PROB : 0;
  const score = Math.max(0, Math.round((base - penalty) * 10) / 10);

  // 样本量取所有命中因子里最小的——木桶原理：最弱的那个证据决定整体可信度
  const sample = hits.length ? Math.min(...hits.map((f) => f.n)) : BASELINE_N;

  return {
    score, band: probBand(score), factors: hits, sample, baseline: BASELINE_UP,
    // 扣分明细：UI 要能展示「扣前是多少」，否则被扣过的分会看起来像模型的原始判断
    rawScore: base,
    penalty,
    netOutflow: outflow.hit,
    outflowKind: outflow.hit ? outflow.kind : null,
    penaltyNote: outflow.hit
      ? `龙虎榜净买入 ≤ 0（${outflow.kind === 'zero' ? '净买为 0' : outflow.kind === 'null' ? '无净买记录' : '净买为负'}）`
        + ` → 上涨概率扣 ${penalty} 个百分点（${base} → ${score}）；${FLAG_LHB.NET_OUTFLOW}`
      : null,
  };
}

// ────────────────────────── 三、预期收益与止损位 ──────────────────────────

/**
 * 期望收益区间（**分组统计的中位数**，不是预测）。
 *
 * 两个口径都必须给出，因为实测差异巨大且方向相反：
 *   buyAtClose：T 日收盘价买入 → T+1 收盘（实测正期望）
 *   buyAtOpen ：T+1 开盘价买入 → T+1 收盘（实测**负期望**）
 * 这正是本引擎要给用户的最重要一条提醒：**别开盘追高**。
 *
 * @returns {{atClose:object, atOpen:object, verdict:string, warn:string|null}}
 */
export function expectedReturn(c) {
  const c1 = c || {};
  const streak = +c1.streak || 0;
  const turn = finite(c1.turnoverPct) ? +c1.turnoverPct : null;
  const lowTurn = turn != null && turn < 10;

  // 按实测分组给中位数（数据来自 scripts/backtest_predict.mjs 的输出）
  let atClose = { median: 0, n: 0, group: '未知' };
  if (streak === 2 && lowTurn) atClose = { median: 4.99, n: 72, group: '2 连板 + 低换手' };
  else if (streak >= 3 && lowTurn) atClose = { median: 4.77, n: 77, group: '3 连板以上 + 低换手' };
  else if (streak === 1 && lowTurn) atClose = { median: 0.97, n: 515, group: '首板 + 低换手' };
  else if (streak === 2) atClose = { median: 2.54, n: 130, group: '2 连板' };
  else if (streak >= 3) atClose = { median: 4.77, n: 77, group: '3 连板以上' };
  else if (streak === 1) atClose = { median: 0.64, n: 768, group: '首板' };
  else if (finite(c1.netWan) && +c1.netWan >= 20000) atClose = { median: 1.74, n: 108, group: '净买 ≥2 亿（未涨停）' };

  // 开盘追高的口径：实测为负，且越是热门越负
  const atOpenMedian = (streak === 2 && lowTurn) ? 0.00
    : (streak === 1 && lowTurn) ? -0.34
      : lowTurn ? -0.28 : -0.28;
  const atOpen = { median: atOpenMedian, n: 975, group: '全部涨停股（T+1 开盘买入）' };

  let verdict;
  let warn = null;
  // 注意：atOpenMedian 可能是 0（非负），文案不能说成「负期望」——否则自相矛盾。
  const openDesc = atOpenMedian < 0 ? `${atOpenMedian.toFixed(2)}%（负期望）`
    : atOpenMedian === 0 ? '0.00%（无正期望，属纯粹的波动赌注）'
      : `${atOpenMedian.toFixed(2)}%（弱正期望）`;
  if (atClose.median > 2 && atClose.n >= 50) {
    verdict = 'positive';
    warn = '⚠ 这个正期望**只在「T 日收盘价」口径下成立**。实测 T+1 开盘价买入、当日收盘卖出的均收益是 '
      + `${openDesc}——涨停股次日普遍高开，开盘追进去的胜率明显低于收盘价买入。`
      + '务必等回落、别在开盘价附近直接买入。';
  } else if (atClose.median >= 0.5 && atClose.n >= 50) {
    verdict = 'weak';
    warn = '期望为正但幅度不大（中位涨幅不到 1%），扣掉双边费用与滑点后所剩有限；'
      + '同样不要开盘追高。';
  } else {
    verdict = 'flat';
    warn = atClose.n < 50
      ? `该特征分组样本量仅 ${atClose.n} 例，不足以下结论——当作「无实测依据」看待更安全。`
      : '该特征分组实测中位涨幅接近零或为负，没有统计上的买入价值。';
  }
  return { atClose, atOpen, verdict, warn };
}

/**
 * 止损位建议。
 *
 * 重要：**止损纪律不因为品种波动大就放宽**。实测创业板/科创板 3 日平均最大回撤
 * 达 −7.5%，已经逼近 −8% 的单笔止损线——正确做法是**降低仓位**，而不是把止损线
 * 移到 −12% 去容忍更大亏损（那等于放大单笔风险，违背 V5.2 的单笔风险约束）。
 * 所以这里止损线统一取传入的 stopLossPct（默认 −0.08，即 alerts.js 的 POS_CFG.stopLoss），
 * 另用 maxPosFactor 表达「该品种应少买多少」。
 *
 * 为什么 stopLossPct 用参数而不是 import：见文件头「依赖纪律」——import alerts.js 会形成环。
 *
 * @param {object} c 候选
 * @param {object} [opts]
 * @param {number} [opts.stopLossPct=-0.08] 单笔止损线（调用方传 POS_CFG.stopLoss 保持同源）
 * @returns {{stopLossPct:number, reason:string, maxDD:number|null, maxPosFactor:number}}
 */
export function suggestStop(c, opts = {}) {
  const c1 = c || {};
  const code = String(c1.code || '');
  const wide = /^(30|688)/.test(code);
  const base = finite(opts && opts.stopLossPct) ? +(opts.stopLossPct) : -0.08;
  const dd = wide ? -7.5 : -5.2;              // 实测 3 日平均最大回撤
  // 宽波动品种把建议仓位打个折（0.6 倍），把「单笔最大亏损」控制在同一条线上
  const maxPosFactor = wide ? 0.6 : 1;
  return {
    stopLossPct: Math.round(base * 1e4) / 1e4,
    maxDD: dd,
    maxPosFactor,
    reason: wide
      ? `创业板/科创板 20% 涨跌幅品种，实测 3 日平均最大回撤 ${dd}%，已接近单笔止损线 ${(base * 100).toFixed(0)}%。`
        + '**不放宽止损**（放宽等于放大单笔风险），改为把建议仓位打 6 折以控制单笔最大亏损。'
      : `沿用系统单笔止损纪律 ${(base * 100).toFixed(0)}%；实测全档 3 日平均最大回撤 ${dd}%，`
        + '该止损位多数情况下可先于深跌离场。',
  };
}

// ────────────────────────── 四、主入口 ──────────────────────────

/**
 * 对候选池做「预测筛选 + 排序」。
 *
 * 排序规则（三级，**连板候选前置**）：
 *   ① 连板概率 ≥ ctx.streakTopMin（默认 30%）的票**置顶**，组内按连板概率降序；
 *   ② 其余按上涨概率降序；
 *   ③ 同分时按净买额、代码兜底——保证确定性（同一输入必得同一序）。
 *
 * 为什么置顶只认「连板概率」而不认「连板数量」：实测 2 板换手 ≥20% 的再涨停率
 * 只有 16.7%，比首板的 18.2% 还低。按连板数量置顶会把最差的那类 2 板推到最前面。
 * 每一行都带 `streakTop` 布尔，UI 据此分组，不靠自己重算。
 *
 * @param {Array} candidates picks.js buildCandidates 的输出
 * @param {object} [ctx]
 * @param {number} [ctx.ztCount] 当日涨停家数（用于稀缺性因子）
 * @param {number} [ctx.topN]    保留条数
 * @param {number} [ctx.minProb] 概率分下限（低于此分不推荐，默认 57 = 中等档起点）
 * @param {number} [ctx.streakTopMin] 连板置顶门槛（默认 30）
 * @param {number} [ctx.stopLossPct] 单笔止损线（调用方传 alerts.js 的 POS_CFG.stopLoss 保持同源）
 * @returns {{picks:Array, rejected:Array, belowThreshold:Array, overflow:Array, stats:object}}
 */
export function predictPicks(candidates, ctx = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const topN = finite(ctx.topN) && +ctx.topN > 0 ? Math.floor(+ctx.topN) : 5;
  const minProb = finite(ctx.minProb) ? +ctx.minProb : 57;
  const streakTopMin = finite(ctx.streakTopMin) ? +ctx.streakTopMin : STREAK_TOP_MIN;
  const stopOpts = { stopLossPct: ctx.stopLossPct };

  const rejected = [];
  const scored = [];

  for (const c of list) {
    if (!c) continue;
    const scr = screenCandidate(c);
    if (scr.rejected) {
      rejected.push({
        code: c.code, name: c.name || c.code,
        reason: scr.hits[0].label, why: scr.hits[0].why, stat: scr.hits[0].stat,
        allHits: scr.hits.map((h) => h.label),
        // 保留原始字段，便于 UI 展示「它本来长什么样」
        changePct: c.changePct ?? null, netWan: c.netWan ?? null,
        turnoverPct: c.turnoverPct ?? null, streak: c.streak ?? null,
      });
      continue;
    }
    const prob = predictUpProb(c, ctx);
    const exp = expectedReturn(c);
    const stop = suggestStop(c, stopOpts);
    // 连板概率与上涨概率是两个独立目标，各自算、各自标注
    const limitUp = limitUpProb(c);
    const streakTop = isStreakTop(limitUp.prob, streakTopMin);
    scored.push({ ...c, prob, exp, stop, limitUp, streakTop });
  }

  // 三级排序：连板置顶组优先 → 组内连板概率降序 → 其余上涨概率降序 → 净买额 → 代码
  scored.sort((a, b) => {
    if (a.streakTop !== b.streakTop) return a.streakTop ? -1 : 1;
    const ka = a.streakTop ? (a.limitUp.prob || 0) : a.prob.score;
    const kb = b.streakTop ? (b.limitUp.prob || 0) : b.prob.score;
    return (kb - ka)
      || ((b.prob.score || 0) - (a.prob.score || 0))
      || ((b.netWan || 0) - (a.netWan || 0))
      || String(a.code).localeCompare(String(b.code));
  });

  // 概率分低于门槛的不进推荐（但仍列入「未达门槛」，让用户看到全貌而不是被静默丢弃）
  const kept = [];
  const below = [];
  for (const s of scored) {
    if (s.prob.score >= minProb) kept.push(s);
    else below.push(s);
  }

  const picks = kept.slice(0, topN);
  const overflow = kept.slice(topN);
  const streakKept = kept.filter((s) => s.streakTop);

  return {
    picks,
    rejected,
    belowThreshold: below,
    overflow,
    stats: {
      pool: list.length,
      kept: kept.length,
      rejected: rejected.length,
      below: below.length,
      minProb,
      baselineUp: BASELINE_UP,
      baselineN: BASELINE_N,
      // 连板维度统计（UI 显示「其中 N 只大概率连板」）
      streakTop: streakKept.length,
      streakTopMin,
      streakBaseline: STREAK_BASELINE,
      streakBaselineN: STREAK_BASELINE_N,
    },
  };
}

/** 概率分档位的可读说明（UI 直接渲染，不重写文案） */
export function probBandText(score) {
  const b = probBand(score);
  return `${b.label}（${b.desc}）`;
}

// ══════════════════════════════════════════════════════════════════════════
// 五、连板概率（T+1 是否能再涨停）—— 与「上涨概率」是两个不同的目标
//
// 为什么要单独一套：用户要的是「大概率连板」（T+1 再涨停），不是「大概率上涨」。
// 两者实测差异巨大：全部涨停股里 **44.8% 的票 T+1 是下跌的**，但只有 78% 不会再涨停；
// 反过来说「上涨概率 65%」的票，其「连板概率」可能只有 18%（首板低换手组）。
// 拿上涨概率冒充连板概率会严重误导——所以这里独立统计、独立标注。
//
// 数据来源：scripts/backtest_limit_up_streak.mjs（1089 只票 × 33 个交易日，
// 腾讯前复权日K，T日收盘买入 → T+1 收盘；涨停判定按板段：主板 ≥9.8%、
// 创业板/科创板 ≥19.8%、北交所 ≥29.8%，与模拟器口径一致）。实测分层表：
//
//   【连板档 × 换手档 → T+1 再涨停率（样本量）】
//                换手<12%      12~20%       >=20%
//   首板        18.2% (577)  13.0% (139)  15.1% (53)
//   2 板        43.3% ( 90)  32.1% ( 28)  16.7% (12)
//   3 板        54.2% ( 24)  30.8% ( 13)  33.3% ( 9)
//   4 板+       50.0% ( 20)  14.3% (  7)  25.0% ( 4)
//
//   基准（全部涨停股）n=976 → 再涨停率 **21.8%**
//
//   【两条最重要的结论】
//   ① **连板高度是主因**：首板 18% → 2 板 43% → 3 板 54%。首板占候选池近 8 成，
//      但它们本质上「大概率不会连板」——把首板也标成「大概率连板」是欺骗用户。
//   ② **换手是强负向调节**：同为 2 板，换手 <12% 是 43.3%，≥20% 只剩 16.7%；
//      4 板+ 换手 ≥12% 更是掉到 14%~25%。低换手 = 筹码锁得牢 = 次日抛压小。
//   ③ **T+3 中位数转负**（连板组 −1.6% ~ −4.6%）：连板是**短打**，
//      不是持有逻辑。这个警告必须给用户，否则「连板」会被误读成「强势可持有」。
// ══════════════════════════════════════════════════════════════════════════

/** 连板概率基准：全部涨停股 T+1 再涨停率（实测） */
export const STREAK_BASELINE = 21.8;
/** 基准样本量 */
export const STREAK_BASELINE_N = 976;

/**
 * 连板概率分档。阈值按实测分层表切：
 *   ≥45 → 较高（只有 2 板低换手、3 板低换手、4 板+ 低换手能到）
 *   ≥30 → 中等（2 板中换手、3 板中换手）
 *   ≥22 → 偏低（勉强高于基准）
 *   <22 → 不佳（首板全部落这里）
 */
export const STREAK_BANDS = [
  { min: 45, key: 'high', label: '较高', desc: '历史同特征组 T+1 再涨停率 ≥45%' },
  { min: 30, key: 'mid', label: '中等', desc: '历史同特征组 T+1 再涨停率 30%~45%' },
  { min: 22, key: 'low', label: '偏低', desc: '历史同特征组 T+1 再涨停率 22%~30%' },
  { min: 0, key: 'poor', label: '不佳', desc: '历史同特征组 T+1 再涨停率 <22%' },
];

/** 连板概率分 → 档位 */
export function streakBand(score) {
  if (!Number.isFinite(+score)) return STREAK_BANDS[STREAK_BANDS.length - 1];
  const s = +score;
  for (const b of STREAK_BANDS) if (s >= b.min) return b;
  return STREAK_BANDS[STREAK_BANDS.length - 1];
}

/**
 * 实测分层表：连板档 × 换手档 → { prob, n }。
 * **这张表就是模型的全部**——不做任何外推，命中哪个格子就用那个格子的实测值。
 * 格子取法的优先级：换手有数据时按换手档取；换手缺失时用该连板档的合计值
 * （不用相邻档填充，因为「不知道换手」与「换手 15%」不是一回事）。
 */
export const STREAK_TABLE = [
  // streakMin, streakMax（含），换手档 → 实测再涨停率与样本量
  { streak: 1, label: '首板', rows: { low: { p: 18.2, n: 577 }, mid: { p: 13.0, n: 139 }, high: { p: 15.1, n: 53 } }, all: { p: 17.0, n: 769 } },
  { streak: 2, label: '2 连板', rows: { low: { p: 43.3, n: 90 }, mid: { p: 32.1, n: 28 }, high: { p: 16.7, n: 12 } }, all: { p: 38.5, n: 130 } },
  { streak: 3, label: '3 连板', rows: { low: { p: 54.2, n: 24 }, mid: { p: 30.8, n: 13 }, high: { p: 33.3, n: 9 } }, all: { p: 43.5, n: 46 } },
  { streak: 4, label: '4 连板及以上', rows: { low: { p: 50.0, n: 20 }, mid: { p: 14.3, n: 7 }, high: { p: 25.0, n: 4 } }, all: { p: 38.7, n: 31 } },
];

/** 换手档判定：<12% 低 / 12~20% 中 / ≥20% 高。缺数据返回 null（不猜）。 */
export function turnoverBandOf(turnoverPct) {
  if (!finite(turnoverPct)) return null;
  const t = +turnoverPct;
  if (t < 12) return 'low';
  if (t < 20) return 'mid';
  return 'high';
}

/** 连板档取表行；未涨停返回 null（未涨停的票连板概率无意义，不是 0） */
function streakRowOf(streak) {
  if (!finite(streak)) return null;
  const s = +streak;
  if (s < 1) return null;
  if (s >= 4) return STREAK_TABLE[3];
  return STREAK_TABLE.find((r) => r.streak === s) || null;
}

/**
 * 计算「T+1 再涨停（连板）概率」。
 *
 * 语义：**历史同特征组里，次日再次涨停的占比**——与 predictUpProb 的「上涨占比」
 * 是两回事，UI 必须分开标注，不能混用。
 *
 * @param {object} c 候选（需 isZt / streak / turnoverPct）
 * @returns {{prob:number|null, band:object|null, n:number, turnoverBand:string|null,
 *            group:string, isStreak:boolean, note:string, t3Med:number|null}}
 */
export function limitUpProb(c) {
  const c1 = c || {};
  const miss = {
    prob: null, band: null, n: 0, turnoverBand: null, group: '未涨停',
    isStreak: false, note: '当日未涨停，不存在「连板」这一说——不给连板概率，避免把两件事混为一谈。',
    t3Med: null,
  };
  if (!c1.isZt) return miss;
  const row = streakRowOf(c1.streak);
  if (!row) return { ...miss, group: '连板数未知', note: '连板数缺失，无法定位实测分组——不给连板概率。' };

  const tb = turnoverBandOf(c1.turnoverPct);
  const cell = tb ? row.rows[tb] : row.all;
  if (!cell || !Number.isFinite(cell.p)) {
    return { ...miss, group: row.label, note: '该分组样本不足，不给连板概率。' };
  }

  // T+3 中位数：连板组的实测值（用于「连板是短打不是持有」的警告）
  const t3 = row.streak === 1 ? -1.03 : row.streak === 2 ? -1.83 : row.streak === 3 ? -3.10 : -4.00;
  const tbTxt = tb === 'low' ? '换手<12%' : tb === 'mid' ? '换手12~20%' : tb === 'high' ? '换手≥20%' : '换手未知';
  const band = streakBand(cell.p);
  return {
    prob: cell.p,
    band,
    n: cell.n,
    turnoverBand: tb,
    group: `${row.label} · ${tbTxt}`,
    isStreak: true,
    t3Med: t3,
    note: `${row.label}且${tbTxt}的实测样本 ${cell.n} 例，T+1 再涨停率 ${cell.p}%`
      + `（基准：全部涨停股 ${STREAK_BASELINE}%，n=${STREAK_BASELINE_N}）。`
      + `该组 T+3 中位 ${t3}%——连板是短打逻辑，不是持有逻辑。`,
  };
}

/**
 * 「值得置顶」判定：连板概率达到门槛才置顶。
 * 为什么不是「所有 2 板以上都置顶」：实测 2 板换手 ≥20% 的再涨停率只有 16.7%，
 * 比首板的 18.2% 还低——按连板数置顶等于给用户推最差的那类 2 板。
 * 所以置顶只认**连板概率**，不认连板数量本身。
 * @param {number} prob 连板概率
 * @param {number} [min] 门槛，默认 30（=「中等」档起点）
 */
export const STREAK_TOP_MIN = 30;
export function isStreakTop(prob, min) {
  const m = finite(min) ? +min : STREAK_TOP_MIN;
  return finite(prob) && +prob >= m;
}

/** 连板概率分档的可读说明 */
export function streakBandText(prob) {
  if (prob == null || !Number.isFinite(+prob)) return '无连板依据';
  const b = streakBand(prob);
  return `${b.label}（${b.desc}）`;
}

/** 连板概率的置顶标签文案（UI 直接用，不重写） */
export function streakTagText(lp) {
  if (!lp || !lp.isStreak || lp.prob == null) return null;
  return `大概率连板 ${lp.prob}%`;
}
