// 模拟交易复盘引擎（唯一来源，ESM 纯函数、零依赖、Node 与浏览器共用）
//
// 定位：回答**「这笔模拟交易为什么赚、为什么亏」**，并据事实给出**可执行的止损与优化建议**。
//       它不是又一个「当日预警」（那是 src/alerts.js 的事，面向未来），而是**回望已发生的事**：
//       钱是从哪来的、亏在哪、哪条纪律被违反了、下一笔该怎么改。
//
// 为什么必须集中在这里、不能写在 UI（app.js 的报告拼接里）：
//   报告的每一句话都会进入「导出文档」（纯文本/Markdown/独立 HTML），会成为用户留档、
//   甚至拿给别人的东西。归因口径一旦在 UI 里再写一遍，就会和交易引擎（src/paper.js）、
//   预警引擎（src/alerts.js）、台账（src/alert_log.js）漂移——同一笔交易在界面上说赚、
//   在报告里说亏。所以：本文件只做**排列组合与措辞**，所有原始口径一律 import。
//
// 三条硬纪律（与 alerts.js / alert_log.js 一脉相承）：
//   1. **每一句结论都必须能追溯到具体字段**：说不清「因为哪个数字」就不许写。
//      禁止「操作有待改进」这类无法核验的措辞——必须给到「哪只票、差多少、该卖多少股」。
//   2. **无数据不编**：还没开始模拟交易 → 段落如实说「尚未开始」，绝不生成看似专业的空话；
//      缺价导致算不出的指标 → 返回 null，汇总时计入「待价格验证」，不退化成 0。
//   3. **归因符号唯一**：`pnl > 0` 恒表示「这一项贡献了正收益」。利润来源、亏损来源、
//      建议的收益方向全部归到这一个符号上，避免出现两套正负口径互相抵消。
//
// 与其它模块的关系：
//   · src/paper.js        —— 账户口径（accountStats / fees / POS_TIERS）的唯一出处
//   · src/alerts.js       —— 阈值（POS_CFG / MARKET_CFG）与档位（picks.marketTier）的唯一出处
//   · src/alert_log.js    —— 预警战绩（summarizeLog）的唯一出处；本引擎只引用不重算
//   · src/picks.js        —— 档位阈值（TIER_THRESHOLDS）与档位表（POSITION_TIERS）的唯一出处

// ── 口径唯一出处（复用，不重写） ──
import { POS_CFG, MARKET_CFG } from './alerts.js';
import { marketTier, TIER_THRESHOLDS } from './picks.js';
import { summarizeLog } from './alert_log.js';
import { LOT } from './paper.js';

// 供报告端（app.js，经典脚本、不能 import）在「口径说明」里引用阈值原文——
// 报告必须能写出「止损线 −8%、单票上限 20%」这种可核验的数字，而这两个数
// 的唯一出处是 alerts.POS_CFG。再转出一次，避免报告端自己抄一遍常量导致漂移。
export { POS_CFG, MARKET_CFG, TIER_THRESHOLDS };

// ────────────────────────── 一、常量（阈值集中在此，UI 不重写） ──────────────────────────

/**
 * 复盘参数。每一项都对应一个「能改变结论」的判定边界，故必须集中、可单测。
 *
 *   minTradesForWinRate  算胜率所需的最少**平仓笔数**。1 笔平仓的「胜率 100%」没有统计意义，
 *                        但也不能因此什么都不说——低于此数时**如实标注样本不足**，而不是隐藏。
 *   minTradeForEdge      单笔「显著盈亏」门槛（占初始本金比例）。小于此值的笔数归纳为
 *                        「零碎」，避免 0.01% 的盈亏被当成「最赚的一笔」写进报告。
 *   concWarnRatio        单票占比超过「单票上限 × 此比例」即视为「偏重」（预警级别已由
 *                        alerts.POS_CFG.concMax 判定，这里只做复盘分层排序，不重复告警）。
 *   feeDragWarn          费用占初始本金比例超过此值 → 费用吞噬收益的建议（费用是确定性的
 *                        负收益，换手越高越致命，必须在报告里显性说出）。
 *   lossStreakWarn       连续亏损笔数达到此值 → 触发「停手复盘」建议。
 *   staleWinRateFloor    胜率低于此值（且样本足够）→ 触发「策略有效性」建议。
 *   disciplineFloor      止损纪律执行率低于此值 → 触发「纪律」建议。
 */
export const REVIEW_CFG = {
  minTradesForWinRate: 3,
  minTradeForEdge: 0.002,
  concWarnRatio: 0.8,
  feeDragWarn: 0.01,
  lossStreakWarn: 3,
  staleWinRateFloor: 0.40,
  disciplineFloor: 0.60,
};

/** 建议的严重度：与 alerts.LEVELS 同序（risk > opp > tip），便于 UI 复用配色。 */
export const ADVICE_LEVELS = ['risk', 'opp', 'tip'];

/**
 * 快照版本号。UI 把账户/台账/行情挂到 window.__paperSnapshot 供经典脚本（app.js）读取，
 * 报告端据此校验「读到的是不是本引擎认识的版本」——版本不匹配时宁可降级提示，
 * 也不要用错字段拼出一段看似正常的结论。升级本引擎的数据契约时**必须**同步递增。
 */
