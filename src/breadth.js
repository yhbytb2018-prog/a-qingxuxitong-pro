// 多维市场宽度（#3）——口径唯一出处
//
// ── 为什么需要单独一份 ──────────────────────────────────────────────────────
// 现有的「市场宽度」只有 `summary.up_count / down_count`（全市场涨跌家数），而且
// 实测 **241 天里只有 3 天有**（2026-09-28/29/30，源于 fetchBreadth 是后加的源）。
// 结果就是：情绪模型的 s_pos 因子长期走 posRatio（龙虎榜正负比）代理——用一个
// **偏样本**（只有上榜的票）去近似全市场，页面却从不提及这件事（见 src/health.js 头注）。
//
// 本模块补齐四个**不依赖龙虎榜**的真实宽度维度：
//   1. 站上 20 日线占比 —— 趋势参与度。比"今天涨了几家"稳，因为它衡量的是
//      "有多少票处在多头结构里"，不会因为一天的反抽就翻脸。
//   2. 创一年新高 / 新低家数 —— 两个**互相独立**的极端。新高多是进攻扩散，
//      新低多是流动性/基本面出清；两者同时高企 = 极度分化（结构市特征）。
//   3. 破净率（PB < 1）—— 估值底部的宽度。与价格宽度正交：破净率高说明
//      "便宜"是普遍的，但这不构成买入理由（可能是价值陷阱），故只作**描述**不作信号。
//   4. 全市场涨跌家数 —— 若当日已有（fetchBreadth 抓到的）则沿用，否则**由 K 线自算**，
//      把可用率从 3/241 拉到"凡是扫过的日子都有"。
//
// ── 数据来源与口径边界（严格诚实）────────────────────────────────────────────
//   行情：腾讯前复权日K `proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get`
//         （与 scripts/backtest_limit_up_streak.mjs 同源；实测可用且返回 qfqday 前复权）。
//         **必须前复权**：不复权时除权日会出现 −30% 的假暴跌，会把"站上 20 日线"
//         和"创新低"同时污染（一个假暴跌既会打掉均线，又会伪造新低）。
//   估值：PB（市净率）来自东财列表接口 f23。**该接口在本沙箱不可用**
//         （push2.eastmoney.com fetch failed，与项目既有记录一致），故破净率在
//         沙箱内**永远算不出** → 返回 null，页面显示「未计算」，绝不填 0。
//         这一点必须显式：破净率 0% 是"全市场没有一家破净"（极强信号），
//         与"没抓到"（未知）含义完全相反。
//
// ── 与本文件的纪律 ──────────────────────────────────────────────────────────
//   · 纯函数：不读盘不写盘、不发请求。抓取在 scripts/fetch_breadth.mjs。
//   · 缺失显式化：sample 不足 → reliable=false 且比例字段为 null，不硬算。
//   · ★ null ≠ 0：见下方 num()。这是本项目反复踩的坑（alerts.js / pain.js /
//     seats_daily.js 都记录过），`Number.isFinite(+null)` 为 true 且 `+null === 0`。
//   · 分母纪律：所有"占比"的分母是**当次扫描到的有效样本数**，不是全市场总数
//     （全市场总数取决于清单来源，而清单本身可能缺票）。同时把 scanned/requested
//     一并返回，让读者能判断"这个占比是在多大样本上算的"。

// ── 阈值常量（唯一出处；UI 与脚本一律引用这里，不得各写一份）──────────────
export const BREADTH_THRESHOLDS = {
  /** 站上均线的判定：收盘 > MA(N)。N=20 是趋势参与度的通用短中周期。 */
  MA_WINDOW: 20,
  /** 创新高的回看窗口（交易日）。A 股一年约 243 个交易日，取 250 更宽松也更省心。 */
  NEW_HIGH_LOOKBACK: 250,
  NEW_LOW_LOOKBACK: 250,
  /** 破净阈值：PB < 1。 */
  BROKEN_PB: 1,
  /** 可信样本下限：少于这么多只有效样本时，比例返回 null（宁可说"不知道"）。 */
  MIN_SAMPLE: 100,
  /** 站上均线占比的分级中性带（0.4~0.6 视为中性）。 */
  MA_BULL: 0.6,
  MA_BEAR: 0.4,
};

