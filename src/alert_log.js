// 预警台账与收益归因引擎（唯一来源，ESM 纯函数、零依赖、Node 与浏览器共用）
//
// 定位：预警本身只说「该做什么」；这个模块回答**「照做了到底省了多少 / 亏了多少」**。
//       它是预警系统的**计分板**——没有计分板，预警就只是话术，无法被证伪也无法被改进。
//
// 为什么必须有它：
//   用户的目标是「减少亏损、增加模拟收入」。一条「应止损」的预警如果不计分，
//   用户没法知道它准不准、该不该继续听。把每条预警的「触发时价格 → 今日价格」
//   这段事实记下来，就能算出：
//     · 止损/减仓类：照做避免的亏损（跌了就是省下的钱）——**也可能为负**（卖完反弹 = 错杀）
//     · 加仓类：照做后是赚了还是亏了（这是「增加收入」的直接证据）
//     · 命中率：有多少条预警的方向被后续价格验证
//
// 三条硬纪律：
//   1. **只记事实，不记结论**：台账里存的是「触发日价格 / 触发时刻的持仓」，归因是**现算**的。
//      绝不把「这条预警赚了 500 元」写死进台账——价格一变，结论必须跟着变。
//   2. **无价不算，宁可留空**：取不到今日真实价时，该条归因为 null（未结算），
//      绝不退化成「差额 = 0」假装算过。0 和「不知道」是两回事。
//   3. **符号约定唯一**：`saved > 0` 恒表示「照做比不做好」，`saved < 0` 恒表示「照做反而更差」。
//      所有规则都归到这一个符号上，汇总时才不会出现两套正负口径互相抵消。
//
// 与 src/alerts.js 的关系：alerts.js 产出「建议动作」，本模块只做「建议 → 事后计分」。
//   动作到归因方向的映射集中在 ACTION_DIR 常量里（唯一出处）。

// ── 口径唯一出处（复用，不重写） ──
import { POS_CFG, MARKET_CFG } from './alerts.js';
import { LOT } from './paper.js';

// ────────────────────────── 一、常量（集中在此，UI 不重写） ──────────────────────────

/**
 * 台账容量上限。超出后**保留最早的**（而不是最新的）——因为归因需要时间沉淀，
 * 一条刚触发的预警当场没有归因价值，而一条三天前的止损预警才有。
 * 淘汰策略：先丢「已结算且距离最久」的，再丢最旧的未结算条目。
 */
export const LOG_CAP = 400;

/**
 * 动作 → 归因方向。
 *   +1：这个动作是「离场/减仓」——事后下跌 = 做对了（省下亏损）
 *   -1：这个动作是「进场/加仓」——事后上涨 = 做对了（赚到收益）
 *    0：不参与归因（持有/等待/观望这类没有可量化的仓位变动）
 *
 * 为什么要按「动作」而不是按「预警 type」：同一个 type 在不同持仓数量下动作可能不同
 * （如 market-trim 在清仓档是清空、在半仓档是减半），用动作做方向才能覆盖全部情形。
 */
export const ACTION_DIR = {
  sell: +1, clear: +1, exit: +1, reduce: +1,
  buy: -1, add: -1,
  hold: 0, wait: 0, watch: 0,
};

/**
 * 归因口径参数。
 *   minQty     最小参与股数——不足 100 股（1 手）的动作在 A 股根本执行不了，不计分。
 *   hitBand    命中判定带：方向正确但幅度小于此比例时算「平」（不计命中也不计失手），
 *              避免把 0.1% 的噪声当成「预警对了」。
 */
export const LOG_CFG = {
  minQty: LOT,
  hitBand: 0.005,
};

// ────────────────────────── 二、工具 ──────────────────────────

/**
 * 「是有限数字」判定。**不能写成 `Number.isFinite(+v)`**：
 * `+null === 0`、`+'' === 0`、`+false === 0` 都是有限数，会把「价格缺失」读成「价格 0」，
 * 从而算出「跌了 100% → 止损预警省下了全部本金」这种荒唐结论。
 * 与 src/alerts.js 的 finite 同一纪律（那边踩过这个坑，注释也记着）。
 */
const finite = (v) => v != null && v !== '' && typeof v !== 'boolean' && Number.isFinite(+v);

/** 金额（元）→ 带千分位整数（不带「元」后缀，调用方拼） */
const yuan = (v) => (finite(v) ? Math.round(+v).toLocaleString('en-US') : '—');

/**
 * 台账条目的唯一键。
 *
 * 为什么用「日期 + 层 + 代码 + 类型」而不是时间戳：
 *   预警是**当日状态**的描述，同一天同一只票的同一条规则反复触发（界面重渲染、行情刷新）
 *   只应记一次。用时间戳会把「刷新 10 次」记成 10 条，归因瞬间失真 10 倍。
 *   换一天（或换一只票、换一条规则）才是新的独立信号。
 * market 层没有 code，用 '_' 占位，保证键结构一致。
 */
