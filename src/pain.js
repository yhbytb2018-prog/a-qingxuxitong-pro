// ── 亏钱效应 / 接力情绪（唯一出处）──────────────────────────────────────────────
//
// 为什么需要这个模块：
//   现有 s_zbl 只算**炸板率**——"当日盘中触板但没封住的比例"。它衡量的是**当天封板的
//   质量**，答不了"昨天追高的人今天赚没赚"。这两件事完全不同：
//     · 炸板率低 = 今天封板的票封得牢（当日视角）
//     · 昨涨停今天全绿 = 昨天追进去的人今天在亏（跨日/接力视角）
//   一个市场可以"今天封板率 81%（很好看）"而"昨天涨停的票今天一半翻绿（很惨）"。
//   后者才是真情绪。故必须单独成模块，不能塞进 s_zbl。
//
// ⚠ 本模块存在的核心原因，是一个**必须避开的统计陷阱**（实测踩到）：
//   archive.hot 是「热门/涨停股列表」，实测 2026-09-30 的 hot 56 只**涨跌幅最小 9.87**、
//   低于 0 的有 **0 只** —— 它天然只含上涨的票。若用 hot 去算"昨涨停今日表现"，
//   昨日涨停里今天**下跌的票根本不在表内**，会被静默丢弃，于是每天都算出 ≈+10% 的
//   "假繁荣"（实测 17 个交易日全部 +9.98~+11.44）。这不是精度问题，是**选样偏差**：
//   被丢掉的恰恰是亏钱的那一半。
//   ⇒ 结论：本模块的"今日表现"**必须来自全市场真实行情**（quote.js 的 fetchQuotes），
//     绝不能用 hot/涨停池反查。同理，"大面股"也只能从真实行情里筛，不能从 hot 里筛。
//
// 三条纪律（与 src/health.js 同）：
//   1. **只读不造**：不重算 s_zbl 等既有因子，只做跨日的接力/亏钱统计。
//   2. **缺失显式化**：取不到行情/名单时返回 null（"未知"），不得填 0——
//      0% 翻绿 与 "没数据" 在情绪语境下含义相反（前者=极强，后者=不知道）。
//   3. **阈值集中在此**：UI 不得自写 `-15` 这类判断，一律读本模块导出的常量。

// ── 阈值（唯一出处）─────────────────────────────────────────────────────────
//
// 每一项都解释"为什么是这个数"：
//   BIG_LOSS_PCT   "大面"单日跌幅线。取 -7% —— 一个跌停板（-10%）的 0.7 倍，
//                  是"追高明显受伤"的通行分水岭，且能容纳 20% 涨跌幅制度票回撤一半。
//   AMPLITUDE_PCT  "天地板"判据用的日内振幅线。取 15% —— 主板天地板理论满载
//                  约 (10+10)/10 = 20%，15% 已属极端；20% 制度票则更易触发，符合本意。
//   BIG_LOSS_DT    "大面股"的另一等价判据：直接跌停。跌停即最严重的亏钱，必计入。
//   ADVANCE_FAIL   "晋级失败"定义：昨日 N 连板（N≥2）今日**未能继续涨停**。
//                  判据用今日 changePct < 涨停阈值（不是"翻绿"），因为"没能续板"
//                  才是接力断档的本质，哪怕今天只是 +2%（冲高失败）也算失败。
//   LOSS_WARN_RATIO 亏钱效应分级告警线：昨涨停今日翻绿比例 ≥ 0.5 视为"接力受损"。
//                  半数为界，直观且稳健（实测 9-30 = 49%、9-29 = 52%，正好卡在边界，
//                  说明这个阈值对真实市场有分辨力，不是拍脑袋）。
export const PAIN_THRESHOLDS = {
  BIG_LOSS_PCT: -7,
  AMPLITUDE_PCT: 15,
  BIG_LOSS_DT: true,
  ADVANCE_FAIL: true,
  LOSS_WARN_RATIO: 0.5,
  // 中性带：翻绿比例落在 [0.4, 0.6] 之内视为"多空拉锯"，不判方向。
  //
  // 为什么需要一条带，而不是对称的单一分界 0.5：
  //   实测 9-30 昨涨停翻绿 49% —— 若按 `lr < 0.5 → 顺畅`，会把"近一半股票在亏"
  //   判成"赚钱效应占优"，与直觉完全相反。0.5 附近本就是掷硬币，任何单一分界线
  //   都会让 49% 和 51% 落到对立的结论上，而它们其实没有区别。
  //   取 ±0.1 作为带宽：10% 的偏离才够说明"这一侧确实占优"，否则不表态。
  NEUTRAL_BAND: 0.1,
  MIN_SAMPLE: 5,
};

