// ── 公式版本注册表（唯一出处）──────────────────────────────────────────────────
//
// 为什么需要这个文件：
//   公式每次迭代（v4.5 → v5.0 → v5.2）改的都是**喂给 s_net 的原料口径**，不是加权公式本身。
//   七因子权重与 sigmoid/tanh 归一在所有版本里完全一致，差异只在「净买额取哪一份」。
//   如果每个版本各写一份 computeSentiment，就会变成三套并行的口径实现——改一处忘两处，
//   回归报告直接失真。故本文件**只描述原料口径**，因子计算一律仍走 src/sentiment.js
//   的 computeSentiment（同一个函数、同一份权重）。
//
// 三版的实际语义（按 git 历史与既有注释复原，不是新发明的口径）：
//
//   v4.5  净买 = 当日榜 + 区间累计榜混算的**全量聚合**（含新股）
//         · 历史事实：建库初期直接用 lhb 原始数组 reduce(净额)，既没滤区间榜、也没滤新股。
//         · 后果：区间累计值顶替当日值 → s_net 长期被抬到 tanh 饱和区，几乎失去分辨力
//           （实测 33 天里 13 天被顶到 100）。
//
//   v5.0  净买 = **当日榜**（已滤区间榜），但仍**含新股**
//         · 历史事实：修掉了区间榜混算（"511 亿事件"），这是 v5.0 唯一改动。
//         · 后果：单只新股的大额净买仍能把因子从「转弱」推到「接近满分」
//           （2026-09-30 实测：s_net 因子虚高 54.7 分、情绪分虚高 8.58 分，并越过了 65 分档位线）。
//
//   v5.2  净买 = 当日榜 **剔除新股/无涨跌幅限制标的**（当前基线）
//         · 即 src/lhb.js 的 splitNewStockNet 产出的 ex_new_yi。
//
//   v5.3  净买 = **与 v5.2 完全相同**（当日榜剔新股），但 s_net 的**归一方式**改为
//         **滚动分位映射**（|净买| 在过去 60 个交易日的百分位 → 因子值），
//         取代 tanh(x/5)*50+50。
//         · 动因：实测 241 天，k=5 下净买 p50=11.65 亿 → 因子 97.5、p75=20.09 亿 → 99.6，
//           即有**一半以上的交易日挤在 95 分以上**，241 天取整后只剩 64 个不同值。
//           tanh 的问题不是"饱和点选错"，而是**尺度固定**：净买中枢一旦漂移（口径调整、
//           市场规模变化），分辨率就整体失效。分位映射对本问题结构性免疫。
//         · ⚠ v5.3 是**候选版本，不是基线**。它是否更优必须由 version_regression 的数字说话：
//           本档案只有 33 天有次日收益，统计力极弱，故**不允许**仅凭"看起来更均匀"就切换基线。
//           切换基线须同时更新 config.formulaVersion + BASELINE_VERSION + 全部回归夹具。
//
// 版本号与档位阈值的关系：四版共用同一组阈值（24/65/80），差异全部体现在分子上——
// 这正是"同一段历史、多版并行重算"能做出有意义对比的前提。

import { computeSentiment, NET_NORMALIZER_TANH5, NET_NORMALIZER_PCTL } from './sentiment.js';
import { validateDay, sanitizeForFactors } from './dirty.js';
import {
  caliberFromDay, mergeDuplicateRecords, aggregateByCode, isNewStock,
} from './lhb.js';

// 当前基线版本（config.formulaVersion 必须与之一致，由守卫锁定）
export const BASELINE_VERSION = 'v5.2-pro';

// 权重键（带档位后缀，computeSentiment 的入／出键）→ 因子键（存档/报告/前端用）
// 与 src/config.js 的 factorKeyMap 同义，但后者是「权重键 → 因子键」的配置映射，
// 这里再声明一次是为了让本模块**不依赖 config**（纯逻辑模块，便于单测与前端复用）。
// 两份必须一致，由 test/formula_version.test.mjs 守卫锁定。
export const WEIGHT_TO_FACTOR = {
  s_net20: 's_net', s_pos10: 's_pos', s_brd20: 's_brd', s_hot10: 's_hot',
  s_zdt15: 's_zdt', s_zbl10: 's_zbl', s_amt15: 's_amt',
};

const r2 = (v) => Math.round(v * 100) / 100;