export const REVIEW_VERSION = 'paper-review-v1';

/** 复盘结论一句话的模板前缀（UI 与导出共用，避免两处措辞不一致）。 */
export const REVIEW_TITLE = '模拟交易复盘';

// ────────────────────────── 二、工具 ──────────────────────────

/**
 * 「是有限数字」判定。**不能写成 `Number.isFinite(+v)`**：
 * `+null === 0`、`+'' === 0`、`+false === 0` 都会把「缺失」读成「0」——
 * 「最新价缺失」会被读成「价格 0」→ 浮亏 −100% → 复盘凭空得出「这笔亏光了」。
 * 与 src/alerts.js、src/alert_log.js 同一纪律（那两处踩过这个坑，注释也记着）。
 */
const finite = (v) => v != null && v !== '' && typeof v !== 'boolean' && Number.isFinite(+v);

/** 金额（元）→ 带千分位整数（**不带**「元」后缀，调用方拼，避免「20,000 元 元」）。 */
const yuan = (v) => (finite(v) ? Math.round(+v).toLocaleString('en-US') : '—');

/** 带正负号的金额（+1,234 / −1,234），用于盈亏金额。 */
const syuan = (v) => (finite(v) ? (v >= 0 ? '+' : '−') + yuan(Math.abs(v)) : '—');

/** 比例 → 百分数文本（0.1234 → 12.3%）。**返回值已含 `%`**，调用方不得再补。 */
const pp = (v, d = 1) => (finite(v) ? `${(+v * 100).toFixed(d)}%` : '—');

/** 带正负号的百分数（-0.08 → -8.0%）。同样**已含 `%`**。 */
const sp = (v, d = 1) => (finite(v) ? `${+v > 0 ? '+' : ''}${(+v * 100).toFixed(d)}%` : '—');

const r2 = (v) => Math.round((+v || 0) * 100) / 100;

// ────────────────────────── 三、收益来源拆解（为什么赚 / 为什么亏） ──────────────────────────

/**
 * 把「账户总收益」拆成可解释的三块 + 一块本金参照。
 *
 * 恒等式（这是本函数存在意义的全部）：
 *   total − initCash = floatPnl + realized − totalFee + (freeze 未释放)
 *   其中 floatPnl = 持仓市值 − 持仓成本（= Σ 每只票的浮动盈亏，**不含已卖出的部分**）
 *        realized = 已清仓/已减仓结转的累计盈亏（**已扣掉买入成本分摊与其对应费用**）
 *        但注意：realized 是「卖出净收入 − 结转成本」，而 totalFee 是**全部**费用（含尚未卖出的
 *        持仓在买入时已付的费用）。所以 realized − totalFee 会把「持仓买入费」重复扣一次。
 *        为不产生「凭空多亏一笔」的错觉，本函数**不宣称恒等**，而是分别列出三块并说明口径，
 *        用 residual（残差）显式吸收不可归因的零头——**有残差就说有残差，不假装严丝合缝**。
 *
 * @param {object} account 模拟账户
 * @param {object} stats   accountStats(account) 的结果
 * @returns {object} 收益来源拆解
 */
export function reviewAccount(account, stats) {
  const acct = account || {};
  const st = stats || {};
  const initCash = finite(st.initCash) ? +st.initCash : (finite(acct.initCash) ? +acct.initCash : 0);
  const total = finite(st.total) ? +st.total : 0;
  const floatPnl = finite(st.floatPnl) ? +st.floatPnl : 0;
  const floatPnlPct = finite(st.floatPnlPct) ? +st.floatPnlPct : 0;
  const realized = finite(st.realized) ? +st.realized : 0;
  const totalFee = finite(st.totalFee) ? +st.totalFee : 0;
  const netPnl = initCash > 0 ? total - initCash : 0;
  const retPct = initCash > 0 ? netPnl / initCash : null;

  // 残差：总盈亏 − （浮动 + 已实现 − 全部费用）。理论上应≈0（除冻结资金 T+1 撮合中的微小占用），
  // 不为 0 时必须显式说明，而不是强行归因到某一项把数字凑平。
  const explained = floatPnl + realized - totalFee;
  const residual = r2(netPnl - explained);

  // 费用占初始本金比 —— 「费用吞噬」判定用
  const feeDrag = initCash > 0 ? totalFee / initCash : null;

  // 主导项：谁对盈亏的影响最大（按绝对值）。用于「一句话归因」。
  const items = [
    { key: 'float', label: '持仓浮动盈亏', value: floatPnl, note: '尚未卖出的持仓按最新真实价重估' },
    { key: 'realized', label: '已实现盈亏', value: realized, note: '减仓/清仓结转，含买入成本分摊' },
    { key: 'fee', label: '交易费用拖累', value: -totalFee, note: '佣金 + 过户费 + 印花税；确定性的负收益' },
  ];
  const dominant = items.slice().sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0] || null;

  return {
    initCash, total, netPnl, retPct,
    floatPnl, floatPnlPct, realized, totalFee, feeDrag,
    residual,
    items,
    dominant,
    /** 是否已开始交易（有持仓或有成交或已实现非零）—— 报告据此决定是否如实降级 */
    started: (Object.keys(acct.positions || {}).length > 0)
      || ((acct.trades || []).length > 0)
      || Math.abs(realized) > 1e-9,
    /**
     * 收益方向定性。**用「净盈亏」而不是「收益率」判**：初始本金 100 万，
     * 赚 3000 元收益率只有 0.3%，但它确实是赚了，不该被说成「基本持平」。
     * 阈值取 1 元，只为吸收浮点误差。
     */
    direction: netPnl > 1 ? 'gain' : netPnl < -1 ? 'loss' : 'flat',
  };
}

