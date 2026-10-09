// 七因子情绪模型 v5（透明、可审计、缺失走代理而非静默填50）
import { clamp } from './util.js';

// ── s_net 归一器（可插拔接缝）──────────────────────────────────────────────
//
// 为什么要把「归一方式」抽成参数：
//   本文件原本把 tanh(x/5)*50+50 硬编码进 s_net（见下方 f_net）。实测 241 个交易日，
//   该尺度下净买 |x| 的 p50 = 11.65 亿 → 因子 97.5，p75 = 20.09 亿 → 因子 99.6，
//   即**一半以上的交易日挤在 95 分以上**，241 天取整后只剩 64 个不同值。
//   成因是 A 股龙虎榜净买额的量级分布与 k=5 不匹配（不是回填引入的，完整档 33 天
//   里同样有 10 天 ≥99.9）。修法有两条：放宽 k（阈值语义整体漂移）或改分位映射
//   （自适应量级、天然均匀）。两条都是**公式版本差异**，必须能并行对比，
//   否则「哪一版更好」又会像 v4.5→v5.2 那样靠"看到某天数字不对劲"来判断。
//
// 契约：
//   normalizer(netBuyYi, ctx) → number | null
//     netBuyYi —— 已剔除新股后的净买额（亿），可能为 null/NaN
//     ctx      —— { netHistory: number[] }，该日**之前**的历史净买序列（不含当日），
//                 由调用方按同一口径、同一次序切片提供；分位映射需要它，tanh 不需要。
//   返回夹在 [0,100] 的因子值；返回 null 表示"本日算不出"→ 走既有的 missing/代理路径。
//
// ⚠ 向后兼容（硬约束）：不传 normalizer 时行为必须与历史**逐位一致**（就是原来的
//   tanh(x/5)*50+50）。v4.5/v5.0/v5.2 三版都不传 → 三版结果不受本次改动影响，
//   既有回归基线（data/version-regression.json）与全部单测无需改数。

/** 历史基线归一器：tanh(x/5)*50+50。k=5 是历史常量，**不得修改**——改了就是新版本。 */
export const NET_NORMALIZER_TANH5 = (x) => (x != null && !Number.isNaN(x) ? Math.tanh(x / 5) * 50 + 50 : null);

/**
 * 分位映射归一器（v5.3-pro 用）：把 |净买| 映射到它在历史窗口里的**百分位**。
 *
 * 为什么不直接放宽 k：
 *   tanh(x/k) 只是把饱和点右移，量级分布一变（如龙虎榜口径调整、市场整体放大）
 *   就再次失配，是"换一个坑"。分位映射对本问题**结构性免疫**：无论净买中枢是 5 亿
 *   还是 50 亿，中位数永远落在 50 分位、p75 永远在 75 分位附近——分辨率不随量级漂移。
 *
 * 符号处理：分位只用**绝对值**排序（衡量"强度"），方向由 sign 决定——净买为负 →
 *   50 - (pct-50) 的镜像。这样"流出 20 亿"与"流入 20 亿"的强度对称，而方向相反。
 *   若不做镜像而对含符号的原始值取分位，则"历史全负的一天"会被算成高分（因为它比
 *   更负的那些强），那是荒谬的。
 *
 * winsorize 理由：历史不足 minHist 天时，分位估计噪声大，返回 null 让调用方标 missing
 *   （而不是硬算一个不可信的百分位）。实测档案前 208 天缺六因子、后 33 天才齐全，
 *   分位窗口取 60 个交易日：既够统计意义，又能让 v5.3 在 33 天样本上真正算得出来
 *   （前 27 天用不足窗口的历史，仍可算，只是标记 histUsed 偏小）。
 */
export const NET_NORMALIZER_PCTL = (x, ctx = {}) => {
  const hist = Array.isArray(ctx.netHistory) ? ctx.netHistory.filter((v) => v != null && !Number.isNaN(v)) : [];
  if (x == null || Number.isNaN(x)) return null;
  if (hist.length < (ctx.minHist ?? 20)) return null; // 历史太少 → 不可信，交调用方标 missing
  const abs = Math.abs(x);
  const below = hist.filter((v) => Math.abs(v) < abs).length;
  const equal = hist.filter((v) => Math.abs(v) === abs).length;
  // 中位排名法：等于本值的样本算半票，避免并列值把分位推向极端
  const pct = ((below + equal / 2) / hist.length) * 100;
  // 分位 → 因子：50 分位 = 中性 50 分；按 ±(pct-50) 线性展开，再压到 [1,99]
  const v = x >= 0 ? 50 + (pct - 50) : 50 - (pct - 50);
  return clamp(v, 1, 99);
};

