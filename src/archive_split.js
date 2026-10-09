// archive 切片：把完整档案拆成「索引 + 按年分片 + 近 N 日滚动窗」
//
// ── 为什么拆 ────────────────────────────────────────────────────────────────
// archive.json 已到 7.6MB（241 天），其中 lhb 明细占 80%。前端每次首屏全量拉，
// 半年后就是十几 MB，首屏必然卡。而首屏真正需要的只有**最新一天**。
//
// 实际分层（用户要求的三档：最新日 → 近 30 天 → 全档）：
//   · archive-index.json   —— 元信息 + 年份列表 + 最新日摘要（**10.5KB**），首屏必拉
//   · archive-recent.json  —— 近 30 日：29 个"曲线点" + 最新日完整明细（**~40KB**），
//                             开走势图/渲染表格时才拉
//   · archive-YYYY.json    —— 该年完整数据（几百 KB ~ MB），详情抽屉要回看时才拉
//   · archive.json         —— 完整档（脚本/审计/回测用），前端**不再**拉
//
// ⚠ 这是**纯函数模块**：不读盘不写盘。落盘由调用方（src/pipeline.js writeArchive、
//   scripts/split_archive.mjs）负责，便于单测与守卫。
//
// ⚠ 分片必须与主档**同源**：切片永远由 writeArchive 从刚写好的 archive 对象生成，
//   绝不允许"单独跑一次切片脚本"成为常规路径——那会让两个文件各自演化、
//   页面与脚本看到不同的数据（最坏情况是分位与因子对不上，且没人发现）。
//
// ⚠ 入参 archive 是**已序列化态**（lhb 已码表压缩、惰性字段已在 `_sub`）：
//   本模块只做"搬运/裁剪"，不碰 reason 也不解 `_sub`。
//   **唯一例外**：滚动窗最新日补 `lhb_aggr` 时，因为要交给聚合函数（它按 reason 文本
//   判新股/区间榜），必须先把 `rc` 码表下标还原成明文——见下方 decodeRcRows 与其长注。
//   除此之外模块仍不依赖业务代码（码表取自 archive.meta，不 import lhb_codec）。
//   语义见 src/lhb_codec.js。

/** 每年分片的年键（按 trade_date 的年份）。跨年档案天然落到不同文件。 */
export function yearOf(tradeDate) {
  return String(tradeDate || '').slice(0, 4);
}

/**
 * 把**压缩态**的 lhb 记录行还原成明文 reason（`rc:[i]` → `reasons:[code]`）。
 *
 * 为什么需要：入参 archive 里 reason 是码表下标（`rc`）。聚合函数 aggregateByCode 的产物
 *   会被前端拿去判「新股」（isNewStock 只认 reasons/reason 文本里的
 *   "无价格涨跌幅限制的证券"）与「区间累计榜」（RANGE_BOARD_RE 认 reasons 文本）。
 *   若拿 rc 形态聚合，产物会是 `reasons:[null]`，两类判定**双双击穿**，且不报错——
 *   表现是界面静默少了标记（实测：check_frontend 的「新股」标记断言因此变红）。
 *
 * 与 lhb_codec.decodeDay 同一套语义（`rc` 每一项查码表，取不到则丢弃；`reason` 取首项）。
 *   此处**不复用** decodeDay 是为了保持本模块零 import；逻辑很短，且单一职责
 *   （只处理"一行记录"这一件事）。
 * 已是明文（无 `rc`）的行原样返回——兼容未压缩的存量档。
 */
function decodeRcRows(rows, codes) {
  return rows.map((l) => {
    if (!l || !Array.isArray(l.rc)) return l;
    const reasons = l.rc.map((i) => codes[i]).filter((x) => typeof x === 'string');
    const { rc, ...rest } = l;
    return { ...rest, reasons, reason: reasons[0] ?? '—' };
  });
}

/**
 * 每年摘要：让首屏在只拉 index 的情况下就能画年份导航、甚至粗略走势。
 * 只放**聚合值**，不放任何明细——明细是分片的职责。
 */
export function yearSummary(days) {
  const list = Array.isArray(days) ? days : [];
  if (!list.length) return null;
  const values = list.map((d) => d.emotion?.value ?? d.emotion?.score ?? null).filter((v) => typeof v === 'number');
  const bias = list.map((d) => d.emotion?.breadth_bias ?? null).filter((v) => typeof v === 'number');
  const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
  return {
    days: list.length,
    fullDays: list.filter((d) => !(d.emotion && d.emotion._backfill)).length,
    backfillDays: list.filter((d) => d.emotion && d.emotion._backfill).length,
    from: list[0].trade_date,
    to: list[list.length - 1].trade_date,
    valueMin: values.length ? Math.min(...values) : null,
    valueMax: values.length ? Math.max(...values) : null,
    valueAvg: avg(values),
    biasBiasMin: bias.length ? Math.min(...bias) : null,
    biasMax: bias.length ? Math.max(...bias) : null,
  };
}