// ────────────────────────── 各版本的「净买原料」提取器 ──────────────────────────
//
// 契约：入参是**已落盘的 day 对象**，返回 { netBuy, newStockNet, label, evidence }。
//   netBuy        —— 喂给 computeSentiment 的净买（亿），**含**新股（剔除由 newStockNet 承担）
//   newStockNet   —— 要从此 netBuy 里扣掉的金额（亿）；v4.5/v5.0 传 0 = 不扣
//   label         —— 人读口径名，进报告
//   evidence      —— 该日可供人工复核的中间量（不参与计算，只作证据链）
//
// 三版共用 caliberFromDay（当日榜/全量双口径的唯一现算实现），只是选取的字段不同。
// 这一点很关键：如果 v4.5 自己再写一遍"不过滤 is_range"，就会出现第二套口径判断逻辑。

// v4.5：全量聚合（含区间累计榜、含新股）
export function netBuyV45(day) {
  const c = caliberFromDay(day);
  const netBuy = c.all_net_yi;
  return {
    netBuy,
    newStockNet: 0, // 含新股
    label: 'v4.5 · 全量净买（含区间累计榜 + 含新股）',
    evidence: {
      allStocks: c.all_stocks,
      dailyStocks: c.daily_stocks,
      rangeRecords: c.range_records,
    },
  };
}

// v5.0：当日榜（已滤区间榜），但含新股
export function netBuyV50(day) {
  const c = caliberFromDay(day);
  const netBuy = c.daily_net_yi;
  return {
    netBuy,
    newStockNet: 0, // 含新股
    label: 'v5.0 · 当日榜净买（已滤区间累计榜，含新股）',
    evidence: {
      allStocks: c.all_stocks,
      dailyStocks: c.daily_stocks,
      rangeRecords: c.range_records,
    },
  };
}

// v5.2：当日榜剔除新股（当前基线）
export function netBuyV52(day) {
  const c = caliberFromDay(day);
  const netBuy = c.daily_net_yi;
  const newStockNet = c.daily_new_net_yi ?? 0;
  return {
    netBuy,
    newStockNet,
    label: 'v5.2 · 当日榜净买（已滤区间累计榜，剔除新股/无涨跌幅限制）',
    evidence: {
      allStocks: c.all_stocks,
      dailyStocks: c.daily_stocks,
      rangeRecords: c.range_records,
      newCount: c.daily_new_count,
      newNet: newStockNet,
      newRatio: c.daily_new_ratio,
    },
  };
}

// ────────────────────────── 版本表（唯一注册点）──────────────────────────────────
//
// 加新版本 = 在这里加一行 + 在 test/formula_version.test.mjs 里加一条口径断言。
// 顺序即报告里的展示顺序（由旧到新）。
//
// 版本条目的两个可选字段：
//   extractNetBuy —— 净买**原料**提取器（v4.5/v5.0/v5.2 的差异所在）
//   normalizer    —— s_net **归一器**（v5.3 的差异所在）；缺省 = 历史基线 tanh5
// 两者正交：一个版本可以只改原料、只改归一，或都改。这样"版本差异"永远是
// 「原料 × 归一」两个维度的组合，而不是 n 份并行实现。
export const FORMULA_VERSIONS = [
  {
    key: 'v4.5',
    name: 'v4.5',
    desc: '七个因子加权，净买取全量聚合（未滤区间累计榜、未剔新股）',
    extractNetBuy: netBuyV45,
  },
  {
    key: 'v5.0',
    name: 'v5.0',
    desc: '七个因子加权，净买取当日榜（滤掉区间累计榜），仍含新股',
    extractNetBuy: netBuyV50,
  },
  {
    key: 'v5.2-pro',
    name: 'v5.2-pro',
    desc: '七个因子加权，净买取当日榜并剔除新股/无涨跌幅限制标的（当前基线）',
    extractNetBuy: netBuyV52,
    baseline: true,
  },
  {
    key: 'v5.3-pro',
    name: 'v5.3-pro',
    desc: '七个因子加权，净买口径同 v5.2，但 s_net 归一改为滚动分位映射（缓解 tanh 饱和）',
    extractNetBuy: netBuyV52, // ← 净买原料与基线**完全一致**，差异只在归一器
    normalizer: NET_NORMALIZER_PCTL,
    // 候选版本的自我声明：进报告时必须带这句（防止被当成"升级后的基线"）
    candidate: true,
  },
];

// 归一窗口长度（交易日）。60 取的是一个折中：
//   · 太短（如 20）→ 分位被近期行情绑架，"横盘市的正常净买"会被算成高分；
//   · 太长（如 250）→ 跨年了，一年前的量级与当下不可比（市场规模/口径都会漂）；
//   60 个交易日≈一个季度，既能覆盖一段完整情绪周期，又能跟上量级漂移。
export const NET_HIST_WINDOW = 60;
// 分位窗口**最少**要有多少天历史才算得出来（不足则返回 null → 标 missing）。
// 取 20：低于这个数分位估计的方差太大，不如老实说"算不出"。
export const NET_HIST_MIN = 20;

