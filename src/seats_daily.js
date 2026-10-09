// ── 席位/资金属性逐日累积（唯一出处）────────────────────────────────────────────
//
// 回答的问题：**谁在买**（机构 / 游资 / 北向），而不是**买多少**。
//   · 机构主导 → 趋势票；游资主导 → 情绪票。两者的持有周期与风险完全不同。
//   · 现在 s_net 只算"净买总额"，把这三类资金混成一个数，等于把两种策略的票
//     当成同一种。这是本模块要补的分辨率。
//
// ⚠ 为什么必须"逐日累积"而不是"一次回填"（这是数据源的硬约束，不是设计偏好）：
//   龙虎榜席位明细来自东财 RPT_BILLBOARD_DAILYDETAILSBUY/SELL，**只对最近若干交易日
//   有效**——实测涨停池/席位类接口只有最近 2 个交易日的历史，更早的日期返回空。
//   因此 241 天全档里只有 2026-09-28/29/30 三天有 summary.seats。
//   ⇒ 想要席位属性的**时间序列**，唯一办法是从今天起**每天在收盘管线里 append 一行**，
//     让历史自然生长。本模块就是那支"每天写一行"的笔。
//
// 三条纪律（与 src/health.js、src/pain.js 同）：
//   1. **只读不造**：聚合口径（哪些席位算机构/北向/游资）的唯一出处是 src/seats.js
//      与 src/sources.js::classifySeat。本模块**不重新分类**，只搬运+对齐。
//   2. **缺失显式化**：当天没有 summary.seats（未抓/未发布）时，该行的净额为 null，
//      不得填 0——"净买 0"（多空抵消）与"没数据"含义相反。
//   3. **口径一致**：净额一律 = 买 − 卖（同侧同源）。缺卖侧（旧 v1 明细只有买方）时
//      净额为 null，只保留买入额，并显式标记 hasSell=false。

/** 席位三类（与 sources.js::classifySeat 的 inst/north/hot 一一对应） */
export const SEAT_CLASSES = ['inst', 'north', 'hot'];

export const SEAT_CLASS_LABEL = {
  inst: '机构专用',
  north: '沪深股通（北向）',
  hot: '游资/其他（营业部·分公司·自营）',
};

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
// ⚠ 必须先判 `v == null`：`Number.isFinite(+null)` 为 true（+null===0），
//   只写 Number.isFinite(+v) 会让 null 变成 0，进而把"没数据"算成"多空抵消"。
//   （同一陷阱在 src/alerts.js / src/lhbfilter.js 都有记录，此处对齐同一纪律。）
const num = (v) => (v == null || v === '' ? null : (Number.isFinite(+v) ? +v : null));

/**
 * 从单日存档提取席位列（一行）。
 *
 * @param {object} day 存档天（需 summary.seats）
 * @returns {object} 该日的席位列；无数据时各项为 null 并置 ok=false
 */
export function seatRowOf(day) {
  const date = (day && day.trade_date) || null;
  const s = (day && day.summary && day.summary.seats) || null;
  if (!s || s.cover == null) {
    return {
      date, ok: false,
      // 全部 null：显式"未知"，绝不写 0
      instNet: null, northNet: null, hotNet: null,
      instBuy: null, instSell: null, northBuy: null, northSell: null, hotBuy: null, hotSell: null,
      cover: null, universeN: null, buyTop3Pct: null,
      // 主导方（谁净买最多）——无数据时为 null，不是"hot"
      dominant: null, note: s ? null : '当日无席位明细（接口仅保留最近数日）',
    };
  }
  const instBuy = num(s.inst_buy), instSell = num(s.inst_sell);
  const northBuy = num(s.north_buy), northSell = num(s.north_sell);
  const hotBuy = num(s.hot_buy), hotSell = num(s.hot_sell);
  // 净额只在**双侧齐备**时给出：只有买侧（旧 v1）算不出净额，猜一个等于造假。
  const hasSell = [instSell, northSell, hotSell].every((v) => v != null);
  const instNet = hasSell ? r2(instBuy - instSell) : null;
  const northNet = hasSell ? r2(northBuy - northSell) : null;
  const hotNet = hasSell ? r2(hotBuy - hotSell) : null;

  // 主导资金：三类净额里最大的那个（都 ≤0 时返回 null——没有"主导买方"）
  let dominant = null;
  const nets = { inst: instNet, north: northNet, hot: hotNet };
  const maxNet = Math.max(...Object.values(nets).filter((v) => v != null));
  if (Number.isFinite(maxNet) && maxNet > 0) {
    dominant = SEAT_CLASSES.find((k) => nets[k] === maxNet) || null;
  }

  return {
    date, ok: true,
    instNet, northNet, hotNet,
    instBuy: r2(instBuy), instSell: r2(instSell),
    northBuy: r2(northBuy), northSell: r2(northSell),
    hotBuy: r2(hotBuy), hotSell: r2(hotSell),
    cover: num(s.cover),
    universeN: num(s.universe_n),
    buyTop3Pct: num(s.buy_top3_pct),
    hasSell,
    dominant,
    note: hasSell ? null : '仅买方明细（旧格式），净额不可算',
  };
}