/** 单个因子：能算则算；算不出尝试 proxy；再不行中性50但标记 */
function factor(value, proxyFn) {
  if (value != null && !Number.isNaN(value)) return { v: clamp(value), missing: false };
  if (proxyFn) {
    const p = proxyFn();
    if (p != null && !Number.isNaN(p)) return { v: clamp(p), missing: false, proxied: true };
  }
  return { v: 50, missing: true };
}

export function computeSentiment(raw = {}, weights) {
  const w = weights || {
    s_net20: 0.20, s_pos10: 0.10, s_brd20: 0.20, s_hot10: 0.10,
    s_zdt15: 0.15, s_zbl10: 0.10, s_amt15: 0.15,
  };

  const {
    netBuy, upCount, downCount, industryUp, industryTotal,
    limitUp, limitDown, brokenCount, amount, amountMA20, posRatio,
    // 新股/无涨跌幅限制标的的净买（亿）——由 src/lhb.js 的 splitNewStockNet 唯一产出。
    // 传入即自动从 s_net 里剔除；不传则视为 0（行为与旧版完全一致，历史种子天不受影响）。
    newStockNet = 0, newStockRatio = null,
    // s_net 归一器 + 其上下文。**不传即走历史基线 tanh(x/5)**，逐位兼容。
    netNormalizer = NET_NORMALIZER_TANH5,
    netNormalizerCtx = null,
  } = raw;

  const upRatio = (upCount != null && downCount != null && upCount + downCount > 0)
    ? upCount / (upCount + downCount) : null;
  const indRatio = (industryUp != null && industryTotal)
    ? industryUp / industryTotal : null;
  const ldDen = (limitUp != null && limitDown != null) ? limitUp + limitDown : 0;

  // s_net20: 龙虎榜净额（亿），走归一器（默认 tanh(x/5)*50+50，历史基线）
  //
  // ⚠ 唯一口径纪律：**必须用剔除新股后的净买**。
  //   新股（上市首 5 日无涨跌幅限制）首日换手极高、筹码未沉淀，其大额净买衡量的是
  //   「打新资金出货由谁承接」，不是二级市场存量资金的进攻意愿；且 tanh(x/5) 在 5 亿量级
  //   已近饱和，一笔新股就能把因子从「转弱」推到「接近满分」。
  //   实测 2026-09-30：含新股 7.74 亿 → s_net 95.7；剔新股 2.70 亿 → s_net 74.6（虚高 21.1，
  //   情绪分虚高 4.20 分，且把结论从「满仓」推过了 65 分档位线）。
  //   全档统计：33 天里 10 天受影响，累计虚增 15.12 分。
  //
  // ⚠ 归一层纪律：本行**只负责把净买交给归一器**，换算公式一律在 sentiment.js 顶部的
  //   NET_NORMALIZER_* 里。归一方式属「公式版本差异」，由 src/formula_versions.js 注册，
  //   不得在此处按版本分支（那会让"版本差异"散落成两套实现）。
  const netExNew = netBuy != null ? netBuy - (Number.isFinite(+newStockNet) ? +newStockNet : 0) : null;
  // 未剔除新股的对照因子（仅用于报告披露"修正了多少分"）。
  // ⚠ 必须在这里算、不能在 UI 里算：app.js 曾自行写了一遍 Math.tanh(nb/5)*50+50，
  //   一旦归一方式换成 v5.3 的分位映射，那处副本就会与引擎真实分数不符**且不报错**。
  //   现在把两套分数一并产出，前端只读——口径唯一出处纪律。
  const netFactorRaw = netBuy != null ? netNormalizer(netBuy, netNormalizerCtx || {}) : null;
  const f_net = factor(
    netExNew != null ? netNormalizer(netExNew, netNormalizerCtx || {}) : null
  );
  // s_pos10: 涨跌家数（缺则用龙虎榜正负占比 posRatio 代理）
  const f_pos = factor(
    upRatio != null ? upRatio * 100 : null,
    () => (posRatio != null ? posRatio * 100 : null)
  );
  // s_brd20: 行业涨比（缺则用品宽代理）
  const f_brd = factor(
    indRatio != null ? indRatio * 100 : null,
    () => (upRatio != null ? upRatio * 100 : null)
  );
  // s_hot10: 涨停强度
  const f_hot = factor(
    ldDen > 0 ? (limitUp / ldDen) * 100 : null,
    () => (upRatio != null ? upRatio * 100 : null)
  );
  // s_zdt15: 涨跌停对比
  const f_zdt = factor(
    ldDen > 0 ? ((limitUp - limitDown) / ldDen) * 50 + 50 : null
  );
  // s_zbl10: 封板质量 = 涨停/(涨停+炸板)
  const zblDen = (limitUp != null && brokenCount != null) ? limitUp + brokenCount : 0;
  const f_zbl = factor(
    zblDen > 0 ? (limitUp / zblDen) * 100 : null,
    () => (ldDen > 0 ? (limitUp / ldDen) * 100 : null)
  );
  // s_amt15: 量能 vs 20日均（tanh 平滑：平量50，1.2倍≈67，1.5倍≈86，2倍≈97 不硬封顶；缩量对称压低）
  const f_amt = factor(
    (amount != null && amountMA20) ? Math.tanh((amount / amountMA20 - 1) * 1.8) * 50 + 50 : null
  );

  const factors = { s_net20: f_net, s_pos10: f_pos, s_brd20: f_brd, s_hot10: f_hot, s_zdt15: f_zdt, s_zbl10: f_zbl, s_amt15: f_amt };
  let score = 0, missingCount = 0;
  for (const [k, f] of Object.entries(factors)) {
    score += w[k] * f.v;
    if (f.missing) missingCount++;
  }
  const missing = Object.keys(factors).filter((k) => factors[k].missing);
  return {
    score: Math.round(score * 10) / 10,
    factors: Object.fromEntries(Object.entries(factors).map(([k, f]) => [k, Math.round(f.v * 10) / 10])),
    missing,
    imputedRatio: Math.round((missingCount / 7) * 100) / 100,
    // 新股扰动元信息：供报告逐日核对「s_net 是否被修正过、修正了多少」
    //   netRaw         —— 含新股的原始净买（未修正口径，仅留痕）
    //   netExNew       —— 实际喂给 s_net 的净买
    //   newStockNet    —— 被剔除的新股净买
    //   newStockRatio  —— 新股占当日榜净买比例（分母 ≤0 时为 null）
    //   adjusted       —— 本日 s_net 是否真的被修正（有新股净买且非 0）
    //   disturbed      —— 是否越过 25% 扰动线（报告须显式标注）
    newStock: {
      netRaw: netBuy != null ? Math.round(netBuy * 100) / 100 : null,
      netExNew: netExNew != null ? Math.round(netExNew * 100) / 100 : null,
      newStockNet: Math.round((Number.isFinite(+newStockNet) ? +newStockNet : 0) * 100) / 100,
      newStockRatio: newStockRatio != null ? Math.round(newStockRatio * 100) / 100 : null,
      adjusted: netBuy != null && Number.isFinite(+newStockNet) && +newStockNet !== 0,
      disturbed: newStockRatio != null && newStockRatio > 0.25,
      // 修正前后的 s_net 因子分（引擎算、UI 只读）。
      //   factorRaw —— 若不剔新股会得到的因子分（对照，非实际使用值）
      //   factorUsed —— 实际采用的因子分（＝factors.s_net）
      // 两者都取到 1 位小数，与 factors.s_net 的取整口径一致，避免报告里出现
      // "83.2 → 74.6" 与"83.20 → 74.65"这类假精度差。
      factorRaw: netFactorRaw != null ? Math.round(clamp(netFactorRaw) * 10) / 10 : null,
      factorUsed: netExNew != null ? Math.round(clamp(netNormalizer(netExNew, netNormalizerCtx || {})) * 10) / 10 : null,
    },
    // 归一层留痕：本日 s_net 用的是哪套换算、历史窗口多长。
    //   为什么必须留在返回值里：v5.2 与 v5.3 的**净买完全相同**，只有归一方式不同——
    //   若不留痕，两份分数放在一起时无法解释差异从何而来（会被误读成"哪个算错了"）。
    netCaliber: {
      // 按函数引用反查名字，避免调用方自己声明字符串（会漂移）
      normalizer: netNormalizer === NET_NORMALIZER_PCTL ? 'percentile'
        : netNormalizer === NET_NORMALIZER_TANH5 ? 'tanh5' : 'custom',
      histLen: netNormalizerCtx && Array.isArray(netNormalizerCtx.netHistory)
        ? netNormalizerCtx.netHistory.length : null,
    },
  };
}
