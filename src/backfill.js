// 历史回填天的构建逻辑（唯一实现）
//
// 为什么单独成模块而不是留在 scripts/backfill_lhb_history.mjs 里：
//   ① 它是**留下数据**的规则（哪些字段填、哪些字段占位、哪些必须留痕），
//      与抓取/IO 是两件事；混在脚本里就没法单测，守卫也只能看字面量。
//   ② 项目铁律「规则唯一出处」：占位值的语义（_backfill）必须只有一处定义，
//      否则前端过滤、守卫断言、回填脚本会各自演进出不同判据。
//
// ⚠ 本模块只负责「把一天的原始 lhb 记录变成一个可入库的 day 对象」，
//   不写盘、不抓网、不重算分位——那些是脚本的事。

import { normalizeRecord, mergeDuplicateRecords, summarizeCalibers } from './lhb.js';
import { computeSentiment } from './sentiment.js';
import config from './config.js';

// 回填天的标记字段。前端、守卫、报告都读它过滤，**不得各处硬编码字符串**。
export const BACKFILL_FLAG = '_backfill';

/**
 * 由某交易日的原始东财记录构建一个「回填天」。
 *
 * 填什么：
 *   · lhb / lhb_aggr 明细（经 normalize + merge，与正式链路同源）
 *   · summary.lhb_* 全量龙虎榜口径字段（含新股分离的证据链）
 *   · emotion.s_net —— **只有这一个因子**，且必须走 computeSentiment 的同一实现
 * 不填什么：
 *   · 涨跌停池 / 涨跌家数 / 行业板块 / 指数 —— 历史抓不到，一律留空并留痕
 *   · emotion.value 不是综合分，是 s_net 占位（满足 validateArchive 的 0~100 数值要求）
 *
 * @param {string} date  交易日 YYYY-MM-DD
 * @param {Array}  raw   东财原始记录数组（未 normalize）
 * @returns {object} 可直接推进 all_days 的 day 对象
 */
export function buildBackfillDay(date, raw) {
  const normalized = (raw || []).map(normalizeRecord);
  const merged = mergeDuplicateRecords(normalized).sort(
    (a, b) => Math.abs(b.net_buy_wan || 0) - Math.abs(a.net_buy_wan || 0),
  );
  // ⚠ 必须把**合并前**的 normalized 传进 summarizeCalibers：
  //   raw_records（东财原始条数）取的是入参长度；传合并后的数组会让 raw_count 等于合并后条数，
  //   「原始 N → 合并 M」的留痕就退化成 N=M，重复披露再也看不出来。
  //   summarizeCalibers 自己会再合并一次（幂等），所以传原始数组同样得到正确的 merged_away。
  const c = summarizeCalibers(normalized);

  // 只用 s_net 相关入参调用唯一公式实现；其余入参不传 → 对应因子 missing。
  // 我们**不采用**它的 score（那会把 6 个 missing 因子当 0 混进加权），只取 factors.s_net20。
  const sent = computeSentiment({
    netBuy: c.daily_net_yi,
    newStockNet: c.daily_new_net_yi ?? 0,
    newStockRatio: c.daily_new_ratio ?? null,
  }, config.weights);
  const sNet = sent.factors.s_net20;

  const summary = {
    lhb_count: c.total_records,
    lhb_raw_count: c.raw_records,
    lhb_merged_away: c.merged_away,
    lhb_stocks: c.all_stocks,
    lhb_all_net: c.all_net_yi,
    net_pos: c.all_pos,
    net_neg: c.all_neg,
    lhb_daily_stocks: c.daily_stocks,
    lhb_daily_net: c.daily_net_yi,
    lhb_daily_amt: c.daily_amt_yi,
    lhb_range_count: c.range_records,
    lhb_daily_ex_new_net: c.daily_ex_new_net_yi,
    lhb_new_net: c.daily_new_net_yi,
    lhb_new_ratio: c.daily_new_ratio,
    lhb_new_count: c.daily_new_count,
    lhb_new_stocks: c.daily_new_stocks,
    // 未采集的字段显式写 0/留痕，**绝不伪造**——ind_count=0 同时让 recalcAll 的 hasRaw 判据
    // 能识别出「这天没有行业数据」，而不是把 0 当成真实值参与行业涨比。
    ind_count: 0,
    backfilled: true,
  };

  return {
    trade_date: date,
    lhb: merged,
    hot: [],
    topics: [],
    industry: [],
    indexes: null,
    summary,
    emotion: {
      value: sNet,
      score: sNet,
      s_net: sNet,
      lhb_daily_net: c.daily_net_yi,
      newStock: sent.newStock,
      missing: sent.missing,
      imputedRatio: sent.imputedRatio,
      [BACKFILL_FLAG]: true,
    },
  };
}

/** 展示层过滤判据的唯一出处：这一天是否只有回填数据。 */
export function isBackfillDay(d) {
  return !!(d && d.emotion && d.emotion[BACKFILL_FLAG]);
}