const keyOf = (s) => [s.asOf || '?', s.layer || '?', s.code || '_', s.type].join('|');

// ────────────────────────── 三、落账 ──────────────────────────

/**
 * 把当前这批预警**追加**进台账。
 *
 * 幂等：同 key 已存在则**保留最早那条**（不覆盖）。理由——
 *   ① 止损预警在触发那一刻的价格才是最有价值的计分基准（越往后拖，价格已经走远，
 *      再记就变成「预警 + 追认」，归因会系统性偏乐观）；
 *   ② 幂等保证「界面反复刷新」不会污染台账（这是最容易踩的坑）。
 *
 * @param {Array<object>} log     现有台账（可空）
 * @param {Array<object>} alerts  buildAlerts(...).alerts
 * @param {object} [ctx]
 * @param {string|null} [ctx.asOf] 数据日期（用于 key 与展示）
 * @param {number|null} [ctx.priceOf] 取价函数 (code) => 触发时刻价格；缺省时从 alert.quote 无法反解，故必传
 * @returns {{log:Array, added:number, skipped:number}} 新台账（不改原数组）
 */
export function appendSignals(log, alerts, ctx = {}) {
  const cur = Array.isArray(log) ? log : [];
  const seen = new Set(cur.map((e) => e.key));
  const out = [];
  let added = 0;
  let skipped = 0;

  for (const a of Array.isArray(alerts) ? alerts : []) {
    if (!a || !a.type) { skipped++; continue; }
    // 只有带 code 的条目才有可归因的价格基准；大盘层没有标的价格，但它有「仓位占比」——
    // 大盘层的归因口径不同（见 evaluateMarketEntry），仍然要落账。
    const dir = ACTION_DIR[a.action];
    if (dir === undefined) { skipped++; continue; }
    if (dir === 0) { skipped++; continue; }   // 持有/等待/观望无仓位变动，不计分
    if (a.layer === 'position' && !a.code) { skipped++; continue; }

    // 计分股数与下单股数是**两个不同的量**，这里必须区分开：
    //   · qty      = a.qty  = 今天能卖多少（T+1 未解冻时可能是 0）
    //   · scoreQty = 本应保护多少（= 该票全部持仓 heldQty）
    // 早期版本用 qty>0 做落账门槛，结果「止损预警」在 T+1 全锁时**根本不进台账**——
    // 而那恰恰是最该被追责的一条规则。止损的分数应该衡量「如果昨天就按纪律离场，
    // 今天能少亏多少」，而不是「今天能不能卖」。缺口留在 qty 上，分数按 scoreQty 算。
    const scoreQty = a.layer === 'position'
      ? Math.floor(finite(a.heldQty) && a.heldQty > 0 ? +a.heldQty : (a.qty > 0 ? a.qty : 0))
      : 0;
    if (dir !== 0 && scoreQty < LOG_CFG.minQty && a.layer === 'position') { skipped++; continue; }

    const asOf = ctx.asOf || null;
    const px = a.layer === 'position'
      ? (typeof ctx.priceOf === 'function' ? ctx.priceOf(a.code, a) : null)
      : null;
    // 持仓层没有价格基准就无法归因 —— 宁可不记，也不记一条永远算不出来的空条目
    if (a.layer === 'position' && !finite(px)) { skipped++; continue; }

    const entry = {
      key: keyOf({ asOf, layer: a.layer, code: a.code, type: a.type }),
      asOf,
      layer: a.layer,
      code: a.code || null,
      name: a.name || null,
      type: a.type,
      level: a.level,
      action: a.action,
      dir,
      /** 下单股数（今天能卖多少；T+1 全锁时为 0） */
      qty: a.qty > 0 ? Math.floor(a.qty) : 0,
      /** 计分股数（本应保护多少 = 该票全部持仓），归因按这个算 */
      scoreQty,
      /** 触发时刻的价格基准（归因分母，绝不改写） */
      px: finite(px) ? +px : null,
      /** 触发时刻该票占总资产比例（大盘层／减仓比例口径共用） */
      conc: finite(a.conc) ? +a.conc : null,
      /** 触发时刻账户总资产（算「减仓节省的金额」需要） */
      total: finite(ctx.total) ? +ctx.total : null,
      /** 触发时刻的建议目标仓位（大盘层用：目标 − 当前 = 需要调整的比例） */
      targetPos: finite(ctx.targetPos) ? +ctx.targetPos : null,
      curPos: finite(ctx.curPos) ? +ctx.curPos : null,
      text: a.text || '',
      loggedAt: ctx.now || null,
    };

    if (seen.has(entry.key)) { skipped++; continue; }
    seen.add(entry.key);
    out.push(entry);
    added++;
  }

  let merged = [...cur, ...out];
  if (merged.length > LOG_CAP) merged = trimLog(merged);
  return { log: merged, added, skipped };
}

