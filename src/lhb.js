// 龙虎榜口径唯一来源 —— 东财一次披露里混装两类榜单，任何地方都不得绕过本模块自行相加。
//
// ① 当日榜（reason 不含「连续N个交易日…」「严重异常期间…」）
//    席位买卖即当日口径，官方 BILLBOARD_DEAL_AMT 等于 买 + 卖。
//    → 这是「当日龙虎净买额」的唯一权威口径：日度情绪因子、净买率、新股扰动一律用它。
// ② 区间累计榜（reason 含「连续3/10个交易日涨跌幅偏离值累计达X%」「严重异常期间…」）
//    统计的是整个区间的累计值，且 BILLBOARD_BUY_AMT 被填成区间累计成交额
//    （实测 2026-09-30 近岸蛋白 688137 十日榜：BUY == SELL == ACCUM_AMOUNT == 116.97 亿、净额 0）。
//    → 只做单列诊断，禁止混入当日口径。
//
// 混用的后果（2026-09-30 实测）：
//   · 量级错：全部 84 条未去重合计 511.1 亿，当日榜去重仅 136.5 亿（3.7 倍），净买率被稀释成 2.4%（真实 5.7%）
//   · 更隐蔽的因子偏移：同票去重规则取 |净额| 最大者，区间累计值会顶替当日值（当日 9 只、净额差 3.12 亿），
//     使「日度」因子把三天累计当成一天。实测 2026-09-08 当日榜净买仅 -0.11 亿，全量口径却是 +13.42 亿，
//     s_net 因子因此从 48.9 被抬到 99.5（tanh 饱和），33 天里 13 天被顶到 100，几乎失去分辨力。

// 区间累计榜的判别式（两处以上使用，必须共用同一个正则，避免各写一份而口径漂移）
export const RANGE_BOARD_RE = /连续\s*[0-9一二三四五六七八九十]+\s*个交易日|严重异常期间/;

export function isRangeBoard(reason) {
  return RANGE_BOARD_RE.test(String(reason || ''));
}

// ── 新股/无涨跌幅限制标的判定（唯一出处）────────────────────────────────
//
// 东财榜单给出的上榜诱因里，新股/次新走的是「无价格涨跌幅限制的证券」这一条
// （上市首 5 日不设涨跌幅，与普通个股 ±10%/±20% 的板段不可比）。
//
// 为什么必须从 s_net 里剔除（2026-09-30 实测，这是本规则唯一的存在理由）：
//   · 当日榜净买 +7.74 亿里，力勤资源(001246) 一只贡献 +5.04 亿，占 65%；
//   · s_net 因子 = tanh(净买/5)*50+50，7.74 亿已推高到 95.7（接近满分）；
//   · 剔掉这一只后剩 −0.91 亿，因子应为 41.0（由强转弱）——分值虚高 54.7，情绪分虚高 8.58 分；
//   · 新股首日换手极高、筹码未沉淀，其大额净买衡量的是「打新资金出货承接」，
//     不是二级市场存量资金的进攻意愿，混入即把「新股放量」误读成「游资进攻」。
//
// 判定必须看 reasons 全部上榜原因（同票可因多个原因上榜），不能只看代表那条。
export const NEW_STOCK_RE = /无价格涨跌幅限制/;

// 一条（通常为已聚合、带 reasons 数组的）记录是否属于新股/无涨跌幅限制
export function isNewStock(l) {
  if (!l) return false;
  const list = Array.isArray(l.reasons) && l.reasons.length ? l.reasons : [l.reason || ''];
  return list.some((r) => NEW_STOCK_RE.test(String(r)));
}

