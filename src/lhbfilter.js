// 龙虎榜标的前置过滤（V5.2-pro 规则第一块的唯一实现）
//
// 定位：**所有买入委托在生成之前必须先过这里**。回测与实盘共用同一套判据，
// 避免「回测能买、实盘买不进」这类口径分裂——这是本模块存在的唯一理由。
//
// 为什么单独成文件、不写在 paper.js 或 UI：
//   · 判据全部来自龙虎榜结构（净买率 / 席位集中度 / 机构与北向方向），
//     属于「标的资格」问题，与「资金够不够 / 数量合不合法」是两层，
//     混在 validateOrder 里会让下单校验承担两种职责，阈值也容易各写一份。
//   · 本模块是纯函数零依赖 ESM，Node 侧（管线/回测）与浏览器侧（页面展示）共用。
//
// ────────────────────────── 数据边界（诚实声明，必须有） ──────────────────────────
//
// 本系统的存档「没有」下列字段，相关规则因此**无法精确计算**：
//
//   ① 个股当日全天成交额 —— 存档只有龙虎榜的买/卖额（buy_wan/sell_wan），
//      没有该股当天全部撮合的成交额。故规则要求的
//      「龙虎净买率 = 净买额 ÷ 当日成交额」改用**龙虎榜成交额**作分母：
//          净买率 = net_buy_wan ÷ (buy_wan + sell_wan)
//      口径含义收窄为「净买额占该股上榜成交额的比重」。分母同源于交易所披露、
//      可逐条核验，方向与量级与原定义一致；但数值会系统性高于原口径
//      （上榜成交额 < 全天成交额），故阈值 4% 在此口径下相当于原口径的更松门槛。
//      **这是刻意的取舍，不是疏漏**：宁可用一个能核验的代理口径并显式标注，
//      也不去编一个「看起来精确」的假分母。
//
//   ② 锁仓资金 —— 存档没有「锁仓」的定义或字段。真实锁仓需跨日席位比对
//      （同一席位昨日买入今日未卖出且继续买入），本系统仅有单日席位明细，
//      跨日比对会引入「席位名写法漂移」「同一资金换营业部」等不可控误差，
//      做出来的数会「看起来对、细看全错」。故该条**跳过并留痕**，不参与拦截。
//
//   ③ 近 60 日涨幅 —— 存档只有 33 个交易日，物理上算不出 60 个交易日涨幅。
//      故该条**跳过并留痕**。绝不按比例缩放阈值去凑一个数——
//      那等于用一个自己发明的规则冒充用户给的规则。
//
// 上述三条的处理方式统一为：**留痕跳过（skipped），不拦截、不静默丢弃**。
// 每次过滤结果里都会带 `skipped` 数组，说明哪条规则因数据不足未生效。

import { isNewStock, RANGE_BOARD_RE } from './lhb.js';
import { buySeatsOf, sellSeatsOf, sideStats, seatTypeOf } from './seats.js';

export const LHBFILTER_VERSION = 'lhbfilter-v1';

// ────────────────────────── 阈值（唯一出处，UI 不得重写） ──────────────────────────

/** 单只标的净买额占当日全市场龙虎总净额的比重上限 */
export const MAX_SHARE_OF_MARKET = 0.25;

/** 买方前三席位集中度上限（%）——超过说明筹码集中在少数席位，风险高 */
export const MAX_TOP3_CONC = 75;

/** 买方只有游资时的席位数（用于「买方只有游资」判定时的参考，非硬阈值） */
export const MAX_TOP3_CONC_STRICT = 80;

// 主候选池准入阈值
export const ADMIT = {
  netBuyRate: 0.04,     // 龙虎净买率 ≥4%（分母口径见文件头「数据边界①」）
  top3ConcMax: 0.75,    // 买方前三席位集中度 ≤75%
};