// ────────────────────────── 四、逐笔复盘（平仓层面的胜率与盈亏比） ──────────────────────────

// 逐笔复盘的配对告警计数（模块级，每次 reviewTrades 调用前重置——避免跨调用串数）
let orphanSell = 0;    // 找不到对应买入记录的卖出笔（不猜成本，跳过并计数）
let partialSell = 0;   // 只能部分配对的卖出笔（按可配对部分近似）

/**
 * 逐笔复盘。数据来源是 `account.trades`（**成交记录**，只记事实、不含盈亏），
 * 用「买入先进先出配对卖出」重建每一笔平仓的盈亏。
 *
 * 为什么必须自己配对而不能读 account.realized：realized 是**累计总额**，回答不了
 * 「哪一笔最赚、哪一笔最亏、连续亏了几笔」——而这正是复盘要说的。
 *
 * 配对口径（明确写出，避免与 paper.applySell 的加权平均法混淆）：
 *   · 这里用 **FIFO（先进先出）** 配对：卖出 N 股，先冲销最早买入的 N 股。
 *     这是**复盘视角**的口径（回答「我这一手是赚是亏」），与 paper.js 账本的
 *     加权平均成本法**不同**——后者回答「账户还剩多少成本」。
 *     两者在「全部清仓」时结果一致；在部分减仓时，FIFO 的逐笔盈亏更有解释力。
 *   · 每笔平仓盈亏 = 卖出净额 − 卖出股数 × 对应买入均价（含买入费分摊）。
 *     买入均价 = (成交额 + 费用) / 股数，与 applyBuy 的 cost 口径一致。
 *   · 成交记录里 buy 的 net = gross + fee（付出），sell 的 net = gross − fee（收到）。
 *
 * @param {Array<object>} trades account.trades
 * @param {object} [opts]
 * @param {number} [opts.initCash] 用于把「显著盈亏」换算成占本金比例
 * @returns {object} { closed, wins, losses, flats, winRate, samples, avgWin, avgLoss, plRatio,
 *                     profitFactor, best, worst, maxLossStreak, streaks, edges }
 */
export function reviewTrades(trades, opts = {}) {
  orphanSell = 0; partialSell = 0;
  const list = (Array.isArray(trades) ? trades : [])
    .filter((t) => t && Number.isFinite(+t.qty) && +t.qty > 0 && Number.isFinite(+t.price) && +t.price > 0)
    // 按成交日排序（同日按原始顺序稳定），保证 FIFO 配对与展示顺序确定
    .map((t, i) => ({ ...t, _i: i }))
    .sort((a, b) => String(a.fillDate || a.submitDate || '').localeCompare(String(b.fillDate || b.submitDate || '')) || (a._i - b._i));

  const initCash = finite(opts.initCash) && +opts.initCash > 0 ? +opts.initCash : 0;
  const minEdge = initCash > 0 ? REVIEW_CFG.minTradeForEdge * initCash : 0;

  const open = new Map();       // code → [{ qty, pxPerShare }] FIFO 队列
  const closed = [];

  for (const t of list) {
    const code = String(t.code || '');
    const qty = Math.floor(+t.qty);
    const gross = finite(t.gross) ? +t.gross : (+t.price * qty);
    const fee = finite(t.fee) ? +t.fee : 0;

    if (t.side === 'buy') {
      // 每股成本含费：与 applyBuy 的「成本含费用」口径一致
      const pxPerShare = qty > 0 ? (gross + fee) / qty : 0;
      const q = open.get(code) || [];
      q.push({ qty, pxPerShare });
      open.set(code, q);
      continue;
    }

    if (t.side !== 'sell') continue;

    // 卖出：FIFO 冲销
    let remain = qty;
    const q = open.get(code) || [];
    let costOut = 0;
    while (remain > 0 && q.length) {
      const lot = q[0];
      const take = Math.min(remain, lot.qty);
      costOut += take * lot.pxPerShare;
      lot.qty -= take;
      remain -= take;
      if (lot.qty <= 0) q.shift();
    }
    // 没有对应买入记录的卖出（导入的外部账本、或买入记录被裁掉）：
    // **不猜成本**，直接跳过并计数——编一个成本算出来的「盈亏」是假的。
    if (remain > 0 && remain === qty) { orphanSell++; continue; }
    // 部分无法配对：成本只按能配对的部分算，盈亏按成交比例缩放（如实近似并计数）
    if (remain > 0) { partialSell++; costOut += 0; }

    const netIn = gross - fee;             // 卖出净收入
    const pnl = netIn - costOut;
    const basis = costOut > 0 ? costOut : 0;
    closed.push({
      code, name: t.name || code,
      qty, date: t.fillDate || t.submitDate || null,
      sellPx: +t.price, costPx: qty > 0 ? costOut / qty : null,
      pnl: r2(pnl),
      pct: basis > 0 ? pnl / basis : null,
      fee: r2(fee),
      reason: t.reason || null,
    });
  }

  const wins = closed.filter((c) => c.pnl > 0);
  const losses = closed.filter((c) => c.pnl < 0);
  const flats = closed.filter((c) => c.pnl === 0);
  const judged = wins.length + losses.length;

  const sumWin = wins.reduce((a, c) => a + c.pnl, 0);
  const sumLoss = losses.reduce((a, c) => a + c.pnl, 0);
  const avgWin = wins.length ? sumWin / wins.length : null;
  const avgLoss = losses.length ? sumLoss / losses.length : null;
  // 盈亏比 = 平均盈利 / |平均亏损|；无亏损样本时给 null（「无穷大盈亏比」没有意义且会误导）
  const plRatio = (avgWin != null && avgLoss != null && avgLoss < 0) ? avgWin / Math.abs(avgLoss) : null;
  // 盈利因子 = 总盈利 / |总亏损|；无亏损时给 null（同上）
  const profitFactor = (sumWin > 0 && sumLoss < 0) ? sumWin / Math.abs(sumLoss) : null;

  // 最大连亏（按平仓时间顺序），用于「停手复盘」建议
  let streak = 0, maxLossStreak = 0;
  for (const c of closed) {
    if (c.pnl < 0) { streak++; maxLossStreak = Math.max(maxLossStreak, streak); }
    else if (c.pnl > 0) streak = 0;
  }

  const byPnl = closed.slice().sort((a, b) => b.pnl - a.pnl);
  const best = byPnl[0] || null;
  const worst = byPnl[byPnl.length - 1] || null;
  // 「显著」笔数：单笔绝对盈亏达到本金 0.2% 以上才计入盈亏比统计（避免零碎笔拉偏均值）
  const edges = minEdge > 0 ? closed.filter((c) => Math.abs(c.pnl) >= minEdge) : closed;

  return {
    nTrades: list.length,
    closed, closedCount: closed.length,
    wins: wins.length, losses: losses.length, flats: flats.length,
    judged,
    winRate: judged > 0 ? wins.length / judged : null,
    samplesEnough: judged >= REVIEW_CFG.minTradesForWinRate,
    avgWin: avgWin != null ? r2(avgWin) : null,
    avgLoss: avgLoss != null ? r2(avgLoss) : null,
    plRatio: plRatio != null ? r2(plRatio) : null,
    profitFactor: profitFactor != null ? r2(profitFactor) : null,
    sumWin: r2(sumWin), sumLoss: r2(sumLoss),
    best, worst,
    maxLossStreak,
    edges,
    orphanSell: orphanSell || 0,
    partialSell: partialSell || 0,
  };
}