/**
 * 生成索引文件：轻到可以随首屏无条件拉取。
 *
 * 刻意**不含**任何 all_days 明细：索引一旦变肥，拆分的意义就没了。
 * 体积守卫（scripts/audit_lhb_caliber.mjs B9）会断言 < 36KB（32→36 重估：P2-β 渲染接线）。
 */
export function buildIndex(archive) {
  const days = (archive && archive.all_days) || [];
  const years = [...new Set(days.map((d) => yearOf(d.trade_date)))].filter(Boolean).sort();
  const yearMeta = {};
  for (const y of years) {
    yearMeta[y] = yearSummary(days.filter((d) => yearOf(d.trade_date) === y));
  }
  const latest = days[days.length - 1] || null;
  return {
    kind: 'archive-index',
    version: 1,
    meta: archive?.meta || {},
    signals: archive?.signals || {},
    totalDays: days.length,
    years,
    yearMeta,
    // 最新一天的**摘要级**信息：让首屏不必等分片就能渲染关键指标。
    // 明细（lhb/hot/industry）一律不放——那是分片的内容。
    latestDate: latest ? latest.trade_date : null,
    latest: latest ? latestBrief(latest) : null,
    // 惰性字段体积提示：前端据此在 UI 上显示"席位明细需另拉"，而不是把它当成"没有席位"。
    lazy: lazyBrief(latest),
  };
}

/**
 * 最新日**未随首屏传输**的惰性字段清单（字节数）。
 *
 * 存在的意义不只是省流量：席位明细被提走后，`summary.seats` 会是 null，
 * 前端若直接渲染就会把「有 66 只有席位明细」显示成「无数据」——这是**假阴性**，
 * 比缺数据更糟。故必须让前端有办法知道「不是没有，是还没拉」。
 */
export function lazyBrief(d) {
  if (!d || !d._sub) return null;
  const out = {};
  for (const k of Object.keys(d._sub)) {
    out[k] = Buffer.byteLength(JSON.stringify(d._sub[k] ?? null), 'utf8');
  }
  return Object.keys(out).length ? out : null;
}

/** 单日摘要：首屏渲染所需的最小集合（不含任何明细数组）。 */
export function latestBrief(d) {
  if (!d) return null;
  const e = d.emotion || {};
  const s = d.summary || {};
  return {
    trade_date: d.trade_date,
    value: e.value ?? e.score ?? null,
    pct_rank: e.pct_rank ?? null,
    net_daily_pct_rank: e.net_daily_pct_rank ?? null,
    factors: e.factors || null,
    missing: e.missing || null,
    imputedRatio: e.imputedRatio ?? null,
    backfill: !!(e._backfill),
    lhb_daily_net: s.lhb_daily_net ?? null,
    lhb_stocks: s.lhb_stocks ?? null,
    lhb_daily_stocks: s.lhb_daily_stocks ?? null,
    zt_count: s.zt_count ?? null,
    dt_count: s.dt_count ?? null,
    zb_count: s.zb_count ?? null,
    up_count: s.up_count ?? null,
    down_count: s.down_count ?? null,
    flat_count: s.flat_count ?? null,
    // 口径披露（固定口径纪律）：报告据此写明样本范围，防止与「含北交所/ST 的全市场
    //   口径」对比时被误读为数据错误。null → 报告用默认口径文案，不猜。
    breadth_scope: s.breadth_scope ?? null,
    pools_caliber: s.pools_caliber ?? null,
    seal_pct: s.seal_pct ?? null,
    // 指数涨跌幅（对象 {上证指数:0.31,...}，仅数键）。日报市场背景行直读。
    indexes: d.indexes ?? null,
    amount_yi: s.amount_yi ?? null,
    ind_count: s.ind_count ?? null,
    // 板块相对强弱：与 index 档同源同字段名（前端一轮渲染可同时读两档）。
    // null 表示该日无行业明细 → 渲染成「未计算」，不得当成 0。
    industry_relative: s.industry_relative ?? null,
    main_theme: s.main_theme ?? null,
  };
}

/**
 * 生成按年分片对象。
 * 入参 diary 是完整 archive，返回 { year -> 分片对象 }。
 *
 * 分片里保留 meta/signals 的**同一份**：任何分片单独打开都能被前端当小档案用，
 * 不必回头再拉 index（减少一次往返，也让"只加载某一年"成为干净路径）。
 */
export function buildShards(archive) {
  const days = (archive && archive.all_days) || [];
  const out = {};
  for (const d of days) {
    const y = yearOf(d.trade_date);
    if (!y) continue;
    if (!out[y]) {
      out[y] = {
        kind: 'archive-shard',
        version: 1,
        year: y,
        meta: archive?.meta || {},
        signals: archive?.signals || {},
        all_days: [],
      };
    }
    out[y].all_days.push(d);
  }
  for (const y of Object.keys(out)) {
    out[y].totalDays = out[y].all_days.length;
    out[y].index = yearSummary(out[y].all_days);
  }
  return out;
}

/** 分片文件名（唯一出处，避免各处硬编码字符串拼错）。 */
export function shardName(year) {
  return `archive-${year}.json`;
}