/** 单只票参与宽度计算所需的最小 K 线根数（要能算 MA20 且至少有一天可判断新高）。 */
export const MIN_BARS = BREADTH_THRESHOLDS.MA_WINDOW + 1;

/**
 * 安全取数：null / '' / undefined → null；其余转数字（非有限也 → null）。
 *
 * ★ 绝不能写成 `Number.isFinite(+v) ? +v : null`：`+null === 0`，会让 null 变成 0。
 *   同类陷阱还有 `+[] === 0`、`+'' === 0`——故这里只接受 **number 或数字字符串**，
 *   其余类型（数组/对象/布尔）一律判为 null。本函数是本模块所有数值入口的唯一闸门。
 */
export function num(v) {
  if (v == null || v === '') return null;
  const t = typeof v;
  if (t !== 'number' && t !== 'string') return null;  // 数组/对象/布尔：+[] 也是 0，不能放行
  const n = +v;
  return Number.isFinite(n) ? n : null;
}

/** 算术平均（空数组 → null，不返回 0）。 */
export function mean(arr) {
  const a = (arr || []).filter((v) => v != null && Number.isFinite(+v));
  if (!a.length) return null;
  return a.reduce((s, v) => s + +v, 0) / a.length;
}

/**
 * 单只票的宽度贡献。**纯函数，输入是这一只票自己的 K 线，不依赖任何外部序列。**
 *
 * @param {object} o
 * @param {number} o.close      当日收盘（前复权）
 * @param {number[]} o.closes   截至当日的收盘序列（含当日，按时间升序）
 * @param {number} [o.pb]       市净率（无则 null → 该票不参与破净率）
 * @param {object} [o.th]       阈值覆盖（测试用）
 * @returns {{aboveMa: boolean|null, isNewHigh: boolean|null, isNewLow: boolean|null,
 *            broken: boolean|null, ma: number|null, barsUsed: number}}
 *   **null 表示"这一只票这一项判不出"**（K 线不够 / 无 PB），不是"不明显"。
 *   它会被上游从**分母**里剔除，而不是当成 false（那就是偷偷把"不知道"算成"没有"）。
 */
export function stockBreadth(o = {}) {
  const th = { ...BREADTH_THRESHOLDS, ...(o.th || {}) };
  const close = num(o.close);
  const closes = Array.isArray(o.closes) ? o.closes.map(num).filter((v) => v != null) : [];
  const pb = num(o.pb);
  const n = closes.length;

  // MA(N)：需要整 N 根（含当日）。不足 → 判不出（null），不得用"现有几根"凑一个均线。
  let ma = null, aboveMa = null;
  if (close != null && n >= th.MA_WINDOW) {
    const win = closes.slice(-th.MA_WINDOW);
    ma = mean(win);
    if (ma != null) aboveMa = close > ma;
  }

  // 新高/新低：需要"当日之前"有足够的回看窗口，否则"最早那几天"会天然全是新高
  //   （没有更早的数据 → 无可比对象）。故要求 n 至少达到回看窗口 + 1。
  //   窗口不足时不判（null）——这正是**前视/后视偏差**的反面：不用"我只有这么多数据"
  //   去伪造一个"创新高"。
  let isNewHigh = null, isNewLow = null;
  if (close != null && n >= th.NEW_HIGH_LOOKBACK + 1) {
    const look = closes.slice(-(th.NEW_HIGH_LOOKBACK + 1), -1); // 不含当日
    const hi = Math.max(...look);
    const lo = Math.min(...look);
    isNewHigh = close >= hi;
    isNewLow = close <= lo;
  }

  const broken = pb != null ? pb < th.BROKEN_PB : null;

  return { aboveMa, isNewHigh, isNewLow, broken, ma, barsUsed: n };
}

/**
 * 汇总一批票的宽度指标。
 *
 * @param {Array} stocks 每项 { code, close, closes, pb }（closes 含当日）
 * @param {object} [opts]
 * @param {object} [opts.th]
 * @param {{up:number,down:number,flat:number}|null} [opts.updown]
 *        当日全市场涨跌家数（若调用方已从别的源拿到，如存档 summary）。给了就用它，
 *        给了就**不再**用 K 线自算——两套口径同时存在会让"家数"出现两个值。
 * @returns {object} 见下方字段注释
 */