// 从「当日榜去重行」里分离新股与存量个股的净买额（单位：亿）。
// 口径纪律：分子分母都用同一份 rows（必须是当日榜 daily_aggr），不得一处用明细、一处用汇总。
//   剔新股净买 = 全部当日榜净买 − 新股净买
//   ratio      = 新股净买 / 全部当日榜净买（分母 ≤0 时无意义，返回 null）
// 注意「新股净买为负」的情形：此时剔新股后净买反而更高，不做人为截断，如实返回。
export function splitNewStockNet(dailyRows) {
  const rows = Array.isArray(dailyRows) ? dailyRows : [];
  const delisted = [], kept = [];
  for (const l of rows) (isNewStock(l) ? delisted : kept).push(l);
  const totalYi = r2(sumOf(rows, (l) => l.net_buy_wan) / 1e4);
  const newYi = r2(sumOf(delisted, (l) => l.net_buy_wan) / 1e4);
  const exNewYi = r2(totalYi - newYi);
  return {
    total_yi: totalYi,                                   // 含新股的当日榜净买（未修正口径）
    new_yi: newYi,                                       // 新股贡献的净买
    ex_new_yi: exNewYi,                                  // ← 喂 s_net 的唯一口径
    new_stocks: delisted.map((l) => ({ code: l.code, name: l.name, net_yi: r2((l.net_buy_wan || 0) / 1e4) })),
    total_stocks: rows.length,
    new_count: delisted.length,
    ratio: totalYi > 0 ? r2(newYi / totalYi) : null,     // 占当日榜净买比例
  };
}

// 新股扰动熔断线：占比 > 25% 视为显著扰动，报告必须显式标注「因子已自动剔除」。
// 该阈值沿用 app.js 报告端既有的 25% 告警线，不再另立新阈值。
export const NEW_STOCK_DISTURB_RATIO = 0.25;

// 判定某日是否触发新股扰动熔断（ratio 缺省视为未触发）
export function isNewStockDisturbed(ratio) {
  return ratio != null && ratio > NEW_STOCK_DISTURB_RATIO;
}

// 从某个 day 对象取「当日榜去重行」并完成新股分离。
// 直接复用 caliberFromDay —— 它已收敛了「明细优先 / 原始记录次之 / 聚合兜底」三级回退，
// 本函数不再自行拼接数组：早先版本对未去重的 lhb_aggr 再跑一次 aggregateByCode，
// 会因「同票取 |净额| 最大者」把区间累计榜顶替当日榜（33 天里 30 天数值偏离），
// 与 511 亿事件是同一个坑。
export function newStockSplitOfDay(day) {
  const c = caliberFromDay(day);
  return splitNewStockNet(c.daily_aggr);
}

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

// 规范化一条原始记录（东财字段 → 内部字段）。is_range / caliber 在此定死，下游不再自行判断。
//
// reasons 数组化（而不是只留一个 reason 字符串）：
//   东财同一次披露里，**同一只票会因多个上榜标准各出一条记录**，且这两条的数值往往**完全相同**
//   （2026-08-14 蓝盾光电 300862：出现两次，"日涨幅达到15%的前5只证券" 与 "日换手率达到30%的前5只证券"，
//    net=37382.3 / buy=69254.9 / sell=31872.6 逐字段一致）。下游任何按 code 求和都会双算。
//   判定必须看全部上榜原因：新股识别（NEW_STOCK_RE）就依赖它——同票可能一条是普通榜、一条是
//   "无价格涨跌幅限制的证券"，只留代表那条会漏判。
export function normalizeRecord(x) {
  const reason = x.EXPLANATION || '—';
  return {
    code: x.SECURITY_CODE,
    name: x.SECURITY_NAME_ABBR,
    reason,
    reasons: [reason],
    close: x.CLOSE_PRICE,
    change_pct: r2(x.CHANGE_RATE || 0),
    net_buy_wan: r1((x.BILLBOARD_NET_AMT || 0) / 1e4),
    buy_wan: r1((x.BILLBOARD_BUY_AMT || 0) / 1e4),
    sell_wan: r1((x.BILLBOARD_SELL_AMT || 0) / 1e4),
    // 东财官方「龙虎榜成交额」：当日榜等于 买+卖；区间榜里与被污染的 BUY_AMT 不同源，故单独取用
    deal_wan: r1((x.BILLBOARD_DEAL_AMT || 0) / 1e4),
    turnover_pct: r2(x.TURNOVERRATE || 0),
    is_range: isRangeBoard(reason),
  };
}