// 滚动窗默认天数：覆盖走势图（15 日窗口）+ 详情抽屉回看 + 动量对比所需。
// 取 30 而非「近一年」——年分片仍可能 >6MB，滚动窗的意义就是让首屏与交互都不碰它。
export const RECENT_DAYS = 30;
export const RECENT_FILE = 'archive-recent.json';

/**
 * 近 N 个交易日的滚动窗 —— **两级分层**，这是体积能压到 10KB 级的关键。
 *
 * ── 为什么分层 ────────────────────────────────────────────────────────────
 * 走势图 / 抽屉回看需要 30 天，但 30 天里 29 天只需要「情绪曲线 + 因子」，
 * 逐日的 hot/lhb/industry 明细根本用不到；而最新一天需要全套明细（表格要渲染）。
 * 若把 30 天都按完整明细存，实测 1.5MB——比索引大了 150 倍，够开一次走势图，
 * 却让"只看最新日"也付了这份钱。
 *
 * 故：
 *   · all_days 只留**画走势所需的最小字段**（情绪 + 因子 + 几个计数），不含明细
 *   · 最新一天单独提到顶层 `latest`，带完整明细（但**不带 `_sub`** —— 席位/lhb
 *     仍是惰性的，需要时用 pickDay 从 `lazy` 提示的字段拉）
 *
 * 两级都保留 meta/signals，使前端只加载本文件就能完成首屏 + 走势渲染。
 */
export function buildRecent(archive, n = RECENT_DAYS, opts = {}) {
  const days = (archive && archive.all_days) || [];
  const slice = days.slice(-n);
  const last = slice[slice.length - 1] || null;
  const head = slice.slice(0, -1);
  // 最新日补 lhb_aggr（展示层唯一入口，审计断言它会存在）。
  //
  // ⚠ 为什么在**切片层**补、而不是让主档持久化它：
  //   主档 241 天全存 lhb_aggr ≈ +4.2MB（实测翻倍，见 scripts/recalc_lhb_daily.mjs 的体积纪律注）。
  //   而真正需要它的只有**滚动窗的最新日一屏**（前端首屏盘面/报告）。故：
  //     · 主档：只存 lhb（原始记录），lhb_aggr 一律不存 → 体积最小、形态统一
  //     · 切片最新日：现从 lhb 聚合出 lhb_aggr → 满足展示层，代价 O(当日条数) 且只算 1 天
  //   注入式实现（aggregateFn）保持本模块零依赖，与 breadthFn/painFn 同款。
  //   注入缺省时回退为原样（不补），不抛错——切片是派生视图，不该因缺注入而失败。
  //
  // ⚠ 原始记录的取法：主档是 **deflate 态**，`lhb` 被提到 `_sub.lhb`（提子规则 SUBSCRIBE_FIELDS）。
  //   若只看 `latest.lhb` 会永远取空 → 补聚合静默失效，故必须先解 `_sub` 再回退顶层。
  //   两处都取是刻意的：deflate 态与非 deflate 态都要兼容。
  //
  // ⚠⚠ 更致命的一层：入参 `archive` 是**压缩态**，记录里的上榜原因存的是码表下标 `rc: [25]`，
  //   而 `reason`/`reasons` 明文只在解码后才存在。若直接拿 `rc` 形态的记录去聚合，
  //   聚合产物会是 `reasons: [null]`，于是 `isNewStock()`（它只认 reasons 文本里的
  //   "无价格涨跌幅限制的证券"）全部失配 → 前端「新股」标记消失（实测：本断言曾因此变红）。
  //   故此处必须**先用档内自带的 `meta.reasonCodes` 把 rc 还原成明文**再聚合。
  //   码表就在 archive.meta 里，故仍然零依赖（不 import lhb_codec）。
  let latest = last || null;
  const aggFn = typeof opts.aggregateFn === 'function' ? opts.aggregateFn : null;
  if (latest && aggFn && !Array.isArray(latest.lhb_aggr)) {
    try {
      const sub = (latest._sub && typeof latest._sub === 'object') ? latest._sub : null;
      const rawRows = Array.isArray(latest.lhb) ? latest.lhb
        : (sub && Array.isArray(sub.lhb)) ? sub.lhb
          : [];
      if (rawRows.length) {
        const codes = (archive && archive.meta && Array.isArray(archive.meta.reasonCodes))
          ? archive.meta.reasonCodes : null;
        const rows = codes ? decodeRcRows(rawRows, codes) : rawRows;
        latest = { ...latest, lhb_aggr: aggFn(rows) };
      }
    } catch { /* 补聚合失败 → 保持原样（前端会回退 day.lhb） */ }
  }
  return {
    kind: 'archive-recent',
    version: 2,
    window: n,
    totalDays: slice.length,
    meta: archive?.meta || {},
    signals: archive?.signals || {},
    index: yearSummary(slice),
    // 近 N-1 日：只保画曲线所需字段（见 trendPoint）
    days: head.map(trendPoint),
    // 最新日：完整明细，但惰性字段仍在 _sub（前端按需 pickDay）
    latest,
  };
}