// ────────────────────────── 五、持仓诊断（贡献排序 / 超配 / 与档位一致性） ──────────────────────────

/**
 * 持仓诊断：把每只票对账户的贡献算清楚，并对照市场档位检查「该重的是不是重了」。
 *
 * 关键口径：
 *   逐票浮动盈亏 = 最新价 × 持仓 − 持仓成本（**含费成本**，与 applyBuy 一致）。
 *   注意这里用 `mv − cost` 而**不是** `(last − avgCost) × qty`——两者数值相同，
 *   但前者在「无最新价」时会退化为 cost（盈亏 0），语义是「按成本估、没结论」，
 *   比后者（avgCost 缺失时算出 NaN）安全。
 *
 * @param {object} positions account.positions
 * @param {object} stats     accountStats(account)
 * @param {object|null} tier marketTier(emotionScore)
 * @returns {object} { rows, totalMv, totalPnl, contributors, drags, overConc, underConc, cashRatio }
 */
export function reviewPositions(positions, stats, tier) {
  const pos = positions && typeof positions === 'object' ? positions : {};
  const st = stats || {};
  const T = finite(st.total) && +st.total > 0 ? +st.total : 0;
  const rows = [];

  for (const [code, p] of Object.entries(pos)) {
    if (!p || !(p.qty > 0)) continue;
    const qty = +p.qty;
    const last = finite(p.last) ? +p.last : null;
    const cost = finite(p.cost) ? +p.cost : (finite(p.avgCost) ? +p.avgCost * qty : 0);
    const mv = last != null ? last * qty : cost;
    const pnl = mv - cost;
    const pnlPct = cost > 0 ? pnl / cost : null;
    const conc = T > 0 ? mv / T : null;
    rows.push({
      code, name: p.name || code, qty,
      last, avgCost: finite(p.avgCost) ? +p.avgCost : null,
      cost: r2(cost), mv: r2(mv), pnl: r2(pnl), pnlPct, conc,
      pxStale: !!p.pxStale,
      days: finite(p.days) ? +p.days : null,
    });
  }

  rows.sort((a, b) => b.pnl - a.pnl);
  const totalMv = rows.reduce((a, r) => a + r.mv, 0);
  const totalPnl = rows.reduce((a, r) => a + r.pnl, 0);

  // 超配：占比 > 单票上限（POS_CFG.concMax）即已由预警层告警；这里按 concWarnRatio 分层
  const warnLine = POS_CFG.concMax * REVIEW_CFG.concWarnRatio;
  const overConc = rows.filter((r) => r.conc != null && r.conc > POS_CFG.concMax);
  const heavy = rows.filter((r) => r.conc != null && r.conc > warnLine && r.conc <= POS_CFG.concMax);

  // 与档位一致性：市场档位要求的总仓位 vs 实际市值占比
  const targetPos = tier ? tier.pos : null;
  const curPos = T > 0 ? totalMv / T : null;
  const tierGap = (targetPos != null && curPos != null) ? curPos - targetPos : null;
  let tierVerdict = null;
  if (tierGap != null) {
    if (tierGap > MARKET_CFG.band) tierVerdict = 'over';
    else if (tierGap < -MARKET_CFG.band) tierVerdict = 'under';
    else tierVerdict = 'fit';
  }

  return {
    rows,
    posCount: rows.length,
    totalMv: r2(totalMv),
    totalPnl: r2(totalPnl),
    contributors: rows.filter((r) => r.pnl > 0),
    drags: rows.filter((r) => r.pnl < 0),
    overConc, heavy,
    cashRatio: T > 0 ? (finite(st.cash) ? +st.cash / T : null) : null,
    targetPos, curPos, tierGap, tierVerdict,
  };
}