export function versionKeys() {
  return FORMULA_VERSIONS.map((v) => v.key);
}

export function versionOf(key) {
  return FORMULA_VERSIONS.find((v) => v.key === key) || null;
}

// ────────────────────────── 单日单版本重算 ──────────────────────────
//
// 口径纪律：本函数**只负责凑原料**，因子与分数一律交给 computeSentiment。
//   其余六个因子（s_pos / s_brd / s_hot / s_zdt / s_zbl / s_amt）在三个版本里
//   **完全相同**——它们本来就没被历次迭代改动过。差异只在 s_net。
//
// amountMA20 的算法必须与 pipeline.recalcAll 逐字一致（取当日之前最近 20 个有值交易日的均值，
// 且不足 10 个值时置 null → 走代理）。这是唯一一处跨文件重复，用守卫锁定一致性。
export function recomputeDay(day, versionKey, ctx = {}) {
  const v = versionOf(versionKey);
  if (!v) throw new Error('未知公式版本：' + versionKey);
  const s = day?.summary || {};
  const { netBuy: exNetBuy, newStockNet, label, evidence } = v.extractNetBuy(day);
  // 判脏摘除（2026-10-05 补齐，与生产 recalcAll 对齐）：
  //   recalcAll 喂因子前先 validateDay + sanitizeForFactors——被判脏的字段（原始值保留
  //   在档）不再进入 computeSentiment，因子走 missing/代理通道。本函数此前直接读
  //   s.* 原始值，于是在「industry[].change_pct 被判脏」的天上，v5.2 基线重算与档案
  //   存值分叉（实测 2026-03-03：s_brd 主值 10 vs 生产代理 10.6，总差 0.2 分）。
  //   该缺陷在样本只有 33 个 full 档天时不可见——指数收益回填把比对样本扩到全档后
  //   被守卫抓出。基线复现（version_regression 的 v5.2 列、formula_version.test 的
  //   档案一致性断言）都必须是生产同款原料，否则"复现"是假的。
  //   版本间对比不受影响：四版共用同一份 cleaned 入参（差异只在 s_net 提取与归一）。
  const { cleaned, dropped } = sanitizeForFactors(day, validateDay(day));
  const netBuy = dropped.includes('netBuy') ? null : exNetBuy;
  // 归一器：版本未声明就走历史基线（tanh5），保证 v4.5/v5.0/v5.2 行为逐位不变。
  // ctx.netNormalizer 可覆盖（单测/前端预览用），但**常规路径一律取版本声明**——
  // 否则同一版本在不同调用点会算出不同因子，版本对比失去意义。
  const normalizer = ctx.netNormalizer || v.normalizer || NET_NORMALIZER_TANH5;
  const sent = computeSentiment({
    netBuy,
    newStockNet,
    newStockRatio: evidence?.newRatio ?? null,
    upCount: cleaned.upCount ?? null,
    downCount: cleaned.downCount ?? null,
    posRatio: cleaned.posRatio ?? null,
    industryUp: cleaned.industryUp ?? null,
    industryTotal: cleaned.industryTotal ?? null,
    limitUp: cleaned.limitUp ?? null,
    limitDown: cleaned.limitDown ?? null,
    brokenCount: cleaned.brokenCount ?? null,
    amount: cleaned.amount ?? null,
    amountMA20: ctx.amountMA20 ?? null,
    // 分位映射需要的历史净买序列（不含当日）。不传 → 归一器自己判「算不出」并返回 null，
    // 由 computeSentiment 的 factor() 走 missing/代理路径（不会静默填 50 冒充"算过"）。
    netNormalizer: normalizer,
    netNormalizerCtx: { netHistory: ctx.netHistory || [], minHist: NET_HIST_MIN },
  }, ctx.weights);
  // 硬失败而非静默 NaN：computeSentiment 按**带档位后缀的权重键**取 w[k]（s_net20 / s_pos10 …），
  // 若调用方传了无后缀的因子键（s_net / s_pos …），w[k] 全是 undefined → score = NaN，
  // 且 NaN 会一路静默传播（相关性、均分、准确率集体变 NaN，看起来像"算出来了但没数据"）。
  // 实测踩过这个坑，故在此处直接抛错，把问题挡在第一现场。
  if (!Number.isFinite(sent.score)) {
    const wk = Object.keys(ctx.weights || {});
    throw new Error(`重算 ${versionKey} ${day?.trade_date} 得到非有限分数（${sent.score}）`
      + `——检查传入的权重键是否为带档位后缀形式（当前：${wk.join(',') || '未传'}）`);
  }
  // 因子键归一：computeSentiment 返回的是**带档位后缀**的键（s_net20 / s_pos10 …，因为它按权重键聚合），
  // 而存档、报告、前端一律用无后缀的因子键（s_net / s_pos …）。这两个形状混在同一份数据里，
  // 下游任何 `row.factors.s_net` 都会静默取到 undefined。故在此**唯一出口**做一次归一，
  // 让本模块的输出形状与存档一致（下游不必知道 computeSentiment 的内部键名）。
  const fac = {};
  for (const [wk, pk] of Object.entries(WEIGHT_TO_FACTOR)) {
    if (sent.factors[wk] != null) fac[pk] = sent.factors[wk];
  }
  return {
    version: versionKey,
    score: sent.score,
    factors: fac,
    factorsRaw: sent.factors, // 原样保留一份，供与 pipeline 的装配结果逐字段比对
    imputedRatio: sent.imputedRatio,
    missing: sent.missing,
    netBuy: netBuy != null ? r2(netBuy) : null,
    newStockNet: r2(newStockNet || 0),
    label,
    evidence,
    // 归一层留痕（哪个归一器、历史窗口多长）—— v5.2 与 v5.3 净买相同、只有归一不同，
    // 不带上这个字段，两份分数的差异在报告里会变成无解释的黑箱。
    netCaliber: sent.netCaliber,
  };
}