/**
 * 走势点：画曲线与分位对照所需的最小字段集合。
 *
 * ⚠ 例外：`summary.seats` 不是"曲线字段"，但**必须带上**（只带有/无标记，不带明细）。
 *   原因：研判报告的「锁仓统计」要比对 `days.slice(-3,-1)` 的买方席位与最新日——
 *   即它需要**前 2 天也持有 seats**。若这里把 seats 裁掉，报告那段会静默消失，
 *   表现为"报告少了结论"（本次实测：窗口内只剩最新 1 天有 seats，锁仓统计整段不见了）。
 *   代价很小：只有当天确实有 seats 时才多一个对象，且各只有几个数字字段。
 */
export function trendPoint(d) {
  if (!d) return null;
  const e = d.emotion || {};
  const s = d.summary || {};
  const seatKeys = SEAT_SUMMARY_KEYS.filter((k) => s.seats && s.seats[k] != null);
  return {
    trade_date: d.trade_date,
    value: e.value ?? e.score ?? null,
    breadth_bias: e.breadth_bias ?? null,
    pct_rank: e.pct_rank ?? null,
    factors: e.factors || null,
    backfill: !!(e._backfill),
    zt_count: s.zt_count ?? null,
    dt_count: s.dt_count ?? null,
    zb_count: s.zb_count ?? null,
    seal_pct: s.seal_pct ?? null,
    zbl_pct: s.zbl_pct ?? null,
    up_count: s.up_count ?? null,
    down_count: s.down_count ?? null,
    max_lb: s.max_lb ?? null,
    amount_yi: s.amount_yi ?? null,
    lhb_daily_net: s.lhb_daily_net ?? null,
    // 板块相对强弱：走势点也带上——否则「回看更早交易日」时超额榜会整块消失
    // （同 seats 的教训：该带的字段裁掉，报告那段就静默不见了）。
    // 代价很小：有数据时约 2KB/日；无数据的日子就是 null，约 20 字节。
    industry_relative: s.industry_relative ?? null,
    // 席位摘要（不含 detail —— 那是唯一的大块，留给需要时的完整档）
    ...(seatKeys.length ? { summary: { seats: pickKeys(s.seats, seatKeys) } } : {}),
  };
}

/**
 * seat 摘要里要为历史日保留的键（唯一出处）。
 * 选取标准：**calcLockNew / 报告席位段在"非最新日"上真正读到的字段**。
 * detail 刻意不含——它单日 51KB，而锁仓统计只用 detail 比对最新日（由 latest 提供）。
 */
const SEAT_SUMMARY_KEYS = ['cover', 'detail'];