export function computeBreadth(stocks, opts = {}) {
  const th = { ...BREADTH_THRESHOLDS, ...(opts.th || {}) };
  const list = Array.isArray(stocks) ? stocks : [];

  let scanned = 0;                 // 有可用 K 线的票（有效样本）
  let maDen = 0, maNum = 0;        // 站上均线
  let hiDen = 0, hiNum = 0;        // 新高
  let loDen = 0, loNum = 0;        // 新低
  let pbDen = 0, pbNum = 0;        // 破净
  const maMiss = [], hiMiss = [], pbMiss = [];

  for (const s of list) {
    if (!s || !s.code) continue;
    const b = stockBreadth(s);
    if (b.barsUsed >= th.MA_WINDOW) {
      scanned++;
      if (b.aboveMa != null) { maDen++; if (b.aboveMa) maNum++; } else maMiss.push(s.code);
      if (b.isNewHigh != null) { hiDen++; if (b.isNewHigh) hiNum++; if (b.isNewLow) loNum++; } else hiMiss.push(s.code);
      if (b.broken != null) { pbDen++; if (b.broken) pbNum++; } else pbMiss.push(s.code);
    } else {
      maMiss.push(s.code);
    }
  }

  const ratio = (n, d) => (d >= 1 ? Math.round((n / d) * 10000) / 10000 : null);
  // 可信性：样本量必须够。不足 → 比例置 null（不是 0），并标 reliable=false。
  const reliable = scanned >= th.MIN_SAMPLE;

  // 涨跌家数：优先用外部给的，否则从 K 线自算（"当日涨"= close > prevClose）。
  let updown = opts.updown || null;
  let updownSrc = opts.updown ? 'external' : null;
  if (!updown) {
    let up = 0, down = 0, flat = 0, n = 0;
    for (const s of list) {
      const c = num(s && s.close);
      const cs = s && Array.isArray(s.closes) ? s.closes.map(num).filter((v) => v != null) : [];
      if (c == null || cs.length < 2) continue;
      const prev = cs[cs.length - 2];
      const chg = c - prev;
      n++;
      if (chg > 0) up++; else if (chg < 0) down++; else flat++;
    }
    if (n >= th.MIN_SAMPLE) { updown = { up, down, flat }; updownSrc = 'kline'; }
  }

  const maRatio = reliable ? ratio(maNum, maDen) : null;
  let maVerdict = null;
  if (maRatio != null) {
    maVerdict = maRatio > th.MA_BULL ? 'bull' : maRatio < th.MA_BEAR ? 'bear' : 'neutral';
  }

  return {
    // 有效样本
    scanned,
    requested: list.length,
    reliable,
    thresholds: { MA_WINDOW: th.MA_WINDOW, NEW_HIGH_LOOKBACK: th.NEW_HIGH_LOOKBACK, BROKEN_PB: th.BROKEN_PB, MIN_SAMPLE: th.MIN_SAMPLE },
    // 站上 20 日线
    aboveMa: { n: maNum, den: maDen, ratio: maRatio, verdict: maVerdict, missing: maMiss.length },
    // 创一年新高 / 新低（同一回看窗口，分母相同）
    newHigh: { n: hiNum, den: hiDen, ratio: reliable ? ratio(hiNum, hiDen) : null, missing: hiMiss.length },
    newLow: { n: loNum, den: hiDen, ratio: reliable ? ratio(loNum, hiDen) : null, missing: hiMiss.length },
    // 破净率（PB 源不可用 → den=0 → ratio=null，绝不填 0）
    brokenPb: { n: pbNum, den: pbDen, ratio: reliable && pbDen >= 1 ? ratio(pbNum, pbDen) : null, missing: pbMiss.length },
    // 涨跌家数（external 优先；kline 自算为兜底）
    updown: updown ? { ...updown, src: updownSrc } : null,
    // 分化的直观量化：新高与新低同时高企 → 结构市。
    divergence: (reliable && hiDen >= 1)
      ? Math.round(((hiNum + loNum) / hiDen) * 10000) / 10000 : null,
    note: reliable
      ? null
      : `有效样本 ${scanned} < ${th.MIN_SAMPLE}，比例不予计算（显示"未计算"而非 0）`,
  };
}