/** 强制剔除原因码（可读，UI 只翻译不判断）
 *
 *  ⚠ 「龙虎榜净买入 ≤ 0」**不在**此表内——它已降级为「不阻断」规则（见下方「降级规则」区块）。
 *  该键曾被删除，不是遗漏：留一个不再被 push 的死键，会让人下次「顺手」把它接回
 *  rejectedBy，规则就悄悄从降级退回禁止。要恢复禁止，请连测试一起改，别只删一行。 */
export const REJECT_LHB = {
  NEW_STOCK: '上市5日内无涨跌幅限制股票',
  SHARE_TOO_HIGH: '龙虎净买占全市场龙虎总净额 > 25%',
  HOT_ONLY_AND_CONC: '买方仅游资（机构与北向均净卖出）且买方前三席位集中度 > 80%',
  NET_BUY_RATE_TOO_LOW: '龙虎净买率低于准入门槛（规则⑦联动条款）',
  THEME_TOO_WEAK: '主线题材强度分 < 0.5',
};

// ────────────────────── 降级规则：龙虎净买入 ≤ 0（不阻断，改为降级+告警） ──────────────────────
//
// 2026-10-01 用户裁定：龙虎榜净买入 ≤ 0 **不再直接禁止委托**，改为
//   ① 模型打分扣减固定分值（降低入选优先级）；
//   ② 打告警标签（谨慎开仓）；
//   ③ 人工复核后才允许下单。
//
// 为什么从「强制剔除」降级为「备选观察」：净买为负说明当日资金在出，但它**不等于**次日必跌——
// 一笔买入委托是否该被系统直接掐掉，与「这只票今天资金面不好看」是两个不同量级的结论。
// 系统能负责的是「标明风险、降低优先级」；「要不要买」这一层必须留给用户，
// 所以落在 WATCH 桶（仅展示、禁止自动下单）+ 显式告警，而不是 REJECTED（禁止生成委托）。
//
// 扣分是**固定分值**（人工声明常量，不做任何归一化/自适应）——可复算、可单测、可解释。
// 两条打分链路各扣各的（两处的分数语义不同，混用一个数会让「概率分 52.3」这类
// 可核验统计量失去基准含义）：
//   · picks.js  综合分（0~100 加权和）        −LHB_NET_OUTFLOW_PENALTY.SCORE
//   · predict.js 上涨概率分（基准 55.3，百分点）−LHB_NET_OUTFLOW_PENALTY.PROB
// **UI 一律 import 这两个常量，绝不得手抄 10 / 8**（手抄等于第二套口径，口径守卫会拦）。
export const LHB_NET_OUTFLOW_PENALTY = {
  SCORE: 10,   // picks.js 综合分扣减（0~100 分制），减法后夹在 0~100
  PROB: 8,     // predict.js 上涨概率扣减（百分点；基准 55.3，多数票落在 55~72）
};

/** 降级/告警原因码（不阻断委托，只降优先级 + 打标签 + 要求人工复核） */
export const FLAG_LHB = {
  NET_OUTFLOW: '⚠龙虎当日资金净流出，谨慎开仓',
};

/**
 * 「龙虎净买入 ≤ 0」的唯一判据。判据本身也集中在这里——UI/picks/predict 一律调它，
 * 不得各写一份 `netWan <= 0`（那样阈值一变就三处不同步）。
 *
 * null 视同「不达标」：无净买记录就是没有资金进场证据，与净流出同档处理。
 * 调用方必须显式处理 null，故这里同时返回区分标志，避免把「没有记录」说成「净流出」。
 *
 * @returns {{hit:boolean, kind:'null'|'zero'|'negative'|null, value:number|null}}
 */
export function isNetOutflow(netWan) {
  if (netWan == null || !Number.isFinite(+netWan)) return { hit: true, kind: 'null', value: null };
  const v = +netWan;
  if (v < 0) return { hit: true, kind: 'negative', value: v };
  if (v === 0) return { hit: true, kind: 'zero', value: 0 };
  return { hit: false, kind: null, value: v };
}