// ── 同口径同值合并（唯一实现）────────────────────────────────────────────────
//
// 为什么必须做：东财「一次披露」里同票多榜是常态，且**数值常常一模一样**。这些记录不是"区间累计"，
// 就是同一天的同一笔钱被两个上榜标准各记了一次。直接落进 lhb 数组，下游任何 `reduce(净买)`
// 都会把同一只票算两遍——而 lhb 原始数组正是 picks / paper / lhbfilter / fetch_universe 的入口。
//
// 合并判据是「**五元组完全相同**」而不是「code 相同」：
//   (code, is_range, net_buy_wan, buy_wan, sell_wan)
//   为什么不能只按 code：同一只票可能**同时**上当日榜与区间累计榜，两者数值本就不同、口径也不同
//   （2026-08-14 中际联合 603118：区间榜 net=22850.6 / 当日榜 net=7894.4）。
//   把它们合并成一个数，等于凭空在「当日值」与「三日累计值」之间二选一，两边都错。
//
// 为什么用「五元组同值」而不是更粗的 (code, is_range)：
//   同一只票在同一口径下**确实**可能出现两条数值不同的记录（东财按上榜标准分别披露）。
//   那种情形下"该求和还是该取代表"没有唯一正确答案，故**一律保持原样、不合并**，
//   由下游（aggregateByCode 取 |净额| 最大者为代表）统一处置——合并层的职责只有一件事：
//   **消灭逐字段完全相同的重复**，不替下游做口径决策。
//
// 合并结果：reasons 数组化为全部上榜原因（去重、保持首次出现顺序），
//   reason 保留第一条（与 is_range 判定同源，不会出现"诱因为区间榜、数值是当日值"的错配——
//   因为参与合并的记录 is_range 必然相同）。
export const MERGE_KEY_FIELDS = ['is_range', 'net_buy_wan', 'buy_wan', 'sell_wan'];

function mergeKeyOf(l) {
  return [l.code, ...MERGE_KEY_FIELDS.map((f) => (f === 'is_range' ? (l.is_range ? 1 : 0) : l[f]))].join('\u0001');
}

export function mergeDuplicateRecords(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byKey = new Map();
  const out = [];
  for (const l of list) {
    if (!l || !l.code) continue;
    const rs = Array.isArray(l.reasons) && l.reasons.length ? l.reasons : (l.reason ? [l.reason] : []);
    const key = mergeKeyOf(l);
    const prev = byKey.get(key);
    if (!prev) {
      const rec = { ...l, reason: l.reason ?? (rs[0] || '—'), reasons: [...new Set(rs)] };
      byKey.set(key, rec);
      out.push(rec);
      continue;
    }
    // 重复条目：只并入上榜原因，数值/诱因代表一律不动（同值，动了反而制造差异）
    for (const r of rs) if (r && !prev.reasons.includes(r)) prev.reasons.push(r);
  }
  return out;
}

// 供守卫与测试使用：合并后的记录必须满足「五元组唯一」——重复即说明合并层失效。
export function duplicateKeys(rows) {
  const seen = new Set(); const dup = [];
  for (const l of Array.isArray(rows) ? rows : []) {
    if (!l || !l.code) continue;
    const k = mergeKeyOf(l);
    if (seen.has(k)) dup.push(k.split('\u0001').join('/'));
    seen.add(k);
  }
  return dup;
}