// ────────────────────────── 可算性分级（决定回归样本量）──────────────────────────
//
// 为什么必须分级而不是"能算就算、不能算就丢"：
//   三个版本的差异**只在 s_net 一项**，其余六因子三版完全相同。因此要看出版本差异，
//   样本天必须满足两个条件：
//     ① 有**足够的原始量**让 s_net 与其余因子都在「真值区」——否则一堆因子落在代理值 50，
//        版本差异被代理稀释掉，相关性表看起来"三版几乎一样"，那是数据缺失造成的假象；
//     ② 有**次日大盘涨跌幅**（indexes 的下一交易日）——否则无法计算预测力。
//
// 实测当前档案的真实分布（241 天）：
//   · lhb_daily_net / lhb_all_net / lhb_daily_ex_new_net / lhb_new_net / lhb_range_count
//     —— 241/241 全覆盖（这三版共用的原料全都有）
//   · ind_up 33/241、amount_yi 33/241、indexes 33/241 —— 只有最近 33 天（2026-08-14 起）
//   · up_count/down_count 仅 3/241 —— s_pos 的「真原料」极稀缺，其余天走 posRatio 代理
//
// 因此定义三级：
//   full      —— 有 indexes 且 ind_up/amount_yi 齐全（33 天）：七因子里 5 个在真值区，
//                且能算次日收益 → **回归主样本**
//   partial   —— 有龙虎榜原料但缺行业/量能（可算 s_net 三版差异，但无次日收益）
//               → 只作"版本差异幅度"的旁证，不进相关性统计
//   none      —— 连龙虎榜原料都没有 → 完全排除
export const COMPUTE_TIERS = {
  full: 'full',
  partial: 'partial',
  none: 'none',
};

export function classifyDay(d) {
  const s = d?.summary || {};
  const c = caliberFromDay(d);
  const hasLhb = c.total_records > 0
    || s.lhb_daily_net != null || s.lhb_all_net != null;
  if (!hasLhb) return COMPUTE_TIERS.none;
  const hasIndustry = s.ind_up != null && s.ind_count != null;
  const hasAmount = s.amount_yi != null;
  const hasNextRet = d?.indexes && d.indexes['上证指数'] != null;
  // 注意：up_count 缺失不算「不可算」——computeSentiment 的 s_pos 会回退到 posRatio 代理，
  // 这是既有设计（见 src/sentiment.js 的 factor(..., fallback)）。但它会削弱区分度，
  // 故额外记录 hasBreadth 供报告披露「本样本有 N 天 s_pos 走代理」。
  const hasBreadth = s.up_count != null && s.down_count != null;
  return (hasIndustry && hasAmount && hasNextRet) ? COMPUTE_TIERS.full : COMPUTE_TIERS.partial;
}