/** 告警标签的可读文案（UI 直接渲染；带「为什么」与「怎么办」两句必需信息） */
export function netOutflowText(f) {
  const v = f && f.netWan;
  const head = (v == null)
    ? '当日龙虎榜无净买记录'
    : (v < 0 ? `当日龙虎榜净买 ${(Math.abs(+v) / 1e4).toFixed(2)} 亿（资金净流出）` : '当日龙虎榜净买为 0');
  return `${FLAG_LHB.NET_OUTFLOW} —— ${head}，模型打分已扣 `
    + `综合分 ${LHB_NET_OUTFLOW_PENALTY.SCORE} 分 / 上涨概率 ${LHB_NET_OUTFLOW_PENALTY.PROB} 个百分点`
    + `（降低入选优先级，不禁止委托）；请人工复核后再决定是否开仓。`;
}

/** 因数据不足而未生效的规则（留痕，不拦截） */
export const SKIPPED_RULES = {
  LOCKUP_RATIO: '锁仓资金占当日买入比例——存档无「锁仓」定义与字段，需跨日席位比对，本系统仅有单日明细',
  GAIN_60D: '近60日涨幅——存档仅 33 个交易日，物理上算不出 60 交易日涨幅',
};

/** 过滤结论（单只标的的最终归属） */
export const BUCKET = {
  MAIN: 'main',       // 主候选池：可自动下单
  WATCH: 'watch',     // 备选观察池：仅页面展示，禁止自动下单
  REJECTED: 'rejected', // 被强制剔除：禁止生成买入委托
};

// ⚠ 不能写成 `Number.isFinite(+v)`：`+null === 0` 且 `+'' === 0`，两者都会让**缺失值**
//   通过判定，随后被读成 0。本文件用它判断 change_pct/turnover_pct/close/marketNetWan 等
//   可空字段，一旦失守，"没有数据"会静默变成"涨跌 0%"并进入评分。
//   （src/alerts.js::finite 早已记录同一陷阱，此处必须对齐同一纪律。）
const finite = (v) => v != null && v !== '' && typeof v !== 'boolean' && Number.isFinite(+v);
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

// ────────────────────────── 单只标的的结构化特征 ──────────────────────────

/**
 * 从一天存档里抽出某只标的的可核验特征。**不产生任何判断**，只做字段归集，
 * 便于单独测试与在页面上展示「判断依据」。
 *
 * @param {string} code
 * @param {object} day archive 的某一天
 * @returns {object|null} 抽不到基础记录时返回 null
 */