// 涨停阈值：不同板块制度不同。这里只用于"今天是否仍涨停"的判定。
// 取 9.8% 作为统一门槛——主板 10%、创业/科创 20% 都覆盖得到，
// 且 ST 5% 票会被判为"未涨停"，与"接力失败"的直觉一致（ST 本身不参与连板接力）。
export const ZT_THRESHOLD_PCT = 9.8;

/** 安全取数：非有限数一律 null（不把 undefined/NaN 混进统计）
 *
 * ⚠ 必须先判 `v == null` 再取 +v：`Number.isFinite(+null)` 竟是 **true**（因为 +null===0），
 *   若只写 `Number.isFinite(+v)`，`changePct: null` 会被静默当成 **0%** —— 一只"没有价格
 *   数据"的票会被算成"平盘"，既不算翻绿也不算上涨，直接稀释翻绿比例。这是本项目
 *   "null ≠ 0"纪律最隐蔽的一处陷阱（类型强转把"未知"变成了一个合法的数）。 */
const num = (v) => (v == null || v === '' ? null : (Number.isFinite(+v) ? +v : null));

/** 中位数（偶数个取中间两数均值）；空数组返回 null */
export function median(xs) {
  const a = (Array.isArray(xs) ? xs : []).filter((v) => Number.isFinite(v)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** 均值；空数组返回 null */
export function mean(xs) {
  const a = (Array.isArray(xs) ? xs : []).filter((v) => Number.isFinite(v));
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

/**
 * 昨日涨停今日表现 —— 回答"追高的人今天亏没亏"。
 *
 * 输入必须是**今日真实行情**（quote.js 形状），不可用 hot/涨停池反查（见文件头陷阱说明）。
 *
 * @param {object} curQuotes  今日行情 Map：{ code: {changePct, high, low, prevClose, ...} }
 * @param {Array<string|number>} prevZtCodes 昨日涨停代码名单（archive.summary.zt_codes）
 * @param {object} [opts]     { thresholds }
 * @returns {object} 统计结果；样本不足时各比值为 null 并置 reliable=false
 */
export function prevZtPerformance(curQuotes, prevZtCodes, opts = {}) {
  const th = { ...PAIN_THRESHOLDS, ...(opts.thresholds || {}) };
  const codes = (Array.isArray(prevZtCodes) ? prevZtCodes : []).map(String);
  const quotes = curQuotes && typeof curQuotes === 'object' ? curQuotes : {};

  const chg = [];
  let missing = 0;
  for (const c of codes) {
    const q = quotes[c];
    const v = num(q && q.changePct);
    if (v == null) { missing++; continue; }
    chg.push(v);
  }
  const n = chg.length;
  // 样本不足：不给出方向性结论（避免"3 只样本说翻绿 100%"这种噪音被当信号）
  const reliable = n >= Math.max(th.MIN_SAMPLE, Math.ceil(codes.length * 0.6));
  if (!n) {
    return {
      n: 0, universe: codes.length, missing, reliable: false,
      avg: null, median: null, lossRatio: null, worst: null, best: null,
      limitUpAgain: null, limitDown: null, bigLoss: null,
      note: '未取到今日行情，昨涨停表现无法计算',
    };
  }
  const neg = chg.filter((x) => x < 0).length;
  return {
    n,
    universe: codes.length,
    missing,
    reliable,
    avg: r2(mean(chg)),
    median: r2(median(chg)),
    // 翻绿比例：亏钱效应的核心口径（0~1）
    lossRatio: r2(neg / n),
    worst: r2(Math.min(...chg)),
    best: r2(Math.max(...chg)),
    // 今日再度涨停（一字或回封）——接力的"成功"侧
    limitUpAgain: chg.filter((x) => x >= ZT_THRESHOLD_PCT).length,
    limitDown: chg.filter((x) => x <= -9.8).length,
    // 大面：跌幅超阈值
    bigLoss: chg.filter((x) => x <= th.BIG_LOSS_PCT).length,
    note: reliable ? null : `样本 ${n}/${codes.length} 偏少，结论仅供参考`,
  };
}

/**
 * 连板晋级失败率 —— 接力是否断档。
 *
 * @param {object} curQuotes 今日真实行情 Map
 * @param {object} prevZtLb  昨日 { code: 连板数 }（archive.summary.zt_lb）
 * @param {object} [opts]
 * @returns {object} 按连板高度分层的晋级统计
 */
export function advanceFailure(curQuotes, prevZtLb, opts = {}) {
  const th = { ...PAIN_THRESHOLDS, ...(opts.thresholds || {}) };
  const quotes = curQuotes && typeof curQuotes === 'object' ? curQuotes : {};
  const lb = prevZtLb && typeof prevZtLb === 'object' ? prevZtLb : {};

  // 只看 N≥2 的高位板：首板（N=1）不算"接力"，它是当日新起的，没有"晋级"概念。
  const tiers = { '2': [], '3': [], '4+': [] };
  for (const [code, nRaw] of Object.entries(lb)) {
    const n = num(nRaw);
    if (n == null || n < 2) continue;
    const q = quotes[String(code)];
    const c = num(q && q.changePct);
    if (c == null) continue; // 缺行情不计入分母（避免把"没数据"当"失败"）
    const kept = c >= ZT_THRESHOLD_PCT; // 今日是否仍封板
    const bucket = n >= 4 ? '4+' : String(n);
    tiers[bucket].push({ code: String(code), lb: n, chg: r2(c), kept });
  }

  const summarize = (rows) => {
    if (!rows.length) return { n: 0, kept: 0, failed: 0, failRate: null };
    const kept = rows.filter((x) => x.kept).length;
    return { n: rows.length, kept, failed: rows.length - kept, failRate: r2((rows.length - kept) / rows.length) };
  };

  const byTier = {};
  let all = [];
  for (const k of Object.keys(tiers)) { byTier[k] = summarize(tiers[k]); all = all.concat(tiers[k]); }
  const overall = summarize(all);

  return {
    ...overall,
    byTier,
    reliable: overall.n >= th.MIN_SAMPLE,
    // 最高板（昨日最高连板数）——梯队高度的"顶"，断档时最直观
    maxLb: all.length ? Math.max(...all.map((x) => x.lb)) : null,
    detail: all.slice().sort((x, y) => y.lb - x.lb || (x.chg ?? 0) - (y.chg ?? 0)),
    note: overall.n ? null : '昨日无 2 连板及以上个股，或行情缺失',
  };
}

/**
 * 大面股 / 天地板 —— 从**今日真实行情**里筛（不可从 hot 筛，见文件头）。
 *
 * 天地板判据：日内振幅 ≥ AMPLITUDE_PCT 且收盘为绿（高开冲板后砸下来的形态）。
 * 只用 high/low/prevClose 即可判断，不依赖分时。
 *
 * @param {object} curQuotes 今日真实行情 Map（需 high/low/prevClose/changePct）
 * @param {object} [opts]
 */
export function bigLossStocks(curQuotes, opts = {}) {
  const th = { ...PAIN_THRESHOLDS, ...(opts.thresholds || {}) };
  const quotes = curQuotes && typeof curQuotes === 'object' ? curQuotes : {};
  const big = [];
  const sky = [];
  for (const [code, q] of Object.entries(quotes)) {
    const c = num(q && q.changePct);
    if (c == null) continue;
    const isBig = c <= th.BIG_LOSS_PCT || (th.BIG_LOSS_DT && c <= -9.8);
    if (isBig) big.push({ code, name: q.name || '', chg: r2(c) });
    const hi = num(q.high), lo = num(q.low), pc = num(q.prevClose);
    if (hi != null && lo != null && pc != null && pc > 0) {
      const amp = (hi - lo) / pc * 100;
      if (amp >= th.AMPLITUDE_PCT && c < 0) sky.push({ code, name: q.name || '', chg: r2(c), amplitude: r1(amp) });
    }
  }
  big.sort((x, y) => x.chg - y.chg);
  sky.sort((x, y) => y.amplitude - x.amplitude);
  return {
    bigLoss: { n: big.length, list: big.slice(0, 10) },
    skyFloor: { n: sky.length, list: sky.slice(0, 10) },
    scanned: Object.keys(quotes).length,
  };
}

/**
 * 亏钱效应综合结论 —— 把上述三块拼成一句可读判断（供报告"一句话结论"用）。
 * 分级不引入新阈值，全部引用 PAIN_THRESHOLDS.LOSS_WARN_RATIO。
 *
 * @returns {{level:'severe'|'weak'|'normal'|'strong'|'unknown', label, reason}}
 */
export function painVerdict(perf, adv, opts = {}) {
  const th = { ...PAIN_THRESHOLDS, ...(opts.thresholds || {}) };
  if (!perf || perf.lossRatio == null || !perf.reliable) {
    return { level: 'unknown', label: '未知', reason: '昨涨停行情样本不足，亏钱效应无法判定' };
  }
  const lr = perf.lossRatio;
  const fr = adv && adv.failRate != null && adv.reliable ? adv.failRate : null;
  const band = th.NEUTRAL_BAND;
  // 中性带以 0.5 为中心：hi=0.5+band=0.6、lo=0.5−band=0.4。
  // （注意不是 1−band：band 是"对半分的偏离量"，不是"剩余比例"。）
  const hi = th.LOSS_WARN_RATIO + band;
  const lo = th.LOSS_WARN_RATIO - band;
  // 分级只看"翻绿比例"，高位板晋级失败率作为**加重/减轻**证据写进 reason，不改判定——
  // 两侧若各自改判定会互相掩盖（一个说惨一个说好，最后谁都不响亮）。
  //
  // ⚠ 中性带 [0.4, 0.6] 是必须的：实测 9-30 翻绿 49%，若按"<0.5 即顺畅"会判成
  //   "赚钱效应占优"，与"近一半在亏"的事实相反。0.5 附近本就是掷硬币，单一分界线
  //   会让 49% 与 51% 落到对立结论，而它们并无区别。偏离 ≥10% 才表态。
  if (lr > hi) {
    const severe = fr != null && fr >= th.LOSS_WARN_RATIO;
    return {
      level: severe ? 'severe' : 'weak',
      label: severe ? '亏钱效应显著' : '接力转弱',
      reason: `昨涨停今日翻绿 ${(lr * 100).toFixed(0)}%`
        + (fr != null ? `、高位板晋级失败 ${(fr * 100).toFixed(0)}%` : '')
        + '，追高者整体受损',
    };
  }
  if (lr < lo) {
    return {
      level: 'strong', label: '接力顺畅',
      reason: `昨涨停今日翻绿仅 ${(lr * 100).toFixed(0)}%`
        + (fr != null ? `、高位板晋级失败 ${(fr * 100).toFixed(0)}%` : '')
        + '，赚钱效应占优',
    };
  }
  return {
    level: 'normal', label: '多空拉锯',
    reason: `昨涨停今日翻绿 ${(lr * 100).toFixed(0)}%`
      + (fr != null ? `、高位板晋级失败 ${(fr * 100).toFixed(0)}%` : '')
      + '，追高盈亏各半',
  };
}

/**
 * 端到端：从相邻两日存档 + 今日行情，产出完整亏钱效应面板数据。
 * 这是给 pipeline / 报告 / 前端调用的**唯一入口**，避免各处自行拼装口径。
 *
 * @param {object} prevDay 昨日存档天（需 summary.zt_codes / zt_lb）
 * @param {object} curQuotes 今日真实行情 Map
 * @param {object} [opts]
 */
export function painReport(prevDay, curQuotes, opts = {}) {
  const s = (prevDay && prevDay.summary) || {};
  const perf = prevZtPerformance(curQuotes, s.zt_codes, opts);
  const adv = advanceFailure(curQuotes, s.zt_lb, opts);
  const big = bigLossStocks(curQuotes, opts);
  const verdict = painVerdict(perf, adv, opts);
  return {
    date: (prevDay && prevDay.trade_date) || null,
    prevZtCount: Array.isArray(s.zt_codes) ? s.zt_codes.length : 0,
    perf,
    advance: adv,
    bigLoss: big.bigLoss,
    skyFloor: big.skyFloor,
    scanned: big.scanned,
    verdict,
    thresholds: { ...PAIN_THRESHOLDS, ...(opts.thresholds || {}) },
  };
}