/**
 * 台账淘汰：优先丢「已结算（有 finalPx）且最旧」的，其次丢最旧的：
 * 未结算条目还等着计分，先丢它们等于永远算不出来。
 * 注：这里不再接收 priceMap ——「是否已结算」由条目自带的 finalPx 字段标记
 * （summary 在回写时会带上），保持本函数纯粹（不依赖行情）。
 */
function trimLog(log) {
  const settled = log.filter((e) => finite(e.finalPx));
  const pending = log.filter((e) => !finite(e.finalPx));
  const keep = LOG_CAP - pending.length;
  if (keep <= 0) {
    // 未结算条目已经超过容量：只保留最近的 LOG_CAP 条（按 asOf 排序，最旧的先丢）
    return [...pending].sort((a, b) => String(b.asOf).localeCompare(String(a.asOf))).slice(0, LOG_CAP);
  }
  const keptSettled = [...settled]
    .sort((a, b) => String(b.asOf).localeCompare(String(a.asOf)))
    .slice(0, keep);
  return [...keptSettled, ...pending];
}

// ────────────────────────── 四、单条归因 ──────────────────────────

/**
 * 单条**持仓层**预警的归因：照做 vs 不动，差额是多少。
 *
 * 口径（全部按「股数 × 价差」，不含费用——费用在两边都发生，做差会抵消，
 * 且把费用算进来会让归因随「是否真的成交」漂移，失去可比性）：
 *
 *   计分股数 = scoreQty（该票全部持仓），**不是** qty（今天能卖多少）。
 *   止损预警常常发生在「当天买入、T+1 锁住」的情境下，此时 qty=0 但风险是实打实的；
 *   按 scoreQty 计分才回答得了「如果按纪律离场，能少亏多少」。
 *
 *   dir = +1（卖出/减仓类）：照做 = 在 px 卖出，不动 = 在 finalPx 还持有
 *     saved = qty × (px − finalPx)
 *       · finalPx < px（跌了）→ saved > 0 → **省下了亏损**（做对了）
 *       · finalPx > px（涨了）→ saved < 0 → **卖飞了**（做错了，如实记为负）
 *
 *   dir = -1（买入/加仓类）：照做 = 在 px 买入，不动 = 拿现金
 *     saved = qty × (finalPx − px)
 *       · 涨了 → saved > 0 → 赚到了
 *       · 跌了 → saved < 0 → 亏了
 *
 * 两条统一到「saved > 0 就是照做更好」这一个符号上。
 *
 * @param {object} e 台账条目
 * @param {number|null} finalPx 今日（或最近）真实价
 * @returns {{pct:number, pnl:number, dir:number, verdict:string}|null}
 *          null = 无法归因（缺价 / 无可执行股数 / 方向为 0）
 */
export function evaluateEntry(e, finalPx) {
  if (!e) return null;
  const dir = ACTION_DIR[e.action];
  if (!dir) return null;
  const px = finite(e.px) ? +e.px : null;
  const fx = finite(finalPx) ? +finalPx : null;
  if (px == null || px <= 0 || fx == null) return null;
  // 计分股数优先用 scoreQty（= 本应保护的全部持仓）；没有该字段时退回 qty ——
  // 兼容早期台账（字段升级不该让历史记录的归因突然变成「无法计算」）。
  const qty = finite(e.scoreQty) && e.scoreQty > 0
    ? Math.floor(+e.scoreQty)
    : (e.qty > 0 ? Math.floor(e.qty) : 0);
  if (qty < LOG_CFG.minQty) return null;   // 不足一手，执行不了，不计分

  const pct = fx / px - 1;                 // 标的涨跌幅（与方向无关）
  const pnl = dir > 0
    ? qty * (px - fx)                      // 卖出类：跌了才省
    : qty * (fx - px);                     // 买入类：涨了才赚

  // 方向判定：|pct| 在命中带内算「平」，避免把噪声当战果
  let verdict;
  if (Math.abs(pct) <= LOG_CFG.hitBand) verdict = 'flat';
  else verdict = (dir > 0 ? pct < 0 : pct > 0) ? 'hit' : 'miss';

  return { pct, pnl, dir, verdict, qty, px, finalPx: fx };
}

/**
 * 大盘层条目的归因：口径不同——它调的是「总仓位比例」，没有单只标的的价格。
 *
 * 做法：把「需要调整的仓位金额」作为计分基准，用**等权组合**的代理收益计分。
 * 但账本里没有组合收益，只有单票价格。所以这里退一步，只做**方向记账**：
 *   · 减仓类（dir=+1）：记录「按建议降下来的仓位金额」，收益记为 0（未结算），
 *     因为大盘层没有单一价格可归因——**宁可留空也不瞎给一个数**。
 *   · 该条目的价值在于「提示了多少次要降仓」的纪律计数，而非金额。
 *
 * @returns {{pct:null, pnl:null, dir:number, verdict:'tracked'}}
 */