/**
 * 宽度结论（用于 UI 状态色）：把四个维度合成一个可读判断。
 * **只做描述性归并，不做买卖建议**——宽度是"市场结构长什么样"，不是"该不该买"。
 */
export function breadthVerdict(b) {
  if (!b || !b.reliable) return { level: 'unknown', label: '未评估', detail: b ? b.note : '无数据' };
  const ma = b.aboveMa && b.aboveMa.ratio;
  const hi = b.newHigh && b.newHigh.ratio;
  const lo = b.newLow && b.newLow.ratio;
  if (ma == null) return { level: 'unknown', label: '未评估', detail: '站上均线占比未计算' };
  const diverge = (hi != null && lo != null && hi > 0.1 && lo > 0.1);
  if (diverge) return { level: 'diverged', label: '结构分化', detail: `新高 ${(hi * 100).toFixed(1)}% 与新低 ${(lo * 100).toFixed(1)}% 同时高企` };
  if (ma > BREADTH_THRESHOLDS.MA_BULL) return { level: 'broad', label: '宽度健康', detail: `站上20日线 ${(ma * 100).toFixed(1)}%` };
  if (ma < BREADTH_THRESHOLDS.MA_BEAR) return { level: 'narrow', label: '宽度收窄', detail: `站上20日线仅 ${(ma * 100).toFixed(1)}%` };
  return { level: 'mixed', label: '多空均衡', detail: `站上20日线 ${(ma * 100).toFixed(1)}%` };
}

/**
 * 逐日宽度序列（#3 的累积形态，与 seats_daily 同一思路）。
 *
 * 为什么也要逐日累积：K 线可以回看，但**"当时的 PB 与当时的全市场清单"回看不了**
 *   （清单随退市/上市变化，PB 只有当日快照）。故宽度也走"每天 append 一行"的路线，
 *   历史自然生长，不做伪回填。
 *
 * @param {Array} rows 每项 { date, breadth }（breadth 为 computeBreadth 的返回）
 * @returns {Array} 按日期升序、剔除无数据行
 */
export function buildBreadthSeries(rows, opts = {}) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.date && r.breadth && r.breadth.reliable)
    .map((r) => ({
      date: r.date,
      scanned: r.breadth.scanned,
      maRatio: r.breadth.aboveMa.ratio,
      newHighRatio: r.breadth.newHigh.ratio,
      newLowRatio: r.breadth.newLow.ratio,
      brokenRatio: r.breadth.brokenPb.ratio,
      up: r.breadth.updown ? r.breadth.updown.up : null,
      down: r.breadth.updown ? r.breadth.updown.down : null,
      verdict: breadthVerdict(r.breadth).level,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (opts.alignDates) {
    const byDate = new Map(list.map((r) => [r.date, r]));
    return opts.alignDates.map((d) => byDate.get(d) || { date: d, scanned: 0, maRatio: null, verdict: 'unknown' });
  }
  return list;
}

/**
 * 序列摘要。覆盖率分母**必须由调用方给出**（totalDays），
 * 否则滤空行后 okRows/totalRows 恒为 1 —— 会虚报 100% 覆盖（seats_daily 踩过）。
 */
export function breadthSeriesSummary(series, opts = {}) {
  const rows = Array.isArray(series) ? series : [];
  const ok = rows.filter((r) => r && r.scanned > 0);
  const totalDays = Number.isFinite(+opts.totalDays) && +opts.totalDays > 0 ? +opts.totalDays : null;
  return {
    days: ok.length,
    coverage: totalDays != null ? Math.round((ok.length / totalDays) * 10000) / 10000 : null,
    from: ok.length ? ok[0].date : null,
    to: ok.length ? ok[ok.length - 1].date : null,
    latest: ok.length ? ok[ok.length - 1] : null,
    maAvg: mean(ok.map((r) => r.maRatio)),
  };
}