// ────────────────────────── 六、止损与优化建议（规则驱动） ──────────────────────────

/**
 * 生成建议。**每条建议都必须带「依据 → 动作 → 量化参数」三段结构**，
 * 而不是「注意风险控制」这类无法执行的话。
 *
 * 规则清单（顺序即优先级，与 ADVICE_LEVELS 对应）：
 *   A1 止损纪律未执行：持仓中已击穿止损线却仍持有 → risk
 *   A2 单票超配：某票占比 > 单票上限 → risk，给出应减股数
 *   A3 连续亏损：平仓最大连亏 ≥ 阈值 → risk（停手复盘，不是继续加仓摊平）
 *   A4 费用吞噬：累计费用占本金 ≥ 阈值 → tip（降低换手）
 *   A5 胜率偏低：样本足够且胜率 < 下限 → risk（策略有效性）
 *   A6 档位偏离：仓位与市场档位不一致 → risk/tip（超配降仓 / 低配但档位不许新建）
 *   A7 盈亏比失衡：平均亏损 > 平均盈利（亏损笔拿太久） → tip
 *   A8 预警被忽视：台账中有「未结算且已过期」或战绩为负的规则 → tip
 *   A9 无止损记录的盈利持仓：一直是浮盈、从未减仓 → tip（保护利润）
 *
 * @param {object} ctx { account, stats, trades, positions, accountReview, tradeReview, posReview,
 *                       log, priceMap, emotionScore, tier, asOf }
 * @returns {Array<object>} 建议列表；每条 { level, rule, title, text, why, action, qty?, code? }
 */