export function computableDays(days) {
  const list = Array.isArray(days) ? days : [];
  const full = [], partial = [], none = [];
  const meta = [];
  for (const d of list) {
    const tier = classifyDay(d);
    const s = d?.summary || {};
    meta.push({
      trade_date: d?.trade_date,
      tier,
      hasBreadth: s.up_count != null && s.down_count != null,
      hasIndustry: s.ind_up != null,
      hasAmount: s.amount_yi != null,
      hasNextRet: !!(d?.indexes && d.indexes['上证指数'] != null),
    });
    if (tier === COMPUTE_TIERS.full) full.push(d);
    else if (tier === COMPUTE_TIERS.partial) partial.push(d);
    else none.push(d);
  }
  return { ok: full, partial, none, meta };
}

// 与 computableDays 同口径，但把「有 indexes 的连续段」原样保留索引 —— 供次日收益对齐用。
// 回归必须按**真实交易日相邻**取次日，不能按数组相邻：档案里 2026-09-24 的下一行是 09-28
// （09-25 中秋休市），按数组相邻会把 4 天累计涨跌当成次日涨跌。
export function nextRetOf(day, allDays) {
  if (!Array.isArray(allDays) || !day?.indexes) return null;
  const i = allDays.findIndex((x) => x.trade_date === day.trade_date);
  if (i < 0) return null;
  for (let j = i + 1; j < allDays.length; j++) {
    const nx = allDays[j];
    if (nx?.indexes && nx.indexes['上证指数'] != null) {
      const gap = tradingDayGap(day.trade_date, nx.trade_date);
      return { date: nx.trade_date, ret: nx.indexes['上证指数'], gap };
    }
  }
  return null;
}

// 两个日期之间的「自然日跨度」——用于披露隔了几天的跳空（长假后首日的次日收益含跳空）。
function tradingDayGap(a, b) {
  const ta = Date.parse(a + 'T00:00:00Z');
  const tb = Date.parse(b + 'T00:00:00Z');
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((tb - ta) / 86400000);
}

// ────────────────────────── 批量重算（含归一历史的构造）──────────────────────────
//
// ⚠ 本函数是**唯一**为分位归一器构造历史窗口的地方。为什么必须集中在这里：
//   分位映射要求历史序列与当日值**同口径**（都用 ex_new_yi）。如果调用方各自切片，
//   很容易一处传 lhb_all_net、一处传 ex_new_yi，算出来的分位看似正常却毫无意义，
//   而且不会报错。故：历史一律用**基线版本（v5.2 口径）的 netBuy**重建，
//   与 v5.3 的 netBuy 天然同口径（v5.3 的 extractNetBuy 就是 netBuyV52）。
//
// 切片语义：某日的历史 = 该日**之前**（不含当日）最近 NET_HIST_WINDOW 个有效净买。
//   刻意不含当日——若含当日，分位会永远把当日算在"自己在自己里的百分位"，
//   在满值 50 分位附近产生系统偏差；且未来若改窗口长度，历史日的分数会整体变化，
//   破坏"同一段历史、同一版本、分数恒定"的可复现性。
export function computeAllVersions(days, versions = versionKeys(), weights) {
  const out = {};
  for (const k of versions) out[k] = [];
  if (!Array.isArray(days) || !days.length) return out;
  const amts = days.map((d) => (d?.summary && d.summary.amount_yi != null) ? d.summary.amount_yi : null);

  // 先用基线口径抽一遍逐日净买（= ex_new_yi），作为所有分位归一器的共同历史。
  // 用基线提取器而非遍历各版本：历史只有一份，不应随"当前在算哪个版本"而变。
  const baseNet = days.map((d) => {
    const r = netBuyV52(d);
    if (r.netBuy == null) return null;
    const exNew = r.netBuy - (Number.isFinite(+r.newStockNet) ? +r.newStockNet : 0);
    return Number.isFinite(exNew) ? exNew : null;
  });

  days.forEach((d, i) => {
    const hist = [];
    for (let j = i - 1; j >= 0 && hist.length < NET_HIST_WINDOW; j--) {
      if (baseNet[j] != null) hist.unshift(baseNet[j]);
    }
    const amtHist = [];
    for (let j = i - 1; j >= 0 && amtHist.length < 20; j--) if (amts[j] != null) amtHist.unshift(amts[j]);
    const amountMA20 = amtHist.length >= 10 ? amtHist.reduce((a, b) => a + b, 0) / amtHist.length : null;
    for (const k of versions) {
      const r = recomputeDay(d, k, { amountMA20, weights, netHistory: hist });
      out[k].push({ trade_date: d.trade_date, ...r });
    }
  });
  return out;
}

// 供守卫：确认所有版本的因子键集合与顺序完全一致（只应有数值差异）
export function factorKeysOf(result) {
  return Object.keys(result?.factors || {});
}

// 复用导出，避免下游为取一个合并函数而再次 import lhb.js
export { mergeDuplicateRecords, aggregateByCode, isNewStock };