export function featuresOf(code, day) {
  const c = String(code || '');
  if (!c) return null;
  const d = day || {};
  const s = d.summary || {};

  // 当日榜去重行（口径唯一出处：区间累计榜必须排除，否则值是 N 日累计）
  // 代表行取「当日榜」中 |净额| 最大者——与 src/lhb.js 的 aggregateByCode 同一取法。
  // 新股**不在这里剔除**：新股特征要如实带出（isNewStock 字段），由 filterOne 决定是否拦截，
  // 免得「因为剔了所以看不出是为什么被剔」这种丢失依据的情况。
  const rows = Array.isArray(d.lhb) ? d.lhb : [];
  const daily = rows.filter((l) => {
    if (!l || String(l.code) !== c) return false;
    const isRange = l.is_range != null ? !!l.is_range : RANGE_BOARD_RE.test(String(l.reason || ''));
    return !isRange;
  });
  let rec = null;
  if (daily.length) {
    rec = daily.slice().sort((a, b) => Math.abs(b.net_buy_wan || 0) - Math.abs(a.net_buy_wan || 0))[0];
  }

  const lhbRow = rows.find((l) => l && String(l.code) === c) || null;
  const isNew = lhbRow ? isNewStock(lhbRow) : false;

  // 热点榜补充名称/换手（龙虎榜缺名称时用）
  const hot = (Array.isArray(d.hot) ? d.hot : []).find((h) => h && String(h.code) === c) || null;
  // 涨停名单：判定「该票当日有没有可核验的市场共识证据」。
  // 与 picks.js buildCandidates 同源（summary.zt_codes），仅用于区分
  // 「有记录但资金在出」（降级）与「根本查无此票」（仍强制剔除）。
  const ztCodes = new Set(Array.isArray(s.zt_codes) ? s.zt_codes.map(String) : []);
  const isZt = ztCodes.has(c);

  // 席位明细（唯一读取出口，已净化「类别汇总行」）
  const detail = (s.seats || {}).detail || null;
  const buySeats = buySeatsOf(detail, c);
  const sellSeats = sellSeatsOf(detail, c);
  const buySide = sideStats(buySeats);
  const sellSide = sideStats(sellSeats);

  // 逐票的机构/北向/游资 买与卖（金额，万元）
  const byType = (pairs) => {
    const out = { inst: 0, north: 0, hot: 0 };
    for (const [nm, amt] of pairs) {
      const t = seatTypeOf(nm);
      if (t === 'inst') out.inst += Number(amt) || 0;
      else if (t === 'north') out.north += Number(amt) || 0;
      else out.hot += Number(amt) || 0;   // prop/branch/sales/other 统一归「游资/非机构非北向」
    }
    return out;
  };
  const buyByType = byType(buySeats);
  const sellByType = byType(sellSeats);

  const netWan = rec ? +rec.net_buy_wan || 0 : null;
  const buyWan = rec ? +rec.buy_wan || 0 : null;
  const sellWan = rec ? +rec.sell_wan || 0 : null;
  const lhbAmtWan = (buyWan || 0) + (sellWan || 0);   // 龙虎榜成交额（分母代理口径）

  return {
    code: c,
    name: (rec && rec.name) || (lhbRow && lhbRow.name) || (hot && hot.name) || c,
    onLhb: !!(rec || lhbRow),
    isNewStock: isNew,
    // 当日涨停（当日榜名单口径）。无龙虎记录但涨停的票仍算「有真实依据」——
    // 降级规则据此把它与「查无此票」区分开。
    isZt,
    netWan,
    buyWan,
    sellWan,
    lhbAmtWan,
    // 净买率（分母 = 龙虎榜成交额，口径见文件头①）
    netBuyRate: lhbAmtWan > 0 && netWan != null ? r3(netWan / lhbAmtWan) : null,
    buyTop3Pct: buySide.top3Pct != null ? r2(buySide.top3Pct) : null,
    buySeatCount: buySide.n,
    sellSeatCount: sellSide.n,
    hasSellDetail: sellSeats.length > 0,
    buyByType: { inst: r2(buyByType.inst), north: r2(buyByType.north), hot: r2(buyByType.hot) },
    sellByType: { inst: r2(sellByType.inst), north: r2(sellByType.north), hot: r2(sellByType.hot) },
    // 机构/北向 净买（万元）：只用逐票明细，无明细时回退 null（不猜）
    instNetWan: sellSeats.length ? r2(buyByType.inst - sellByType.inst) : null,
    northNetWan: sellSeats.length ? r2(buyByType.north - sellByType.north) : null,
    hotNetWan: sellSeats.length ? r2(buyByType.hot - sellByType.hot) : null,
    changePct: finite(rec?.change_pct) ? +rec.change_pct : (finite(hot?.change_pct) ? +hot.change_pct : null),
    turnoverPct: finite(rec?.turnover_pct) ? +rec.turnover_pct : (finite(hot?.huanshou) ? +hot.huanshou : null),
    reason: (rec && rec.reason) || (lhbRow && lhbRow.reason) || (hot && hot.reason) || '',
    close: finite(rec?.close) ? +rec.close : (finite(hot?.close) ? +hot.close : null),
  };
}

// ────────────────────────── 主线题材强度分（0~1） ──────────────────────────