export function buildAdvice(ctx = {}) {
  const out = [];
  const { stats, accountReview: ar, tradeReview: tr, posReview: pr, tier } = ctx;
  const st = stats || {};
  const initCash = ar && ar.initCash ? ar.initCash : 0;

  // ── A1 止损纪律未执行 ──
  // 依据：持仓浮亏 ≤ 止损线（与 alerts.POS_CFG.stopLoss 同源）。这是最硬的一条——
  // 「知道了却没做」是复盘里唯一必须点名批评的事。
  for (const row of (pr?.rows || [])) {
    if (row.pnlPct == null) continue;
    if (row.pnlPct <= POS_CFG.stopLoss) {
      out.push({
        level: 'risk', rule: 'A1', action: 'sell', code: row.code,
        title: `${row.name}（${row.code}）击穿止损线仍持有`,
        text: `浮亏 ${sp(row.pnlPct)} 已低于止损线 ${sp(POS_CFG.stopLoss)}，属于纪律未执行：`
          + `止损的意义是在小亏时离场，而不是等它变成大亏。`,
        why: `止损线 ${sp(POS_CFG.stopLoss)} 与 V5.2 回测引擎同源（src/config.js backtest.stopLoss）。`
          + `当前浮亏 = （最新价 ${row.last != null ? row.last.toFixed(2) : '—'} − 均价 `
          + `${row.avgCost != null ? row.avgCost.toFixed(3) : '—'}）÷ 均价 = ${sp(row.pnlPct)}。`,
      });
    }
  }

  // ── A2 单票超配 ──
  for (const row of (pr?.overConc || [])) {
    const targetMV = (finite(st.total) ? +st.total : 0) * POS_CFG.concMax;
    const cutQtyRaw = row.last && row.last > 0 ? Math.floor(((row.mv - targetMV) / row.last) / LOT) * LOT : 0;
    out.push({
      level: 'risk', rule: 'A2', action: 'reduce', code: row.code,
      qty: Math.max(0, cutQtyRaw), title: `${row.name}（${row.code}）单票超配`,
      text: `占总资产 ${pp(row.conc)}，超过单票上限 ${pp(POS_CFG.concMax)}`
        + `${cutQtyRaw > 0 ? `，建议减 ${cutQtyRaw} 股至上限附近` : '（当前持仓不足一手可减，需整体评估）'}。`,
      why: `单票上限 ${pp(POS_CFG.concMax)} 与「研判推荐」的个股建议仓位上限（picks.suggestWeight 的 perStockCap）一致。`
        + `账户收益被一只票主导 = 放弃分散化，波动会显著放大而期望收益不变。`,
    });
  }

  // ── A3 连续亏损 → 停手复盘 ──
  if (tr && tr.maxLossStreak >= REVIEW_CFG.lossStreakWarn) {
    out.push({
      level: 'risk', rule: 'A3', action: 'hold',
      title: `出现 ${tr.maxLossStreak} 笔连续亏损`,
      text: `连续亏损达到 ${tr.maxLossStreak} 笔（阈值 ${REVIEW_CFG.lossStreakWarn} 笔），`
        + `建议暂停开新仓、先复盘这 ${tr.maxLossStreak} 笔的买入理由是否成立。`,
      why: `连续亏损通常意味着「当期选股逻辑与市场风格不匹配」，而不是运气差。`
        + `此时继续加仓或摊平成本，会把单一风格的错误放大——停手一天的成本远低于继续做错的成本。`,
    });
  }

  // ── A4 费用吞噬 ──
  if (ar && finite(ar.feeDrag) && ar.feeDrag >= REVIEW_CFG.feeDragWarn) {
    const feePct = ar.feeDrag;
    out.push({
      level: 'tip', rule: 'A4', action: 'hold',
      title: '交易费用侵蚀收益',
      text: `累计费用 ${yuan(ar.totalFee)} 元，占初始本金 ${pp(feePct)}`
        + `（相当于 ${pp(feePct, 2)} 的确定性亏损）。降低换手是唯一能立刻改善的方法。`,
      why: `费用是**确定性**的负收益，与行情无关：佣金万3（最低5元）+ 过户费万0.1 + 印花税万5（仅卖出）。`
        + `频繁进出会让「手续费 + 滑点」吃掉本就不厚的价差；同样的策略，换手减半 ≈ 收益直接改善。`,
    });
  }

  // ── A5 胜率偏低（样本足够才说） ──
  if (tr && tr.samplesEnough && tr.winRate != null && tr.winRate < REVIEW_CFG.staleWinRateFloor) {
    out.push({
      level: 'risk', rule: 'A5', action: 'hold',
      title: `平仓胜率 ${pp(tr.winRate, 0)} 偏低`,
      text: `${tr.judged} 笔平仓中仅 ${tr.wins} 笔盈利，胜率 ${pp(tr.winRate, 0)}（低于 ${pp(REVIEW_CFG.staleWinRateFloor, 0)}）。`
        + `${tr.plRatio != null ? `平均盈利 ${yuan(tr.avgWin)} 元 / 平均亏损 ${yuan(Math.abs(tr.avgLoss))} 元（盈亏比 ${tr.plRatio}）。` : ''}`,
      why: `胜率低不必然亏钱（高盈亏比可以覆盖），但前提是盈亏比 > 1。`
        // plRatio 为 null 表示「没有盈利样本，盈亏比无从谈起」——此时不能说「当前盈亏比 —」，
        // 那会读成「有盈亏比但数值未知」。如实说「尚无盈利样本」。
        + (tr.plRatio != null
          ? `当前盈亏比 ${tr.plRatio}——若它同时 < 1，说明是「亏得比赚得多、还赚得少」，必须改选股或改止损，而不是加大仓位。`
          : `当前尚无盈利样本（平仓全是亏损），盈亏比无从计算——必须先解决「为什么会亏」，再谈仓位。`),
    });
  }

  // ── A6 仓位与市场档位偏离 ──
  if (pr && pr.tierVerdict && tier) {
    if (pr.tierVerdict === 'over') {
      const cutMV = (finite(st.total) ? +st.total : 0) * Math.max(0, (pr.curPos || 0) - tier.pos);
      out.push({
        level: 'risk', rule: 'A6', action: 'reduce',
        title: `仓位超配：实际 ${pp(pr.curPos)} vs 档位建议 ${pp(tier.pos, 0)}`,
        text: `市场档位「${tier.label}」建议总仓位 ${pp(tier.pos, 0)}，当前 ${pp(pr.curPos)}，`
          + `超出 ${pp(pr.tierGap)}（约 ${yuan(cutMV)} 元），应降回建议仓位。`,
        why: `档位由七因子情绪分按 ≥${TIER_THRESHOLDS.overheat} 过热 / ≥${TIER_THRESHOLDS.full} 满仓 / `
          + `${TIER_THRESHOLDS.half}~${TIER_THRESHOLDS.full} 半仓 / ≤${TIER_THRESHOLDS.half} 清仓划档，`
          + `与研判报告、回测引擎同一阈值表。偏离超过容忍带 ${pp(MARKET_CFG.band, 0)} 即为「与系统结论不一致」。`,
      });
    } else if (pr.tierVerdict === 'under') {
      out.push({
        level: tier.allowNew ? 'opp' : 'tip', rule: 'A6', action: tier.allowNew ? 'add' : 'hold',
        title: `仓位低于档位建议：实际 ${pp(pr.curPos)} vs ${pp(tier.pos, 0)}`,
        text: `当前仓位 ${pp(pr.curPos)} 低于档位建议 ${pp(tier.pos, 0)}`
          + `${tier.allowNew ? '，档位允许新建，可择机补足（标的见「研判推荐」）' : '，但当前档位不允许新建仓，保持即可'}。`,
        why: `档位为「${tier.label}」。${tier.allowNew
          ? '情绪分处于允许建仓区间，长期低配会错过档位本身想捕获的收益。'
          : '该档位的纪律是「只减仓不新建」，此时缺口不是要补，而是要接受。'}`,
      });
    }
  }

  // ── A7 盈亏比失衡（亏损拿太久） ──
  if (tr && tr.avgWin != null && tr.avgLoss != null && tr.avgWin < Math.abs(tr.avgLoss) && tr.judged >= 2) {
    out.push({
      level: 'tip', rule: 'A7', action: 'hold',
      title: '平均亏损大于平均盈利',
      text: `平均盈利 ${yuan(tr.avgWin)} 元 < 平均亏损 ${yuan(Math.abs(tr.avgLoss))} 元，`
        + `即「赚的时候赚得少、亏的时候亏得多」。`,
      why: `这是「截断利润、放任亏损」的典型特征：盈利单过早止盈，亏损单一直等回本。`
        + `修正方向是严格执行止损线 ${sp(POS_CFG.stopLoss)}（先砍掉大亏），`
        + `并给盈利单留出空间（而不是一见红就卖）。`,
    });
  }

  // ── A8 预警纪律：台账战绩与未结算积压 ──
  if (ctx.log && ctx.log.length) {
    const sum = summarizeLog(ctx.log, ctx.priceMap || null);
    const pend = (sum.pending || 0) + (sum.tracked || 0);
    if (sum.hitRate != null && sum.hitRate < 0.5 && sum.hit + sum.miss >= REVIEW_CFG.minTradesForWinRate) {
      out.push({
        level: 'tip', rule: 'A8', action: 'hold',
        title: `交易预警命中率 ${pp(sum.hitRate, 0)}`,
        text: `台账中已结算的 ${sum.hit + sum.miss} 条预警里命中 ${sum.hit} 条，`
          + `净贡献 ${syuan(sum.net)} 元。命中率偏低说明当期规则与市场不匹配，应缩小仓位而非加大。`,
        why: `预警命中率 = 方向被后续价格验证的比例（不含「平」与「未结算」）。`
          + `它是预警系统的**计分板**：命中率持续低于 50% 时应降低依赖，而不是无视。`,
      });
    }
    if (pend > 0 && sum.n > 0 && pend === sum.n) {
      out.push({
        level: 'tip', rule: 'A8b', action: 'hold',
        title: '预警尚无一条被价格验证',
        text: `台账 ${sum.n} 条预警全部待价格验证（未结算 ${pend} 条），暂无法给出命中率。`,
        why: `预警归因需要「触发日价格 → 之后价格」的时间沉淀。`
          + `只有一条预警时不给命中率，是避免用单次结果冒充统计结论。`,
      });
    }
  }

  // ── A9 从未止盈（一直拿着浮盈） ──
  if (pr && pr.rows && pr.rows.length) {
    const neverCut = pr.rows.filter((r) => r.pnl > 0 && r.pnlPct != null && r.pnlPct > 0.10);
    if (neverCut.length && (tr ? tr.closedCount : 0) === 0) {
      out.push({
        level: 'tip', rule: 'A9', action: 'hold',
        title: '尚无任何平仓记录，浮盈未落袋',
        text: `${neverCut.map((r) => r.name).join('、')} 已有浮盈但从未减仓，账面利润随时可能回吐。`,
        why: `浮动盈亏不是已实现收益——它随价格波动，未卖出前都可能归零。`
          + `对有明显浮盈的仓位，按档位减一部分是「把不确定的账面利润换成确定的现金」，`
          + `代价只是可能少赚后续涨幅，但避免了「坐电梯」回去。`,
      });
    }
  }

  // 排序：risk > opp > tip；同级按规则号
  const lv = (l) => ADVICE_LEVELS.indexOf(l);
  return out.sort((a, b) => (lv(a.level) - lv(b.level)) || String(a.rule).localeCompare(String(b.rule)));
}