// 同票多榜（同一只票因不同上榜原因出现多条）→ 每股一笔，取 |净额| 最大的那条为代表。
// 同时记录该笔来自哪类榜单（caliber），供 UI 标注「区间」，避免把区间累计值当日度值读。
//
// 前置假设：入参**已经过 mergeDuplicateRecords**（逐字段完全相同的重复已消失）。
// 因此这里剩下的"同票多条"必然数值不同，`reasons` 只需并集、不需要再判重合并。
// 仍然对 reasons 做兜底初始化，允许调用方直接喂未经合并的原始记录（测试与存量重算路径）。
export function aggregateByCode(rows) {
  const byCode = new Map();
  for (const l of rows) {
    const rs = Array.isArray(l.reasons) && l.reasons.length ? l.reasons : [l.reason];
    const prev = byCode.get(l.code);
    if (!prev) {
      byCode.set(l.code, { ...l, reasons: [...new Set(rs)], caliber: l.is_range ? 'range' : 'daily' });
      continue;
    }
    for (const r of rs) if (r && !prev.reasons.includes(r)) prev.reasons.push(r);
    if (Math.abs(l.net_buy_wan || 0) > Math.abs(prev.net_buy_wan || 0)) {
      // 换代表：reason / 买卖额 / 净额 / 榜单类型一起替换，保证「显示的诱因」与「显示的数值」同源。
      // 早先只换了数值没换 reason，会出现「诱因写着日涨幅偏离7%，数值却是连续3日累计」的错配。
      prev.reason = l.reason;
      prev.net_buy_wan = l.net_buy_wan;
      prev.buy_wan = l.buy_wan;
      prev.sell_wan = l.sell_wan;
      prev.deal_wan = l.deal_wan;
      prev.caliber = l.is_range ? 'range' : 'daily';
      prev.is_range = l.is_range;
    }
  }
  return [...byCode.values()];
}

const sumOf = (rows, f) => rows.reduce((a, l) => a + (f(l) || 0), 0);

// 成交额取值：优先东财官方 BILLBOARD_DEAL_AMT；存量老记录没这个字段，
// 而当日榜记录的 DEAL 恒等于 买+卖（已对源核验），故回退用买+卖。
// 注意：区间榜的 买+卖 是被污染的区间累计值，所以下面的 daily 汇总只喂当日榜记录，回退是安全的。
const dealOf = (l) => (l.deal_wan != null ? l.deal_wan : (l.buy_wan || 0) + (l.sell_wan || 0));

// 双口径汇总（唯一实现）。返回的字段一律带口径后缀，调用方无法含糊其辞。
//   daily.* —— 当日榜：权威口径，用于日度因子 / 净买率 / 新股扰动
//   all.*   —— 全量（含区间累计榜）：只做单列诊断与「上榜个股数」这类外部可核对的家数统计
//
// 入参约定：records 既可以是**原始记录**（未合并），也可以是 mergeDuplicateRecords 的产物。
// 为杜绝"调用方忘了合并"导致的静默双算，本函数**自己先合并一遍**（幂等：已合并的再合并是恒等变换），
// 并把合并前后的条数一并返回（raw_records / merged_records / merged_away），供审计与报告留痕。
export function summarizeCalibers(records) {
  const raw = Array.isArray(records) ? records : [];
  const merged = mergeDuplicateRecords(raw);
  const daily = merged.filter((l) => !l.is_range);
  const allAggr = aggregateByCode(merged);
  const dailyAggr = aggregateByCode(daily);
  const seg = splitNewStockNet(dailyAggr);
  return {
    // 当日榜
    daily_stocks: dailyAggr.length,
    daily_net_yi: r2(sumOf(dailyAggr, (l) => l.net_buy_wan) / 1e4),
    daily_amt_yi: r2(sumOf(dailyAggr, dealOf) / 1e4),
    daily_aggr: dailyAggr,
    // 当日榜 · 剔除新股/无涨跌幅限制标的（喂 s_net 的唯一口径）
    //   为什么必须在汇总层就分开：s_net = tanh(净买/5)*50+50 在 5 亿量级近饱和，
    //   一笔新股大额净买就能把因子从「转弱」推到「接近满分」（2026-09-30 实测虚高 54.7 分）。
    daily_ex_new_net_yi: seg.ex_new_yi,
    daily_new_net_yi: seg.new_yi,
    daily_new_ratio: seg.ratio,
    daily_new_stocks: seg.new_stocks,
    daily_new_count: seg.new_count,
    // 全量（诊断）
    all_stocks: allAggr.length,
    all_net_yi: r2(sumOf(allAggr, (l) => l.net_buy_wan) / 1e4),
    all_pos: allAggr.filter((l) => l.net_buy_wan > 0).length,
    all_neg: allAggr.filter((l) => l.net_buy_wan < 0).length,
    all_aggr: allAggr,
    // 口径元信息
    //   total_records / range_records 一律以**合并后**为准：合并前东财会因「同票多榜」重复披露，
    //   用原始条数会让 `区间条数 = 全部 − 当日` 这条恒等式在重复票上失配（历史审计因此报错）。
    total_records: merged.length,
    raw_records: raw.length,
    merged_records: merged.length,
    merged_away: raw.length - merged.length,
    range_records: merged.length - daily.length,
  };
}