/**
 * 主线题材强度分 → 0~1（规则⑦「主线题材强度分 < 0.5」的判据）。
 *
 * 存档可用的只有 `summary.main_theme.pct`（主线净买占当日全榜净买的百分比）。
 * 本函数把它归一到 0~1：**以 20% 为满分的参照**——主线占全市场龙虎净买 20% 以上
 * 视为强主线。该参照与本系统 s_net 因子的 tanh 尺度（5 亿量级近饱和）不同源，
 * 故单独设常量并在此注明，不做跨模块复用（跨口径复用是 bug 温床）。
 *
 * 主线的净买若为负（主线在出货），强度直接为 0——「主线在卖」不构成强度。
 */
export const THEME_FULL_PCT = 20;   // 主线净买占全榜 ≥20% 记为满分 1.0

export function themeStrengthOf(day) {
  const mt = (day?.summary || {}).main_theme;
  if (!mt || !mt.name) return null;
  const pct = finite(mt.pct) ? +mt.pct : null;
  const yi = finite(mt.main_yi) ? +mt.main_yi : null;
  // 强度必须有「量」支撑：净买额为负或缺失 → 0
  if (yi != null && yi <= 0) return 0;
  if (pct == null) return null;
  return r3(Math.max(0, Math.min(1, pct / THEME_FULL_PCT)));
}

// ────────────────────────── 核心：单只标的过滤 ──────────────────────────

/**
 * 对单只标的执行 V5.2-pro 第一块的全部过滤规则。
 *
 * 返回结构（结构化，UI 直接渲染，不重新判断）：
 * {
 *   code, name, bucket,          // 'main' | 'watch' | 'rejected'
 *   passed,                      // 是否通过强制剔除（进入主候选或备选的必要条件）
 *   rejectedBy: [...],           // 命中的**强制剔除**条目（含 code/text/value）——只含阻断类
 *   netOutflow: object|null,     // 命中的**降级**条目（龙虎净买 ≤ 0）——不阻断，只降级
 *   flags: string[],             // 告警标签文案（UI 直接渲染，不重写）
 *   needReview: boolean,         // 是否须人工复核后才允许下单（降级命中即为 true）
 *   admit: { met:[], unmet:[] }, // 主候选准入 4 条的达成情况
 *   skipped: [...],              // 因数据不足未生效的规则（留痕）
 *   features,                    // 原始特征（可核验）
 *   themeStrength,               // 主线题材强度分
 *   text,                        // 一句可读结论
 * }
 *
 * ⚠ `passed` 与 `bucket==='main'` 是两件事，别混用：
 *   · passed=true 只说明「没被强制剔除」，降级票也会是 true；
 *   · 能不能自动下单只看 bucket==='main'（降级票恒为 'watch'）。
 *   早先把「净买 ≤ 0」放进 rejectedBy，等于用阻断语义表达降级语义；现已拆开，
 *   因为二者对下游的含义完全不同（能否生成委托 vs 优先级与复核要求）。
 *
 * @param {string} code 标的代码
 * @param {object} day  archive 的某一天
 * @param {object} [opts]
 * @param {number} [opts.marketNetWan] 当日全市场龙虎总净额（万元，当日榜口径）
 * @param {boolean} [opts.requireAdmit=true] 买入前置是否要求「全部准入条件满足」才放行
 *        —— 规则规定：主候选池须**全部满足**准入；未全满足者进备选观察池，禁止自动下单。
 *        故 requireAdmit 恒为 true 时，返回 bucket='main' 才允许下单。
 */