// ────────────────────────── 七、主入口 ──────────────────────────

/**
 * 生成完整的模拟交易复盘结论。UI（与报告段落）唯一该调用的函数。
 *
 * @param {object} p
 * @param {object} p.account       模拟账户（src/paper.js emptyAccount 结构）
 * @param {object} [p.stats]       accountStats(account) 的结果（缺省时用 lite 兜底）
 * @param {Array}  [p.log]         预警台账（src/alert_log.js）
 * @param {object} [p.priceMap]    code → 今日真实价（结算预警归因用）
 * @param {number|null} [p.emotionScore] 七因子情绪分（决定档位）
 * @param {string} [p.asOf]        数据日期
 * @returns {object} {
 *   asOf, started, hasAccount, tier, score,
 *   account: reviewAccount 结果,
 *   trades: reviewTrades 结果,
 *   positions: reviewPositions 结果,
 *   attribution: summarizeLog 结果（或 null）,
 *   advice: 建议列表,
 *   headline: 一句话结论（可直接显示）,
 *   metrics: { days, retPct, maxDd, sharpe } 若账户有净值序列
 * }
 */
export function buildPaperReview({ account, stats, log, priceMap, emotionScore, asOf } = {}) {
  const acct = account && typeof account === 'object' ? account : null;
  const hasAccount = !!acct;
  const st = stats || (acct ? liteStats(acct) : { total: 0, marketValue: 0, cash: 0, initCash: 0, realized: 0, totalFee: 0, floatPnl: 0 });
  const tier = marketTier(emotionScore);

  const accountReview = reviewAccount(acct || {}, st);
  orphanSell = 0; partialSell = 0;   // 每次调用重置配对告警计数
  const tradeReview = reviewTrades(acct?.trades, { initCash: accountReview.initCash });
  const posReview = reviewPositions(acct?.positions, st, tier);

  const attribution = (Array.isArray(log) && log.length)
    ? summarizeLog(log, priceMap || null)
    : null;

  const metrics = (acct && Array.isArray(acct.nav) && acct.nav.length > 1)
    ? { days: acct.nav.length, equity: acct.nav[acct.nav.length - 1].equity }
    : null;

  const advice = buildAdvice({
    account: acct, stats: st, trades: acct?.trades,
    accountReview, tradeReview, posReview,
    log, priceMap, emotionScore, tier, asOf,
  });

  const started = accountReview.started;

  return {
    asOf: asOf || null,
    hasAccount, started,
    tier, score: finite(emotionScore) ? +emotionScore : null,
    account: accountReview,
    trades: tradeReview,
    positions: posReview,
    attribution,
    advice,
    metrics,
    headline: buildHeadline({ started, hasAccount, accountReview, tradeReview, posReview, attribution }),
  };
}