export function evaluateMarketEntry(e) {
  if (!e) return null;
  const dir = ACTION_DIR[e.action];
  if (!dir) return null;
  const mv = finite(e.total) && finite(e.curPos) ? e.total * e.curPos : null;
  const target = finite(e.total) && finite(e.targetPos) ? e.total * e.targetPos : null;
  const amount = (mv != null && target != null) ? Math.abs(mv - target) : null;
  return { pct: null, pnl: null, dir, verdict: 'tracked', amount };
}

// ────────────────────────── 五、汇总 ──────────────────────────

/**
 * 汇总台账：累计规避亏损、错过收益、净贡献、命中率、按规则拆解。
 *
 * 符号约定（唯一）：
 *   avoidedLoss  规避的亏损（saved > 0 的卖出类之和）——「少亏的钱」
 *   missedGain   错过的收益 / 错杀（saved < 0 之和的绝对值，含卖出类卖飞与买入类亏钱）
 *   net          净贡献 = Σsaved（正 = 预警整体帮你赚了）
 *   hit / miss / flat / pending 条数
 *   hitRate      hit / (hit + miss)——**分母不含 flat 与 pending**，因为「没结论」不该算进准率
 *
 * @param {Array<object>} log
 * @param {object} [priceMap] code → 今日真实价（缺失即该条未结算）
 * @param {object} [opts]
 * @param {Function} [opts.priceOf] (code) => px，优先于 priceMap
 * @returns {object} 汇总对象（见上）
 */
export function summarizeLog(log, priceMap, opts = {}) {
  const entries = Array.isArray(log) ? log : [];
  const getPx = typeof opts.priceOf === 'function'
    ? opts.priceOf
    : (code) => (priceMap && code != null ? priceMap[code] : null);

  const byType = new Map();
  let avoidedLoss = 0, missedGain = 0, net = 0;
  let hit = 0, miss = 0, flat = 0, pending = 0, tracked = 0;
  const details = [];

  for (const e of entries) {
    const isMarket = e.layer === 'market';
    const r = isMarket ? evaluateMarketEntry(e) : evaluateEntry(e, getPx(e.code));
    const t = byType.get(e.type) || { type: e.type, action: e.action, count: 0, net: 0, hit: 0, miss: 0, pending: 0 };
    t.count++;
    if (r && r.verdict === 'tracked') { tracked++; t.pending++; }
    else if (!r) { pending++; t.pending++; }
    else {
      net += r.pnl;
      if (r.pnl > 0) avoidedLoss += r.pnl;
      else if (r.pnl < 0) missedGain += -r.pnl;
      if (r.verdict === 'hit') { hit++; t.hit++; }
      else if (r.verdict === 'miss') { miss++; t.miss++; }
      else flat++;
      t.net += r.pnl;
    }
    byType.set(e.type, t);
    details.push({ ...e, result: r });
  }

  const judged = hit + miss;
  return {
    n: entries.length,
    net,
    avoidedLoss,
    missedGain,
    hit, miss, flat, pending, tracked,
    hitRate: judged > 0 ? hit / judged : null,
    byType: [...byType.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || b.count - a.count),
    details,
  };
}

/**
 * 汇总 → 一句可直接展示的结论（UI 与测试共用，避免两处各写一套措辞导致数字与文案不一致）。
 * 数字一律走 yuan()，保证「1,234 元」这种能核验的写法。
 */
export function summarizeText(s) {
  if (!s || !s.n) return '尚无预警记录——预警触发后会逐条记账，用后续真实价格计分。';
  const parts = [];
  if (s.avoidedLoss > 0) parts.push(`已规避亏损约 ${yuan(s.avoidedLoss)} 元`);
  if (s.missedGain > 0) parts.push(`错杀/错过的机会约 ${yuan(s.missedGain)} 元`);
  if (!parts.length) parts.push('暂无可结算的盈亏');
  const netTxt = `净贡献 ${s.net >= 0 ? '+' : '−'}${yuan(Math.abs(s.net))} 元`;
  const rateTxt = s.hitRate == null ? '命中率待积累' : `命中率 ${(s.hitRate * 100).toFixed(0)}%（${s.hit} 对 / ${s.miss} 错）`;
  const pendTxt = s.pending + s.tracked > 0 ? `，另有 ${s.pending + s.tracked} 条待价格验证` : '';
  return `${parts.join('，')}；${netTxt}，${rateTxt}${pendTxt}。`;
}