export function filterOne(code, day, opts = {}) {
  const f = featuresOf(code, day);
  const skipped = [
    { key: 'LOCKUP_RATIO', text: SKIPPED_RULES.LOCKUP_RATIO, blocking: false },
    { key: 'GAIN_60D', text: SKIPPED_RULES.GAIN_60D, blocking: false },
  ];

  if (!f) {
    return {
      code: String(code || ''), name: String(code || ''), bucket: BUCKET.REJECTED,
      passed: false,
      rejectedBy: [{ code: 'NO_RECORD', text: '当日存档无该标的任何记录', value: null }],
      admit: { met: [], unmet: [] }, skipped, features: null, themeStrength: null,
      text: '无当日记录，禁止生成买入委托。',
    };
  }

  const s = day?.summary || {};
  const marketNetWan = finite(opts.marketNetWan) ? +opts.marketNetWan
    : (finite(s.lhb_daily_net) ? +s.lhb_daily_net * 1e4 : null);  // summary 里是「亿」，转万元
  const themeStrength = themeStrengthOf(day);

  const rejectedBy = [];
  const push = (code_, text, value) => rejectedBy.push({ code: code_, text, value });

  // ① 上市 5 日内无涨跌幅限制新股 —— 涨跌幅不予板段约束，与正常股不可比
  if (f.isNewStock) push('NEW_STOCK', REJECT_LHB.NEW_STOCK, f.reason);

  // ② 个股当日龙虎榜净买入 ≤ 0 —— **降级规则，不阻断**（见文件上部「降级规则」注释）
  //
  //    为什么不用 `push(...)`：那个数组叫 rejectedBy，进去就意味着 `passed=false` →
  //    REJECTED 桶 → 禁止生成买入委托，与该规则现在的定位（降优先级，不禁止）自相矛盾。
  //    单独放一个 flag，再由下方的桶判定把它压进 WATCH。
  //
  //    ⚠ 但「无任何记录」必须与「有记录且净买 ≤ 0」分开处理，不能一起降级：
  //      前者是**数据缺失/代码不对**（该票当天根本没上榜），后者是**有依据但依据不好**。
  //      把「查无此票」降级放行，等于让一个没有真实资金证据、也没有涨停记录的代码
  //      走到「填得进下单区」这一步——那不是谨慎，那是把校验口子开在数据缺失上。
  //      故：有龙虎记录 → 降级；无龙虎记录但有涨停记录（isZt 由候选池带出时可辨）→ 也降级；
  //      两者皆无 → 仍按强制剔除（无任何资金/共识证据）。
  const outflow = isNetOutflow(f.netWan);
  const hasAnyRecord = f.onLhb || f.isZt === true;
  const netOutflow = (outflow.hit && hasAnyRecord)
    ? { code: 'NET_BUY_NON_POSITIVE', kind: outflow.kind, value: outflow.value, text: netOutflowText(f) }
    : null;
  // 无龙虎记录且无涨停证据：仍属强制剔除（与文件头「数据边界」的诚实原则一致——
  // 没有依据就不放行，而不是把缺数据说成"风险降级"）
  if (outflow.hit && !hasAnyRecord) {
    push('NO_RECORD', '当日归档无该标的任何记录（龙虎榜与涨停名单均无）', null);
  }

  // ③ 个股龙虎净买占当日全市场龙虎总净额 > 25%（单票吸走全市场超四分之一资金，异常）
  let sharePct = null;
  if (marketNetWan != null && marketNetWan > 0 && f.netWan != null) {
    sharePct = f.netWan / marketNetWan;
    if (sharePct > MAX_SHARE_OF_MARKET) {
      push('SHARE_TOO_HIGH', REJECT_LHB.SHARE_TOO_HIGH, r3(sharePct * 100));
    }
  }

  // ④ 买方只有游资（机构与北向均净卖出）且买方前三席位集中度 > 80%
  //    仅在有双侧席位明细时才能判定——无卖侧明细时机构/北向「净卖出」无从谈起，如实跳过判定。
  let hotOnlyConc = null;
  if (f.hasSellDetail && f.instNetWan != null && f.northNetWan != null && f.hotNetWan != null) {
    const instOut = f.instNetWan <= 0;
    const northOut = f.northNetWan <= 0;
    const hotIn = f.hotNetWan > 0;
    const conc = f.buyTop3Pct;
    if (instOut && northOut && hotIn && conc != null && conc > MAX_TOP3_CONC_STRICT) {
      hotOnlyConc = { inst: f.instNetWan, north: f.northNetWan, hot: f.hotNetWan, conc };
      push('HOT_ONLY_AND_CONC', REJECT_LHB.HOT_ONLY_AND_CONC, r2(conc));
    }
  } else {
    skipped.push({
      key: 'HOT_ONLY_AND_CONC', blocking: false,
      text: '买方仅游资且集中度>80% 的判定：该票缺双侧席位明细（存档仅有买方），无法判定机构/北向净卖出',
    });
  }

  // ⑤ 锁仓资金占当日买入 < 20% —— 数据不足，留痕跳过（见文件头②）

  // ⑥ 近 60 日涨幅 > 120% 且龙虎净买率 < 3% —— 数据不足，留痕跳过（见文件头③）

  // ⑦ 主线题材强度分 < 0.5
  if (themeStrength != null && themeStrength < 0.5) {
    push('THEME_TOO_WEAK', REJECT_LHB.THEME_TOO_WEAK, themeStrength);
  } else if (themeStrength == null) {
    skipped.push({ key: 'THEME_TOO_WEAK', blocking: false, text: '主线题材强度分缺失（当日无主线判定），该条未生效' });
  }

  const passed = rejectedBy.length === 0;

  // ── 主候选池准入（4 条，须全部满足） ──
  const met = [], unmet = [];
  const check = (key, label, ok, value) => (ok ? met : unmet).push({ key, label, ok: !!ok, value });

  // ① 龙虎净买率 ≥4%（分母口径见文件头①）
  check('netBuyRate', `龙虎净买率 ≥${ADMIT.netBuyRate * 100}%`, f.netBuyRate != null && f.netBuyRate >= ADMIT.netBuyRate,
    f.netBuyRate != null ? r3(f.netBuyRate * 100) + '%' : null);
  // ② 锁仓资金占当日买入 ≥30% —— 数据不足，**不计入 unmet**（否则永远无法进主池），
  //    而是显式标注为「未生效」——这是诚实边界。
  //    注意：顶部 skipped 里已有 LOCKUP_RATIO，这里不再重复 push 同 key（避免同一规则出现两条）。
  const lockupSkipped = skipped.find((s) => s.key === 'LOCKUP_RATIO');
  if (lockupSkipped) lockupSkipped.text += '（准入条件同此，未计入未满足项）';
  // ③ 买方前三席位集中度 ≤75%
  check('top3Conc', `买方前三席位集中度 ≤${MAX_TOP3_CONC}%`, f.buyTop3Pct != null && f.buyTop3Pct <= MAX_TOP3_CONC,
    f.buyTop3Pct != null ? r2(f.buyTop3Pct) + '%' : null);
  // ④ 机构净买 >0 或 北向净买 >0
  check('instOrNorth', '机构净买 >0 或 北向净买 >0',
    (f.instNetWan != null && f.instNetWan > 0) || (f.northNetWan != null && f.northNetWan > 0),
    f.hasSellDetail ? `机构 ${f.instNetWan} / 北向 ${f.northNetWan} 万` : '无双侧席位明细');

  const allAdmit = unmet.length === 0;

  let bucket, text;
  if (!passed) {
    bucket = BUCKET.REJECTED;
    text = '强制剔除：' + rejectedBy.map((x) => x.text).join('；') + '。禁止生成买入委托。';
  } else if (netOutflow) {
    // ⚠ 顺序即语义：`!passed` 必须排在 netOutflow 之前。
    //    若把降级提到前面，一只「净买 ≤ 0 且同时踩了 25% 集中度 / 题材过弱 /
    //    买方仅游资且集中度 >80%」的票，会因为降级分支先命中而被放行成 WATCH——
    //    那等于**用降级规则给其他强制剔除开后门**。降级的含义是
    //    「该票本身没有其他硬伤，只是资金证据不足」，不是「一票否决权豁免」。
    //    注：①新股 与 ③集中度>80% 通常都会同时把 netBuyRate/top3Conc 打穿，
    //    本来就进不了主池，但仍有必要让它们落到 REJECTED——桶决定的是
    //    「能不能被自动下单」，两者必须一致地偏保守。
    //
    // 降级：净买入 ≤ 0 → 备选观察池。**无论是否满足准入，一律不给主池资格**——
    // 主池 = 可自动下单，而这条规则的处置正是「不自动放行、要人工复核」。
    bucket = BUCKET.WATCH;
    text = '降级（不阻断）：龙虎榜净买入 ≤ 0 —— 已扣综合分 '
      + `${LHB_NET_OUTFLOW_PENALTY.SCORE} 分 / 上涨概率 ${LHB_NET_OUTFLOW_PENALTY.PROB} 个百分点，`
      + `进入备选观察池（禁止自动下单）；${FLAG_LHB.NET_OUTFLOW}，人工复核后方可下单。`;
  } else if (allAdmit) {
    bucket = BUCKET.MAIN;
    text = '通过全部强制剔除与准入条件，进入主候选池（可自动下单）。';
  } else {
    bucket = BUCKET.WATCH;
    text = '通过强制剔除，但未满足准入条件（' + unmet.map((x) => x.label).join('；') + '），仅页面展示、禁止自动下单。';
  }

  return {
    code: f.code, name: f.name, bucket, passed,
    rejectedBy, admit: { met, unmet, all: allAdmit },
    // 降级规则（不阻断）：命中 = 该票被打告警标签 + 扣分 + 强制人工复核。
    // needReview 恒为 true（命中即复核），单列一个字段是为了让 UI 不必
    // 自己判断「哪些命中项属于降级类」——那是规则，不是渲染。
    netOutflow,
    flags: netOutflow ? [netOutflow.text] : [],
    needReview: !!netOutflow,
    skipped, features: f, themeStrength,
    sharePct: sharePct != null ? r3(sharePct * 100) : null,
    hotOnlyConc,
    text,
  };
}