/**
 * 把归档天数组折叠成席位属性时间序列。**幂等**：同一天重复调用结果一致，
 * 便于"每天 append"与"整档重建"两种用法共用同一函数。
 *
 * ⚠ 默认**只保留有数据的天**（ok=true）。原因不只是体积（241 行里 238 行全 null
 *   会让 signals 从 14KB 涨到 74KB，直接击穿"轻量档"预算），更因为 null 行**不含信息**：
 *   它表达的是"这天没抓/接口不给"，而这件事已经由 series 的起止日期 + coverage 字段说清了。
 *   保留 238 个 null 既浪费带宽，又容易让人误读成"这 238 天资金是均衡的"。
 *   需要"对齐到完整交易日轴"的调用方请传 alignDates。
 *
 * @param {Array<object>} days 存档天数组（按日期升序）
 * @param {object} [opts] { alignDates: Array<string> } 给出后按该日期轴对齐（含 null 行）
 * @returns {Array<object>} 每行一个交易日
 */
export function buildSeatSeries(days, opts = {}) {
  const rows = (Array.isArray(days) ? days : []).map(seatRowOf);
  if (Array.isArray(opts.alignDates) && opts.alignDates.length) {
    const map = new Map(rows.map((r) => [r.date, r]));
    return opts.alignDates.map((d) => map.get(d) || seatRowOf({ trade_date: d }));
  }
  return rows.filter((r) => r.ok);
}

/**
 * 序列级统计：给"近 N 日机构是否在持续买入"这类判断提供原料。
 * 只统计 ok=true 的行；全无数据时各值 null。
 *
 * @param {Array<object>} series buildSeatSeries 的输出
 * @param {object} [opts] { window } 近 N 行（默认全部）
 */
export function seatSeriesSummary(series, opts = {}) {
  const rows = Array.isArray(series) ? series : [];
  const win = Number.isFinite(+opts.window) && +opts.window > 0 ? rows.slice(-Math.floor(+opts.window)) : rows;
  const okRows = win.filter((r) => r && r.ok);
  const pick = (k) => okRows.map((r) => r[k]).filter((v) => v != null);

  const agg = (k) => {
    const v = pick(k);
    if (!v.length) return { n: 0, sum: null, mean: null, last: null };
    return { n: v.length, sum: r2(v.reduce((x, y) => x + y, 0)), mean: r2(v.reduce((x, y) => x + y, 0) / v.length), last: v[v.length - 1] };
  };

  // 主导方分布：近窗内机构/北向/游资各占几天
  const domCount = { inst: 0, north: 0, hot: 0 };
  for (const r of okRows) if (r.dominant) domCount[r.dominant]++;

  // 覆盖率的分母：buildSeatSeries 默认已滤掉无数据的天，故 totalRows 不等于"交易日数"。
  //   调用方若知道完整交易日数（archive.all_days.length）应通过 opts.totalDays 传入，
  //   否则覆盖率会虚高成 100%，读者会误以为"席位数据很全"。取不到就返回 null（"未知"），
  //   不返回 1.0 —— 后者是**错的**，不是保守的。
  const totalDays = Number.isFinite(+opts.totalDays) && +opts.totalDays > 0 ? Math.floor(+opts.totalDays) : null;

  return {
    totalRows: rows.length,
    okRows: okRows.length,
    window: win.length,
    totalDays,
    instNet: agg('instNet'),
    northNet: agg('northNet'),
    hotNet: agg('hotNet'),
    dominant: domCount,
    coverage: totalDays ? r2(okRows.length / totalDays) : null,
    firstDate: okRows.length ? okRows[0].date : null,
    lastDate: okRows.length ? okRows[okRows.length - 1].date : null,
  };
}

/**
 * 一句话结论：当前是机构主导还是游资主导。
 * 用最近一行（最新交易日）的净额比较，缺数据返回 unknown。
 */
export function seatVerdict(series) {
  const rows = (Array.isArray(series) ? series : []).filter((r) => r && r.ok && r.instNet != null);
  if (!rows.length) return { level: 'unknown', label: '未知', reason: '无席位明细数据，资金属性无法判定' };
  const last = rows[rows.length - 1];
  const nets = [['inst', last.instNet], ['north', last.northNet], ['hot', last.hotNet]]
    .filter(([, v]) => v != null).sort((a, b) => b[1] - a[1]);
  if (!nets.length || nets[0][1] <= 0) {
    return { level: 'unknown', label: '无主导买方', reason: `${last.date} 三类资金净买均 ≤0（普遍净卖出）`, date: last.date };
  }
  const [key, val] = nets[0];
  const level = key === 'inst' ? 'inst' : key === 'north' ? 'north' : 'hot';
  const tail = key === 'hot' ? '，偏情绪/接力属性' : '，偏趋势/配置属性';
  return {
    level, label: `${SEAT_CLASS_LABEL[key]}主导`,
    reason: `${last.date} ${SEAT_CLASS_LABEL[key]}净买 ${val} 亿${tail}`,
    date: last.date,
  };
}