// 从已落盘的 day 对象重算双口径（历史批量重算专用，与实时抓取走同一套实现）。
// 存量记录可能没有 is_range / deal_wan：前者用 reason 现判，后者按当日榜等式回退。
export function caliberFromDay(day) {
  // ① 明细优先：lhb_daily_aggr 已是「当日榜 + 去重」的行（新数据都有）。
  //    直接喂 splitNewStockNet，不再二次 aggregateByCode —— 它是聚合产物，不是原始记录。
  if (Array.isArray(day?.lhb_daily_aggr) && day.lhb_daily_aggr.length) {
    const rows = day.lhb_daily_aggr;
    const aggr = Array.isArray(day?.lhb_aggr) ? day.lhb_aggr : rows;
    // 条数一律现算：lhb_daily_aggr + lhb_aggr 已是**合并去重后的聚合产物**，
    // 两者条数之和恰好等于「合并后记录数」（每只票在每类口径下必有一条代表）。
    // 早先用 `day.lhb.length`（原始数组长度）会让 `区间条数 = 全部 − 当日` 在「同票多榜」上失配。
    const totalRec = rows.length + aggr.length;
    const seg = splitNewStockNet(rows);
    const dailyNet = r2(sumOf(rows, (l) => l.net_buy_wan) / 1e4);
    return {
      daily_stocks: rows.length,
      daily_net_yi: dailyNet,
      daily_amt_yi: r2(sumOf(rows, dealOf) / 1e4),
      daily_aggr: rows,
      daily_ex_new_net_yi: seg.ex_new_yi,
      daily_new_net_yi: seg.new_yi,
      daily_ratio_or_null: seg.ratio,
      daily_new_ratio: seg.ratio,
      daily_new_stocks: seg.new_stocks,
      daily_new_count: seg.new_count,
      all_stocks: aggr.length,
      all_net_yi: ((day?.summary || {}).lhb_all_net != null) ? day.summary.lhb_all_net
        : r2(sumOf(aggr, (l) => l.net_buy_wan) / 1e4),
      all_pos: ((day?.summary || {}).net_pos != null) ? day.summary.net_pos : null,
      all_neg: ((day?.summary || {}).net_neg != null) ? day.summary.net_neg : null,
      all_aggr: aggr,
      total_records: totalRec,
      raw_records: totalRec,
      merged_records: totalRec,
      merged_away: 0,
      range_records: aggr.length - rows.length,
    };
  }
  const rows = Array.isArray(day?.lhb) ? day.lhb : [];
  if (rows.length) {
    const norm = rows.map((l) => ({
      ...l,
      reasons: Array.isArray(l.reasons) && l.reasons.length ? l.reasons : (l.reason ? [l.reason] : []),
      is_range: l.is_range != null ? l.is_range : isRangeBoard(l.reason),
    }));
    return summarizeCalibers(norm);
  }
  // 无原始记录（极早期种子天）：退化为用已聚合数组，但仍按 reason 判口径，绝不混算
  const aggr = Array.isArray(day?.lhb_aggr) ? day.lhb_aggr : [];
  const norm = aggr.map((l) => ({
    ...l,
    reasons: Array.isArray(l.reasons) && l.reasons.length ? l.reasons : (l.reason ? [l.reason] : []),
    is_range: l.is_range != null ? l.is_range : isRangeBoard(l.reason),
  }));
  return summarizeCalibers(norm);
}

// 取某日的「当日榜」去重行（报告与主线占比共用，避免各自重新过滤时漏掉口径判断）
export function dailyRowsOf(day) {
  return caliberFromDay(day).daily_aggr;
}