/**
 * 批量过滤（规则第五块的过滤部分 + 第八块的结构化输出）。
 * 每只独立校验，单只失败/无记录不影响其他。
 *
 * @returns {{main:Array, watch:Array, rejected:Array, all:Array, summary:object, themeStrength:number|null}}
 */
export function filterBatch(codes, day, opts = {}) {
  const list = (Array.isArray(codes) ? codes : []).map((c) =>
    (c && typeof c === 'object' ? (c.code || c.symbol) : c)).filter(Boolean);
  const all = [];
  const seen = new Set();
  for (const c of list) {
    const k = String(c);
    if (seen.has(k)) continue;      // 去重：同票重复传入不应重复校验
    seen.add(k);
    try {
      all.push(filterOne(k, day, opts));
    } catch (e) {
      all.push({
        code: k, name: k, bucket: BUCKET.REJECTED, passed: false,
        rejectedBy: [{ code: 'FILTER_ERROR', text: '过滤异常：' + (e && e.message || e), value: null }],
        admit: { met: [], unmet: [] }, skipped: [], features: null, themeStrength: null,
        text: '过滤过程异常，按「禁止下单」处理（宁可漏买不可错买）。',
      });
    }
  }
  const by = (b) => all.filter((x) => x.bucket === b);
  const themeStrength = themeStrengthOf(day);
  const review = all.filter((x) => x.needReview);
  return {
    main: by(BUCKET.MAIN),
    watch: by(BUCKET.WATCH),
    rejected: by(BUCKET.REJECTED),
    all,
    themeStrength,
    summary: {
      total: all.length,
      main: by(BUCKET.MAIN).length,
      watch: by(BUCKET.WATCH).length,
      rejected: by(BUCKET.REJECTED).length,
      // 降级规则命中数（龙虎净买 ≤ 0）：不进 rejected，只降级 + 打标签 + 要求人工复核。
      // 单列一个计数是为了让「被降级」在汇总里可见，而不是消失在 watch 的合计里。
      needReview: review.length,
      flaggedCodes: review.map((x) => x.code),
      // 因数据不足未生效的规则清单（去重）
      skippedRules: [...new Set(all.flatMap((x) => (x.skipped || []).map((s) => s.key)))],
    },
  };
}