/** 只取指定键（浅拷贝，值不动）。 */
function pickKeys(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// signals-latest.json —— 三档里最轻的一档（实测 ~11KB）
//
// ── 为什么还要一个文件 ─────────────────────────────────────────────────────
// index 已经只有 10.6KB，为什么不直接把它当"最新日档"？
// 因为两者的**更新节奏与读者**不同：index 是给走势图/年份导航用的，读的人是浏览器；
// signals-latest 是给"盯盘/巡检"用的——包括不跑前端、只在终端看今日结论的自动化任务，
// 以及只看一条结论的移动端。把告警与动量从 index 拆出来，能让这类读者在
// **不解析逐年摘要、不下载任何明细**的前提下拿到今日结论。
//
// ── 为什么告警是「大盘层」而非全量 ─────────────────────────────────────────
// 全量告警要持仓数据（positions），而持仓是**浏览器本地账本**（localStorage），
// 服务端生成时根本看不到。硬要在服务端算，就得把账户上传——那是另一个量级的隐私变更。
// 故本文件只放 marketAlerts()：输入只有情绪分与总资产，服务端可算，且与前端同源
// （同一个 marketAlerts 函数，不存在"服务端口径 vs 前端口径"两套）。
// 持仓层告警原由前端本地账户计算（模拟交易台面已下线，前端不再提供持仓层）。
// ════════════════════════════════════════════════════════════════════════════

export const SIGNALS_FILE = 'signals-latest.json';

/**
 * @param {object} archive 序列化态档案
 * @param {object} opts
 * @param {number} [opts.assumedTotal] 服务端无法知道真实账户，故按"满仓额度"给建议。
 *        默认 10 万（与 paper.js emptyAccount 默认一致），仅供"假如满仓"的口径演示；
 *        前端必须用本地真实 total/marketValue 重算，不得直接展示本字段的仓位结论。
 * @param {Function} [opts.marketAlertsFn] 注入 marketAlerts（保持本模块纯函数、可单测）
 * @param {Function} [opts.healthFn] 注入 health.healthReport（同上，纯函数注入）
 *        签名：healthFn(days, { meta }) → health 报告对象
 * @param {Function} [opts.dualTrackFn] 注入双轨披露块（P2-β 渲染接线，读盘注入——
 *        数据源 data/paper/dual_track_latest.json 而非 days，入参忽略）。
 *        唯一实现 src/dual_track.js::dualTrackDisclosureFn(dataDir)，两条写盘路径
 *        必须传**同一工厂产物**（否则 split_archive --check 报两路径形态分裂）。
 */
export function buildSignals(archive, opts = {}) {
  const days = (archive && archive.all_days) || [];
  const last = days[days.length - 1] || null;
  if (!last) return null;
  const assumedTotal = Number.isFinite(+opts.assumedTotal) ? +opts.assumedTotal : 100000;
  const fn = typeof opts.marketAlertsFn === 'function' ? opts.marketAlertsFn : null;
  const hFn = typeof opts.healthFn === 'function' ? opts.healthFn : null;
  // 席位属性序列（#1）与亏钱效应（#2）——同样走注入，保持本模块"不读盘"的纯函数性质。
  const sFn = typeof opts.seatSeriesFn === 'function' ? opts.seatSeriesFn : null;
  const pFn = typeof opts.painFn === 'function' ? opts.painFn : null;
  // 多维市场宽度（#3）——同上走注入（它的原始 K 线不在档案里，须外部提供）。
  const bFn = typeof opts.breadthFn === 'function' ? opts.breadthFn : null;
  // 跨源一致性互证（#2 本轮）——第二行业源不在档案里（且接口无法回溯），故走注入。
  const xFn = typeof opts.crosscheckFn === 'function' ? opts.crosscheckFn : null;
  // LLM 舆情参考（V5.3 P2 试点）——LLM 事件抽取/情感打分须联网调模型，
  // 同步写盘路径做不了 → 照 pain/crosscheck 先例只读已落盘缓存，读不到即 null。
  const lFn = typeof opts.llmFn === 'function' ? opts.llmFn : null;
  const score = last.emotion?.value ?? last.emotion?.score ?? null;
  const market = fn ? fn({ emotionScore: score, total: assumedTotal, marketValue: 0 }) : null;
  // 数据健康报告（#115）：随轻量档一起下发，让"盯盘/巡检"的读者不必拉完整档
  //   也能知道今天的数据能不能用。注意它看的是**近窗口**，不是单日。
  //   注入失败不影响本文件生成——健康报告是附加信息，不能成为管线单点。
  let health = null;
  if (hFn) {
    try { health = hFn(days, { meta: archive?.meta || {} }); } catch { health = null; }
  }
  // 席位属性（#1）：三类资金逐日净买 + 最新一日的主导方。
  //   刻意**不**放进分片：席位明细只最近数日有效，序列本身很短（当前 3 行），
  //   放此处正好让前端一次拿到，不必回看分片。
  let seats = null;
  if (sFn) {
    try { seats = sFn(days); } catch { seats = null; }
  }
  // 亏钱效应（#2）：昨涨停今日表现 / 连板晋级失败 / 大面股。需外部行情，由注入方提供。
  let pain = null;
  if (pFn) {
    try { pain = pFn(days); } catch { pain = null; }
  }
  // 多维市场宽度（#3）：站上均线占比 / 创新高新低 / 破净率 / 涨跌家数 + 逐日序列。
  //   与席位同理刻意不放分片：宽度快照本身很小（~1KB），序列也只有几行。
  let breadth = null;
  if (bFn) {
    try { breadth = bFn(days); } catch { breadth = null; }
  }
  // 异常值/脏数据（#3 本轮）：**直接从档案里读** emotion.dirty 留痕（不需外部注入）——
  //   因为标脏结果已由 recalcAll 写进每一天，这里只是把"有情况的天"汇总成一份清单。
  //   纪律：脏数据是**数据质量问题**，不属于情绪信号；此处只做"通报 + 定位"，
  //   不重算、不修改任何分值（分值的剔除早在管线里做完了，此处只读）。
  let dirty = null;
  try {
    const tagged = days.filter((d) => d.emotion && d.emotion.dirty);
    const fieldAgg = new Map();
    tagged.forEach((d) => {
      (d.emotion.dirty.fields || []).forEach((f) => fieldAgg.set(f, (fieldAgg.get(f) || 0) + 1));
    });
    // 告警复核留痕（scripts/review_alerts.mjs 写入 day.review）→ 汇总下发给日报：
    //   报告据此说"N/M 条已跨源互证销案"，而不是让读者对着已复核的告警重复劳动。
    //   无复核留痕 → review 为 null（前端/报告显示"未复核"，不冒充"已通过"）。
    const reviewed = tagged.filter((d) => d.review && d.review.verdict);
    const review = reviewed.length ? {
      checked: reviewed.length,
      verified: reviewed.filter((d) => d.review.verdict === 'verified').length,
      mismatch: reviewed.filter((d) => d.review.verdict === 'mismatch').length,
      at: reviewed[reviewed.length - 1].review.checkedAt || null,
    } : null;
    dirty = {
      // 最近一日的标脏情况（前端首屏展示用）
      latest: (last && last.emotion && last.emotion.dirty) ? last.emotion.dirty : null,
      // 全档汇总：哪些天有留痕、哪些字段出现最多
      totalDays: days.length,
      taggedDays: tagged.length,
      // 只有 error 级才算"脏"；warn 级是"需人工复核"，语义不同，分开计数
      dirtyDays: tagged.filter((d) => d.emotion.dirty.status === 'dirty').length,
      warnDays: tagged.filter((d) => d.emotion.dirty.status === 'warn').length,
      byField: [...fieldAgg.entries()].map(([field, n]) => ({ field, days: n })).sort((a, b) => b.days - a.days),
      // 明细（最多 20 条，避免轻量档膨胀）；reviewVerdict 带出该日复核结论
      recent: tagged.slice(-20).map((d) => ({ date: d.trade_date, ...d.emotion.dirty, ...(d.review && d.review.verdict ? { reviewVerdict: d.review.verdict } : {}) })),
      review,
    };
  } catch { dirty = null; }
  // 跨源一致性互证（#2）：结果由 scripts/fetch_crosscheck.mjs 落盘（需联网取第二源），
  //   本模块保持"不读盘"→ 走注入。未注入即 null（前端显示"未互证"，绝不放行成"一致"）。
  let crosscheck = null;
  if (xFn) {
    try { crosscheck = xFn(days, { meta: archive?.meta || {} }); } catch { crosscheck = null; }
  }
  // LLM 舆情参考（V5.3 P2）：注入方完成「读缓存 + llmSentimentBlock 转换」（含证据
  // 日期防伪与生效三规则），本处只透传结果——保持纯拼装纪律（regime 同款分工）。
  let llm = null;
  if (lFn) {
    try { llm = lFn(days); } catch { llm = null; }
  }
  // 拐点标签（#4）与每日日报（#4）——走注入，保持本模块"纯拼装、不 import 业务逻辑"的性质。
  //   为什么不在本模块直接 import src/regime.js：本模块的既定纪律是**所有需要业务判断的
  //   段落一律走注入**（health/seats/pain/breadth/crosscheck 皆如此）。保持一致 →
  //   便于单测注入假实现，也避免 archive_split 变成第二个"口径发散点"。
  const rFn = typeof opts.regimeFn === 'function' ? opts.regimeFn : null;
  const repFn = typeof opts.reportFn === 'function' ? opts.reportFn : null;
  let regime = null;
  if (rFn) {
    try { regime = rFn(days); } catch { regime = null; }
  }
  // 宽度背离（#3 决策：宽度**不纳入**情绪分，而是独立成一条告警）——————
  //   为什么独立成段而不是塞在 regime/dailyReport 里：
  //     · regime 回答"今天什么状态"，背离回答"这个状态**可信吗**"——两个问题，
  //       读者也不同（一个看大方向，一个看风险提示）。
  //     · 复用日报的背离结果会让"日报没生成 → 背离也没了"（耦合），
  //       而背离只需要 情绪分 + 宽度两个读数，哪怕日报注入失败它也该照常输出。
  //   ⚠ 判据唯一出处仍是 src/regime.js::detectDivergence（此处只注入调用，不重写）。
  let divergence = null;
  const dFn = typeof opts.divergenceFn === 'function' ? opts.divergenceFn : null;
  if (dFn) {
    try { divergence = dFn(days, { breadth, latest: latestBrief(last) }); } catch { divergence = null; }
  }
  // 双轨披露块（P2-β 渲染接线）：三轨披露 + 保险账本，来自 data/paper/dual_track_latest.json
  //   （tools/backtest/paper_dual_track.mjs 产出）。走注入保持本模块纯拼装、可单测——
  //   与 painFn 读盘注入同款（数据源是账本文件而非 days，注入函数忽略入参）。
  //   ⚠ 数字唯一出处 = paper_dual_track.mjs；本段只搬运不重算（R4 口径分裂防线）。
  //   null = 账本未生成（旁路工具未跑），≠"轨道一致"——渲染层显式区分。
  let dualTrack = null;
  const dtFn = typeof opts.dualTrackFn === 'function' ? opts.dualTrackFn : null;
  if (dtFn) {
    try { dualTrack = dtFn(days, { meta: archive?.meta || {} }); } catch { dualTrack = null; }
  }
  let dailyReport = null;
  if (repFn) {
    try {
      // 日报需要各段素材；缺什么就少什么（报告自身会标 missing，不编造）
      dailyReport = repFn({
        latest: latestBrief(last),
        // 前一交易日成交额（亿）：报告「较前一日 ±N 亿」的对照值。取不到 → null，
        // 报告只报当日值不编增量（缺失显式化，不猜 0）。
        amountPrevYi: (days.length > 1 && days[days.length - 2].summary)
          ? days[days.length - 2].summary.amount_yi ?? null
          : null,
        // regime 序列是压缩态四元组 [date, value, pct, key] → 还原成对象供日报用
      //   （唯一还原点；日报只读 value 序列，故这里只需 value）
      regimeSeries: (regime && Array.isArray(regime.seriesCompact))
        ? regime.seriesCompact.map((r) => ({ trade_date: r[0], value: r[1] }))
        : [],
        breadth, pain, seats, crosscheck,
        // LLM 舆情参考块（V5.3 P2）：原分不动的 ±5 参考修正——日报「八、舆情参考」节消费
        llm: llm || null,
        // 背离结论**复用**给日报（同一条结论，不在两处各判一次）——
        //   否则将来改判据会漏改一处，出现"面板说背离、日报说同向"。
        divergence: divergence || null,
        health: health || null,
        dirty: dirty || null,
        meta: archive?.meta || {},
      });
    } catch { dailyReport = null; }
  }
  return {
    kind: 'signals-latest',
    version: 1,
    // ⚠ meta 必须"瘦身"下发（体积纪律，实测抓出）：
    //   主档 meta 里带 `reasonCodes`（77 条码表，实测 5.4KB），它是**构建期**解压 rc
    //   下标用的（lhb_codec 在 decode 时消费），前端读 signals-latest 时**完全用不到**
    //   ——reason 早已在切片/滚动窗里是明文。原样透传等于把一张只在服务端用的
    //   码表塞进"只看一眼"的轻量档，白占 5.4KB（占 36KB 预算的 15%）。
    //   故此处剔除；其余 meta 字段照常（前端要显示新鲜度/相位/版本）。
    meta: (() => {
      const m = archive?.meta;
      if (!m || typeof m !== 'object') return m || {};
      // ⚠ 同款纪律第二例：`note`（历史回填/阈值修正的构建期留痕，实测随修档累积到
      //   ~4.5KB）也剔除——它是给完整档读者的**数据血缘**，轻量档"只看今日结论"
      //   的读者不需要；app.js 显示的 meta.note 读的是主档/年分片，与本处无关。
      //   freshness/phase/version 等前端要显示的字段照常下发。
      const { reasonCodes, note, ...rest } = m;
      return rest;
    })(),
    signals: archive?.signals || {},
    latest: latestBrief(last),
    // 板块相对强弱（若管线已算出）。没有就是 null，前端显示"未计算"而非 0——
    // 0 与"没算"在相对强弱语境下含义完全相反（0 = 与大盘同步，没算 = 未知）。
    relative: last.summary?.industry_relative || null,
    // 数据健康（#115）。未注入时为 null，前端显示"未评估"而非"正常"。
    health,
    healthNote: hFn
      ? '健康面板只看数据能不能用（新鲜度/补位率/字段覆盖），不参与打分；缺失一律显示"未知"而非 0。'
      : '未生成（调用方未注入 healthReport）',
    // 席位/资金属性（#1）：{ series, summary, verdict }。series 每行一个交易日，
    //   含机构/北向/游资三类净买。无数据的天 net 为 null（不是 0）。
    seats,
    seatsNote: sFn
      ? '席位明细接口仅保留最近若干交易日，故序列从有数据之日起逐日累积；缺失日为 null，不填 0。'
      : '未生成（调用方未注入 seatSeries）',
    // 亏钱效应（#2）：昨涨停今日表现须用**全市场真实行情**算，不可用 hot 列表
    //   （hot 只含上涨股，会静默丢弃下跌的那一半，得出恒为 +10% 的假繁荣）。
    pain,
    painNote: pFn
      ? '昨涨停今日表现基于全市场真实行情（含下跌股），非 hot 涨幅榜口径；样本不足时结论降级为"未知"。'
      : '未生成（调用方未注入 painReport，需实时行情）',
    // 市场宽度（#3）：{ snapshot, series, summary, verdict }。snapshot 为最新一日的
    //   站上均线占比/创新高新低/破净率/涨跌家数；series 为逐日累积（同样"历史自然生长"）。
    breadth,
    breadthNote: bFn
      ? '宽度由全市场真实前复权日K计算（非榜单样本）。破净率依赖 PB 源，不可用时为 null（显示"未计算"）而非 0；'
        + '样本不足时比例同样为 null。占比分母是已扫描样本数，不是全市场总数。'
      : '未生成（调用方未注入 breadthFn，需全市场 K 线）',
    // 异常值/脏数据（#3）：{ latest, totalDays, taggedDays, dirtyDays, warnDays, byField, recent }。
    //   注意语义分层：dirtyDays = 有 error 级问题（该因子已从情绪分剔除）；
    //   warnDays = 仅"需人工复核"（如数值孤立的强板块，**未剔除**任何数据）。
    //   把两者混为一谈会让人误以为数据被丢了——这是本面板最要紧的区分。
    dirty,
    dirtyNote: '标脏 = 该字段已被排除在因子入参之外（原值仍保留在档里，可追溯/可人工复核）；'
      + 'warn ≠ dirty：warn 只是提示复核，未剔除任何数据。缺失一律显示"未计算"而非 0。',
    // 跨源一致性互证（#2 本轮）：{ status, comparable, coverage, offset, divergeCount, conflictCount, flagged, rows }。
    //   与 dirty 的分工必须说清：dirty 管**单源内部**异常（范围/单位/重复/逻辑一致性）；
    //   本段管**跨源交叉**验证（同花顺行业 vs 申万二级）——两者互补，不是重复。
    //   ⚠ 未注入时为 null（前端显示"未互证"），**不得因为"没有第二源"就显示成"两源一致"**。
    crosscheck,
    crosscheckNote: xFn
      ? '跨源互证只在"两源都覆盖且分类可归一"的行业上比对，覆盖率如实披露；'
        + '当日两源常态偏移（方法论差异）已扣除，判定针对的是"偏离常态关系的离群"，'
        + '且**只标记不改数**。未覆盖部分=未核对，不等于没问题。第二源无日期参数，故仅最新日有效。'
      : '未生成（调用方未注入 crosscheck，需第二行业源）',
    // LLM 舆情参考（V5.3 P2）：{ asOfDate, sentimentRaw, adj, effective, original, modified, events, ... }。
    // 原分不动（emotion.value 零漂移）、±5 上限、观望区/反向不生效；证据日期与
    // 目标日不符即 null。⚠ null = 未跑 LLM ≠ "舆情中性"——前端/日报按缺失渲染。
    llm,
    llmNote: lFn
      ? 'LLM 舆情为 P2 试点：±5 分参考修正、原分不动、不独立生成买卖信号；'
        + '仅与原因子同向（≥65 偏多 / <44 偏空）时生效，观望区与反向一律不生效。'
        + '事件抽取与情感打分由 scripts/fetch_llm_sentiment.mjs 落盘留痕（含证据日期）。'
      : '未生成（调用方未注入 llmFn，需 LLM API 配置）',
    // 拐点标签（#4）：{ latest, series, counts, rules }。四态 = 冰点/回暖/高潮/退潮，
    //   由「水位 × 方向」两个正交维度判定；水位以**历史分位**为主判据（实测情绪分
    //   分布高度压缩在 40-65，绝对刻度几乎不分类），绝对刻度仅作交叉披露。
    //   ⚠ 未注入时为 null（前端显示"未生成"），不得默认成"中性"——那会伪造结论。
    regime,
    regimeNote: rFn
      ? '四态标签 = 水位（历史分位为主）× 方向（较 3 个交易日前的变化）；判据缺口一律显示"数据不足"，不猜。'
        + '绝对水位与分位读数不一致时会如实披露（因情绪分分布高度压缩，以分位为准）。'
        + '标签只描述市场状态，不含任何买卖建议。'
      : '未生成（调用方未注入 regimeFn）',
    // 宽度背离告警（#3 决策）：{ diverged, kind, level, label, reason, ... }。
    //   宽度**不纳入**情绪分（两者是"多少票在涨" vs "钱有多凶"，同向时无信息量），
    //   只在**背离时**出信号 —— 这才是可操作的信息。
    //   ⚠ 三态必须分清：diverged=true（有背离）/ false（同向，已比对）/ level='unknown'
    //     （**未评估**：宽度判定缺失或情绪分缺失）—— 最后一种**不得**被读成"一致"。
    divergence,
    divergenceNote: dFn
      ? '宽度不参与情绪分打分（避免同义重复计权）；本告警只在"钱凶但票不涨"或'
        + '"票在涨但钱冷"这类**背离**时触发，同向时不报。'
        + '宽度判定缺失 → 显示"未评估"，**缺失不等于一致**。判据唯一出处 src/regime.js::detectDivergence。'
      : '未生成（调用方未注入 divergenceFn）',
    // 每日盘后日报（#4）：结构化七节（状态/情绪/涨跌/亏钱/资金/题材/质量），
    //   供前端折叠渲染与导出。**只翻译屏幕已有数据，不重算任何指标**；
    //   缺失项写 missing + 原因，绝不补 0。
    dailyReport,
    dailyReportNote: repFn
      ? '日报是"翻译层"：所有读数来自当日已归档数据，缺失项标注"未采集/未计算"而非补 0；不构成投资建议。'
      : '未生成（调用方未注入 reportFn）',
    // 双轨披露（P2-β 渲染接线 · 框架 docs/dual_track_framework.md §三）：
    //   { asOf, generatedAt, day, ledger, trackState, note }。轨道 A = 唯一执行轨道；
    //   轨道 B = V5.3 风险参考线（永不执行）；轨道 C = shift 次日帽影子（记账不执行）。
    //   ⚠ asOf 是账本末日，可能与 meta.tradeDate 不同（旁路工具每日一跑）——如实披露。
    //     null = 未生成 ≠ "轨道一致"；段一旦存在，day 内字段必须齐（半缺=渲染静默空白）。
    dualTrack,
    dualTrackNote: dtFn
      ? '轨道 B/C 为风控参考与影子记账，不是买卖信号；分歧=保险当日保费敞口，账本为 P2 起累计。'
        + 'asOf 是双轨账本末日（旁路工具每日一跑），与 meta.tradeDate 不同步时以 asOf 为披露口径。'
        + '数字唯一出处 tools/backtest/paper_dual_track.mjs（本段只搬运不重算）。'
      : '未生成（调用方未注入 dualTrackFn，需 tools/backtest/paper_dual_track.mjs 产出 data/paper/dual_track_latest.json）',
    marketAlerts: market,
    marketAlertsNote: fn
      ? `仅大盘层告警，按假设总资产 ${assumedTotal} 元、空仓计算；持仓层告警依赖本地模拟账户（模拟交易台面已下线），本轮不提供`
      : '未生成（调用方未注入 marketAlerts）',
  };
}