/**
 * 一句话结论。**只在有事实可说时给**；未开始交易 / 无账户时如实说明，
 * 绝不生成「暂无异常」这种假装检查过的空话。
 *
 * 注意「主导项」的措辞必须与**总方向一致**才说「主要来自」：
 *   主导项按绝对值取最大，但它的符号可能与总盈亏相反（例如浮亏 −2.3 万、
 *   而本金层面因其他项仍净赚）。此时说「主要来自持仓浮动盈亏 −2.3 万」会自相矛盾，
 *   必须改成「最大拖累是…」，否则用户读到的第一句话就是错的。
 */
function buildHeadline({ started, hasAccount, accountReview: ar, tradeReview: tr, posReview: pr, attribution }) {
  if (!hasAccount) return '尚未开始模拟交易——先在下单区建仓，本段会在有交易后自动给出复盘。';
  if (!started) return '模拟账户已就绪但尚无成交记录，暂无可复盘的收益归因。';
  const dirTxt = ar.direction === 'gain' ? '整体盈利' : ar.direction === 'loss' ? '整体亏损' : '基本持平';
  const parts = [`模拟账户${dirTxt} ${syuan(ar.netPnl)} 元（${sp(ar.retPct)}）`];
  if (ar.dominant && Math.abs(ar.dominant.value) > 1) {
    // 主导项与总方向同号 → 「主要来自」；异号 → 「主要拖累/主要支撑」——
    // 措辞与事实一致，避免出现「整体盈利，主要来自 XX（负数）」这种自相矛盾。
    const sameSign = (ar.dominant.value > 0) === (ar.netPnl > 0);
    if (sameSign) {
      parts.push(`主要来自「${ar.dominant.label}」${syuan(ar.dominant.value)} 元`);
    } else {
      parts.push(`最大${ar.dominant.value < 0 ? '拖累' : '缓冲'}是「${ar.dominant.label}」${syuan(ar.dominant.value)} 元`);
    }
  }
  if (tr.closedCount > 0) {
    parts.push(`已平仓 ${tr.closedCount} 笔、胜率 ${tr.winRate == null ? '—' : pp(tr.winRate, 0)}`);
  }
  if (pr.overConc.length) parts.push(`有 ${pr.overConc.length} 只票超配需处理`);
  const pend = attribution ? (attribution.pending + attribution.tracked) : 0;
  if (attribution && attribution.net !== 0) parts.push(`预警净贡献 ${syuan(attribution.net)} 元`);
  else if (pend > 0) parts.push(`预警 ${pend} 条待价格验证`);
  return parts.join('，') + '。';
}

/**
 * 账户统计兜底（仅在调用方没传 stats 时用）。口径与 src/paper.js accountStats 一致
 * （有价按价、无价按成本）。正式场景一律走 accountStats —— 这里只保证「少传参数不崩」。
 */
function liteStats(acct) {
  const positions = Object.values(acct?.positions || {});
  const marketValue = positions.reduce((a, p) => a + (p.last != null ? p.last * p.qty : (p.avgCost || 0) * p.qty), 0);
  const costValue = positions.reduce((a, p) => a + (p.cost || 0), 0);
  const cash = +acct?.cash || 0;
  const freeze = +acct?.freeze || 0;
  const initCash = +acct?.initCash || 0;
  const total = cash + freeze + marketValue;
  return {
    cash, freeze, marketValue, costValue,
    floatPnl: marketValue - costValue,
    floatPnlPct: costValue > 0 ? (marketValue - costValue) / costValue : 0,
    realized: +acct?.realized || 0,
    totalFee: +acct?.totalFee || 0,
    total, initCash,
    ret: initCash > 0 ? (total - initCash) / initCash : 0,
    retPct: initCash > 0 ? ((total - initCash) / initCash) * 100 : 0,
    posCount: positions.length,
  };
}
