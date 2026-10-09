// 模拟交易引擎（Node ESM + 浏览器共用，纯函数、零依赖）
//
// 设计原则（与 src/lhb.js、src/global.js 同一套纪律）：
//   1. 只有「钱」是假的（初始虚拟资金），其余全部按真实来——
//      价格来自真实行情存档、交易日历来自真实休市安排、交易规则逐条对齐 A 股现行制度。
//   2. 所有规则常量集中在本文件，并在文件内注明依据；不散落到 UI。
//   3. 账本用「分」为单位的整数做累计，避免浮点误差累积（A股最小价格变动 0.01 元）。
//   4. 拒绝下单必须给出可读原因码，UI 只负责翻译——不要把判断写在界面里。
//
// A 股交易规则依据（本文件实现范围）：
//   · T+1：当日买入的股份次一交易日起才可卖出（本文件按「交易日」推进，不做分钟级 T+0）
//   · 申报单位：买入必须为 100 股整数倍；卖出可为零股（余额不足 100 股须一次性全部卖出）
//   · 价格笼子：主板 ±10%、创业板/科创板 ±20%、北交所 ±30%、ST/*ST ±5%、新股上市首日另有规则
//   · 费用：佣金（双边、按成交额，最低 5 元）、过户费（双边 0.001%）、印花税（仅卖出 0.05%）
//   · 资金：买入可用资金须 ≥ 成交额 + 费用；卖出所得当日可用于买入（T+1 只约束股份，不约束资金）
//
// 已知简化（在页面与详情抽屉里显式标注，不藏）：
//   · 不支持融资融券 / 融券做空 / 打新 / 可转债 / 盘后固定价交易
//   · 不做盘中撮合：委托在「下一交易日」按该日真实收盘价成交，因此不模拟集合竞价、盘中撤单。
//     之所以采取 T+1 撮合而非当日成交，是因为本系统的数据是「收盘后生成」的日频存档——
//     用当日收盘价成交等于让人在收盘后以已知价格下单，是可笑的「后视镜作弊」。
//     T+1 撮合消除了这个前视偏差：下单时你只知道今天的价，成交价是明天真实的价。
//   · 涨跌停按「板块默认幅度」判定，不逐票读取当日真实涨跌停价（存档无该字段）；
//     若要精确到分，需数据源提供涨跌停价——这是下一步可增强项
//   · ST 涨跌停幅度只在标的池 build 时按名称判定一次（存档无历史 ST 变更记录）
//
// 与 src/lhbfilter.js 的分工（V5.2-pro 规则第一块）：**所有买入委托的资格判定在 lhbfilter，
// 本文件只负责「资金与数量」，绝不在 validateOrder 里重复判断龙虎条件**。
// 引入方向是单向的（paper → lhbfilter → lhb/seats），lhbfilter 不反过来引 paper，无循环依赖。

import { filterOne } from './lhbfilter.js';

export const PAPER_VERSION = 'paper-v1';

// ────────────────────────── 一、真实交易制度常量 ──────────────────────────

export const LOT = 100;                    // 买入申报单位（股）
export const MIN_COMMISSION = 5;           // 单笔佣金最低收费（元）
export const COMMISSION_RATE = 0.0003;     // 佣金费率（万三，双边）
export const TRANSFER_FEE_RATE = 0.00001;  // 过户费（万0.1，双边；2022-04-29 起沪深统一）
export const STAMP_TAX_RATE = 0.0005;      // 印花税（万五，仅卖出）
export const DEFAULT_SLIP = 0.0002;        // 滑点（万二，买入抬价/卖出压价，模拟冲击成本）

// 涨跌停幅度（按板块 / 风险警示状态）
export const LIMIT_PCT = {
  main: 0.10,   // 沪深主板 ±10%
  gem: 0.20,    // 创业板 300xxx ±20%
  star: 0.20,   // 科创板 688xxx ±20%
  bj: 0.30,     // 北交所 8xxxxx/4xxxxx/92xxxx ±30%
  st: 0.05,     // ST / *ST ±5%
};

/**
 * 板段判定：只依据代码前缀，与 src/sources.js 的行情抓取前缀函数同一套口径。
 * 返回 { board, label, limitPct, tradable }。
 * 不纳入交易的范围（明确标注，而不是笼统归为「未知」）：
 *   · 可转债 11xxxx(沪)/12xxxx(深) —— T+0、无涨跌停、有强赎/回售，规则与股票完全不同
 *   · B 股 900xxx(沪)/200xxx(深) —— 以外币计价结算
 *   · 基金/ETF 15xxxx/16xxxx/51xxxx/58xxxx —— 无印花税、最小变动不同
 */
export function boardOf(code) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return { board: 'unknown', label: '未知', limitPct: null, tradable: false };
  // 可转债 / 可交换债
  if (/^(11|12)/.test(c)) return { board: 'cb', label: '可转债（暂不支持）', limitPct: null, tradable: false };
  // 基金 / ETF
  if (/^(15|16|50|51|52|56|58)/.test(c)) return { board: 'fund', label: '基金/ETF（暂不支持）', limitPct: null, tradable: false };
  // 北交所：8xxxxx（82/83/87/88 等）、4xxxxx（新三板转板前）、92xxxx
  if (/^(92|4[0-9]|8[0-9])/.test(c)) return { board: 'bj', label: '北交所', limitPct: LIMIT_PCT.bj, tradable: true };
  // 科创板 688 / 689
  if (/^68[89]/.test(c)) return { board: 'star', label: '科创板', limitPct: LIMIT_PCT.star, tradable: true };
  // 创业板 300 / 301
  if (/^30[01]/.test(c)) return { board: 'gem', label: '创业板', limitPct: LIMIT_PCT.gem, tradable: true };
  // 沪市主板 600/601/603/605；深市主板 000/001/002/003
  if (/^(60[0135])/.test(c)) return { board: 'shb', label: '沪市主板', limitPct: LIMIT_PCT.main, tradable: true };
  if (/^(00[0123])/.test(c)) return { board: 'szb', label: '深市主板', limitPct: LIMIT_PCT.main, tradable: true };
  // B 股：沪 900xxx / 深 200xxx —— 计价与结算规则不同（外币），模拟器不纳入
  if (/^(900|200)/.test(c)) return { board: 'b', label: 'B股（暂不支持）', limitPct: null, tradable: false };
  return { board: 'unknown', label: '未知板段（暂不支持）', limitPct: null, tradable: false };
}

/**
 * 名称是否风险警示（ST / *ST / SST / S*ST），决定 ±5% 幅度。
 * 注意不能加 i 标志：加了之后 "STAR科技" 这类正常公司名会被误判成 ST，
 * 幅度从 ±10% 错成 ±5%，涨跌停判定全错。故只用大写的 ST/SST，
 * 且要求 ST 后面紧跟非字母（中文/空格/数字）或结束。
 */
export const isStName = (name) => /^(\*ST|S\*?ST|ST)(?![A-Za-z])/.test(String(name || '').trim());

/** 当日涨跌停幅度：先看 ST（优先级最高），再看板段 */
export function limitPctOf(code, name) {
  if (isStName(name)) return LIMIT_PCT.st;
  const b = boardOf(code);
  return b.limitPct;
}

/**
 * 上涨/下跌停板？两级口径：
 *   · 精确口径（现价 + 昨收都可得时，实时源天然带）：停板价 = round(昨收 × (1±幅度), 2)，
 *     现价触及停板价 ±0.005 即触板。交易所停板价就是四舍五入到分的。
 *   · 近似口径（只有存档 change_pct 时）：|change_pct| ≥ 幅度 − 0.5pp 视为触板。
 *     容差 0.5pp 的代价：20cm 板涨 19.5%~19.99% **未封板**的收盘会被误判涨停
 *     （买入委托被错误失效）；10% 板涨 9.5%~9.99% 同理。故凡拿得到昨收就走精确口径。
 */
export function isLimitHit(changePct, code, name, tol = 0.5, price = null, prevClose = null) {
  const lim = limitPctOf(code, name);
  if (lim == null) return null;
  if (Number.isFinite(+prevClose) && +prevClose > 0 && Number.isFinite(+price) && +price > 0) {
    const up = round2(+prevClose * (1 + lim));
    const down = round2(+prevClose * (1 - lim));
    if (+price >= up - 0.005) return 'up';
    if (+price <= down + 0.005) return 'down';
    return null;
  }
  if (changePct == null || !Number.isFinite(+changePct)) return null;
  const p = Math.abs(+changePct);
  if (p >= lim * 100 - tol) return +changePct > 0 ? 'up' : 'down';
  return null;
}

// ────────────────────────── 二、费用（真实计价） ──────────────────────────

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * 单笔费用明细。买入：佣金+过户费；卖出：佣金+过户费+印花税。
 * 佣金按「不足 5 元按 5 元」收取——小额交易的实际成本率因此远高于万三，这是真实制度。
 */
export function fees(gross, side) {
  const comm = Math.max(MIN_COMMISSION, round2(gross * COMMISSION_RATE));
  const transfer = round2(gross * TRANSFER_FEE_RATE);
  const stamp = side === 'sell' ? round2(gross * STAMP_TAX_RATE) : 0;
  return { comm, transfer, stamp, total: round2(comm + transfer + stamp) };
}

/**
 * 含滑点的成交价（买方抬价 / 卖方压价），按分取整到最小价格变动。
 *
 * 关键：滑点必须「方向不丢」。低价股（如 2.76 元）万二滑点只有 0.00055 元，
 * 四舍五入到分就归零了——那等于低价股免滑点，与真实体验相反（低价股冲击成本占比更高）。
 * 因此：四舍五入后如果方向没有被体现，就按最小变动 0.01 元朝不利方向走一格。
 * 这是「宁可高估成本也不低估」的保守取法。
 */
export function fillPrice(price, side, slip = DEFAULT_SLIP) {
  const p = +price;
  if (!Number.isFinite(p) || p <= 0) return 0;
  const adj = side === 'buy' ? p * (1 + slip) : p * (1 - slip);
  let out = round2(adj);
  if (side === 'buy' && out <= p) out = round2(p + 0.01);
  if (side === 'sell' && out >= p) out = round2(p - 0.01);
  return Math.max(0.01, out);   // 卖出不能压到 0 以下
}

// ────────────────────── 二·B、仓位档位（建仓/减仓的「按比例」口径） ──────────────────────

/**
 * 仓位档位定义（唯一出处）。
 *
 * 买入用「占账户总资产的比例」，卖出用「占该票当前持仓的比例」——两者分母不同是刻意的：
 *   · 建仓说的是「这笔仓位在我整个账户里占多大」，分母自然是总资产（含已持股市值）；
 *     若用「可用资金」作分母，满仓买入会因分母缩水而永远买不到目标比例。
 *   · 减仓说的是「我把这只票卖掉多少」，分母自然是该票持仓，与账户其他部分无关。
 *
 * 档位取整：一律「向下取整到 100 股整手」——宁可少买一手，不可超出档位金额导致资金不足被拒。
 */
export const POS_TIERS = [
  { key: 'light', label: '轻仓', pct: 0.10, note: '10% 总资产' },
  { key: 'half', label: '半仓', pct: 0.50, note: '50% 总资产' },
  { key: 'heavy', label: '重仓', pct: 0.80, note: '80% 总资产' },
  { key: 'full', label: '满仓', pct: 1.00, note: '100% 总资产（买入口径，非清空资金）' },
];

/** 减仓档位（分母 = 该票当前可卖数量） */
export const CUT_TIERS = [
  { key: 'cut25', label: '减 1/4', pct: 0.25 },
  { key: 'cut50', label: '减 1/2', pct: 0.50 },
  { key: 'cut75', label: '减 3/4', pct: 0.75 },
];

/**
 * 按「占总额的比例」计算可买股数（含费用倒推，整手向下取整）。
 *
 * 为什么不能直接用 金额/价格：买入还要付佣金（最低 5 元）+ 过户费，只按裸价算会在
 * 临界点被资金校验拒绝（明明只想买"半仓"却提示资金不足）。这里用「预估成交额 + 费用」
 * 反推，并留 1 手的余量迭代收口，保证「按档位下单一定不会被资金不足拒掉」。
 *
 * @param {number} totalAssets 账户总资产（元）
 * @param {number} pct 目标比例 0~1
 * @param {number} price 预估成交价（已含滑点）
 * @param {object} [opts] { cash } 可用资金上限（默认不限，由调用方传 accountStats().cash 兜底）
 * @returns {{qty:number, gross:number, fee:number, need:number, capped:boolean}}
 *          qty 为 100 的整数倍；capped=true 表示受可用资金限制而未达目标比例
 */
export function qtyByAssetPct(totalAssets, pct, price, opts = {}) {
  const P = +price;
  const T = +totalAssets;
  const p = Math.max(0, Math.min(1, +pct || 0));
  if (!Number.isFinite(P) || P <= 0 || !Number.isFinite(T) || T <= 0) {
    return { qty: 0, gross: 0, fee: 0, need: 0, capped: false };
  }
  const budget = T * p;
  // 先按裸价粗估手数，再逐步回退到「成交额 + 费用 ≤ 预算」的最大整手数
  let lots = Math.floor(budget / (P * LOT));
  for (; lots > 0; lots--) {
    const gross = round2(lots * LOT * P);
    const fee = fees(gross, 'buy').total;
    if (gross + fee <= budget + 1e-6) break;
  }
  let qty = Math.max(0, lots) * LOT;
  // 零股不产生费用——fees(0,'buy') 会因「最低佣金 5 元」给出 5 元，那是"有成交才收"的规则，
  // 用在 0 股上会显示「需冻结 5 元」，属明显错误。故 qty=0 时费用与占用一律归零。
  if (qty <= 0) return { qty: 0, gross: 0, fee: 0, need: 0, capped: false };
  let gross = round2(qty * P);
  let fee = fees(gross, 'buy').total;
  let capped = false;
  // 受可用资金约束时再回退（买入不能用「总资产」里的已持股市值）
  const cash = opts.cash;
  if (Number.isFinite(+cash)) {
    while (qty > 0 && gross + fee > +cash) {
      qty -= LOT;
      if (qty <= 0) return { qty: 0, gross: 0, fee: 0, need: 0, capped: true };
      gross = round2(qty * P);
      fee = fees(gross, 'buy').total;
    }
    if (qty < Math.max(0, lots) * LOT) capped = true;
  }
  return { qty, gross, fee, need: round2(gross + fee), capped };
}

/**
 * 按「占该票可卖数量的比例」计算减仓股数（整手向下取整）。
 * 卖出无最低佣金外的整手约束（A 股允许卖出零股），但这里仍按整手给档位，
 * 避免「减 1/4」给出 37 股这类奇怪数字；「清仓」不走本函数，直接用全部可卖数。
 */
export function qtyByHoldPct(avail, pct) {
  const a = Math.floor(+avail || 0);
  if (a <= 0) return 0;
  const p = Math.max(0, Math.min(1, +pct || 0));
  const q = Math.floor((a * p) / LOT) * LOT;
  // 整手取整后为 0（例如可卖 100 股要「减 1/2」→ 0 手）时，退化为全部可卖：
  // 否则按钮点了没反应，用户会以为功能坏了。零股（不足 1 手）同理按全部。
  if (q <= 0) return a;
  return Math.min(a, q);
}


// ────────────────────────── 三、账本（以「分」累计，避免浮点漂移） ──────────────────────────

const toCents = (yuan) => Math.round(yuan * 100);
const toYuan = (cents) => cents / 100;

/**
 * 建仓记账（加权平均成本法，A股实务口径）。
 * 成本里含费用——否则「卖出价 = 买入价」会被读成不亏，与真实体验不符。
 */
export function applyBuy(pos, { qty, price, fee }) {
  const grossCents = toCents(price) * qty;
  const feeCents = toCents(fee);
  const totalCents = grossCents + feeCents;
  const newQty = pos.qty + qty;
  const newCostCents = toCents(pos.cost) + totalCents;
  return {
    qty: newQty,
    cost: toYuan(newCostCents),                       // 累计买入总成本（含费）
    avgCost: newQty > 0 ? toYuan(newCostCents / newQty) : 0,
    grossBuyCents: toCents(pos.grossBuy || 0) + grossCents,
    feeCents: toCents(pos.fee || 0) + feeCents,
    // 可卖数量属于「时点状态」，由 settleFreeze() 按持仓日推进，不在这里改
  };
}

/**
 * 卖出记账：按加权平均成本结转已实现盈亏。
 * 已实现盈亏 = 卖出净收入 − 卖出股份对应的成本（含买入时摊到的费用）。
 */
export function applySell(pos, { qty, price, fee }) {
  const avgCost = pos.avgCost || 0;
  const grossCents = toCents(price) * qty;
  const feeCents = toCents(fee);
  const netCents = grossCents - feeCents;
  // 成本结转必须按「持仓总成本 × 卖出比例」，不能写成 round(avgCost*100)*qty——
  // avgCost 是含费用的均价，天然带分摊不尽的零头（如 10.0053），一取整到分就会
  // 每 1000 股凭空多算/少算几元，且清仓时 cost 余额与已实现盈亏对不上。
  // 按比例切分保证：部分卖出后剩余成本 + 本次结转成本 = 原总成本（无零头丢失）。
  const costCents = toCents(pos.cost || 0);
  const costOutCents = pos.qty > 0
    ? (qty === pos.qty ? costCents : Math.round(costCents * qty / pos.qty))
    : 0;
  const realized = toYuan(netCents - costOutCents);
  const newQty = pos.qty - qty;
  const newCostCents = Math.max(0, costCents - costOutCents);
  return {
    qty: newQty,
    cost: newQty > 0 ? toYuan(newCostCents) : 0,
    avgCost: newQty > 0 ? toYuan(newCostCents / newQty) : 0,
    realized,
    feeCents: toCents(pos.fee || 0) + feeCents,
  };
}

// ────────────────────────── 四、账户 ──────────────────────────

export function emptyAccount(cash = 1000000, startDate = null) {
  return {
    version: PAPER_VERSION,
    initCash: cash,          // 虚拟本金（唯一「假」的东西）
    cash,                    // 可用资金
    freeze: 0,               // 冻结资金（买入挂单待成交时冻结，成交/失效后释放）
    positions: {},           // code → { code, name, qty, avail, avgCost, cost, last, openDate, days }
    orders: [],              // 全部委托（含被拒、含待成交）
    trades: [],              // 全部成交
    pending: [],             // 待成交委托（T+1 撮合队列）
    logs: [],                // 委托与拦截日志流（V5.2-pro 规则第六块）：每笔委托/每次拦截一条
    realized: 0,             // 累计已实现盈亏
    totalFee: 0,             // 累计费用
    startDate,
    lastSettle: null,        // 最近一次结算的交易日
    nav: [],                 // [{date, equity, cash, marketValue}] 每日净值（绩效与曲线用）
    note: '初始资金为虚拟资金；价格、交易日历、交易规则均取自真实数据与 A 股现行制度。',
  };
}

/**
 * 账户静态快照（不依赖行情）：现金、已实现、总费用、历史峰值与当前回撤。
 *
 * 峰值与回撤的口径（V5.2-pro 规则第四条）：
 *   · 历史峰值总资产 = max(初始本金, 历史每日净值, 当前总资产)——**必须包含当前值**，
 *     否则「今天创新高但还没记净值」时算出的回撤会虚高。
 *   · 当前回撤 = (峰值 − 当前总资产) ÷ 峰值，≥0；未回撤时为 0。
 *   峰值取自 acct.nav 的历史 equity（每日收盘快照），这是唯一可核验的来源——
 *   不要去「猜」峰值，它必须来自真实记录。
 */
export function accountStats(acct) {
  const positions = Object.values(acct.positions || {});
  const marketValue = positions.reduce((a, p) => a + (p.last != null ? p.last * p.qty : p.avgCost * p.qty), 0);
  const costValue = positions.reduce((a, p) => a + (p.cost || 0), 0);
  const total = acct.cash + (acct.freeze || 0) + marketValue;
  // 历史峰值：nav 里记录过的最大权益，与当前总资产取大；再由 initCash 兜底
  let peak = Math.max(+acct.initCash || 0, total);
  for (const r of acct.nav || []) {
    if (r && Number.isFinite(+r.equity)) peak = Math.max(peak, +r.equity);
  }
  const drawdown = peak > 0 ? Math.max(0, (peak - total) / peak) : 0;
  return {
    cash: acct.cash,
    freeze: acct.freeze || 0,
    marketValue,
    costValue,
    floatPnl: marketValue - costValue,
    floatPnlPct: costValue > 0 ? (marketValue - costValue) / costValue : 0,
    realized: acct.realized || 0,
    totalFee: acct.totalFee || 0,
    total,
    initCash: acct.initCash,
    // 峰值与回撤（风控与展示共用，唯一出处）
    peak,
    drawdown,                                  // 0~1
    drawdownPct: drawdown * 100,
    ret: acct.initCash > 0 ? (total - acct.initCash) / acct.initCash : 0,
    retPct: acct.initCash > 0 ? ((total - acct.initCash) / acct.initCash) * 100 : 0,
    posCount: positions.length,
  };
}

// ────────────────────── 四·B、账户全局风控（V5.2-pro 规则第四条） ──────────────────────
//
// 为什么必须独立于 validateOrder：validateOrder 管「这一笔委托本身合不合法」
// （代码/数量/资金/可卖），是**单笔层面**；本模块管「这一笔放进账户后，
// 整个账户会不会越界」，是**账户层面**。两者是不同的问题，混在一起会让
// 「资金够不够」与「仓位超没超」共用一套返回码，前端无法区分是哪种拦截。
//
// 三条硬约束（阈值集中在此，UI 不得重写）：
//   ① 单日账户仓位变动 ≤ 总资产的 20%（当日所有买入委托累计口径）
//   ② 回撤 ≥9%  → 仓位上限 70% 总资产
//   ③ 回撤 ≥15% → 仓位上限 40% 总资产
//   任意一条不满足 → 直接拦截，返回可读原因。

/** 单日账户仓位变动上限（占总资产比例） */
export const MAX_DAILY_POSITION_CHANGE = 0.20;

/** 回撤触发的动态降仓档位（回撤 ≥ threshold → 仓位上限上限 cap） */
export const DD_TIERS = [
  { threshold: 0.15, cap: 0.40, label: '回撤 ≥15%：仓位上限降至 40%' },
  { threshold: 0.09, cap: 0.70, label: '回撤 ≥9%：仓位上限降至 70%' },
  { threshold: 0.00, cap: 1.00, label: '回撤正常：仓位上限 100%' },
];

/** 个股单笔硬性止损线（浮亏达此比例自动生成卖出止损委托） */
export const HARD_STOP_LOSS = -0.08;

/**
 * 按当前回撤取仓位上限档位。返回 {threshold, cap, label}（永远非空，回撤正常时 cap=1）。
 * 注意档位是**从高回撤到低回撤**排列的，取第一个满足 threshold 的——保证取到最严的那档。
 */
export function ddTier(drawdown) {
  const dd = Math.max(0, +drawdown || 0);
  for (const t of DD_TIERS) if (dd >= t.threshold) return t;
  return DD_TIERS[DD_TIERS.length - 1];
}

export const RISK_REJECT = {
  DAILY_CHANGE: '单日账户仓位变动超过 20% 总资产上限',
  DD_CAP: '账户回撤触发动态降仓，本次委托将突破当前仓位上限',
};

/**
 * 账户全局风控校验（下单前必执行，规则第四条）。
 *
 * 判据（全部使用「已包含本笔委托」的口径，才能真实反映下单后的状态）：
 *   ① 仓位变动：本笔买入金额 ÷ 总资产 ≤ 20%
 *   ② 回撤档位：下单后总仓位（市值 + 已冻结 + 本笔）÷ 总资产 ≤ 当前回撤对应的上限
 *
 * @param {object} acct 账户
 * @param {object} order { side, qty }
 * @param {object} quote { price }
 * @param {object} [ctx] { todayBuyAmount } 当日已提交买入委托的累计金额（元）——
 *        单日仓位变动是「当日累计」口径，必须把今天已经下的单算进来，
 *        否则连下 5 笔 20% 就能绕开上限。调用方（批量委托）负责累加传入。
 * @returns {{ok:boolean, reason?:string, detail?:string, cap?:number, drawdown?:number,
 *            afterPosPct?:number, thisChangePct?:number, tier?:object}}
 */
export function riskGuard(acct, order, quote, ctx = {}) {
  const stats = accountStats(acct);
  const total = stats.total;
  if (!(total > 0)) return { ok: false, reason: 'BAD_ACCOUNT', detail: '账户总资产 ≤ 0，无法做风控校验' };

  // 卖出不受「仓位变动/降仓上限」约束——降仓只会让仓位更低，是允许的（止损/减仓必须放行，
  // 否则回撤触发降仓后会连「减仓」都被拦，账户被锁死在高仓位，这是最坏的结果）。
  if (order?.side === 'sell') {
    return { ok: true, cap: 1, drawdown: stats.drawdown, note: '卖出方向不受仓位变动与降仓上限约束' };
  }

  const px = fillPrice(+((quote || {}).price), 'buy', order?.slip ?? DEFAULT_SLIP);
  const qty = Math.max(0, Math.floor(+order?.qty || 0));
  const gross = round2(px * qty);
  const fee = qty > 0 ? fees(gross, 'buy').total : 0;
  const amount = round2(gross + fee);          // 本笔将占用的资金

  const tier = ddTier(stats.drawdown);
  const todayBuy = Math.max(0, +ctx.todayBuyAmount || 0);

  // ① 单日仓位变动（今日已提交买入累计 + 本笔）≤ 20% 总资产
  const changePct = (todayBuy + amount) / total;
  if (changePct > MAX_DAILY_POSITION_CHANGE + 1e-9) {
    return {
      ok: false, reason: RISK_REJECT.DAILY_CHANGE,
      detail: `今日已买入 ${todayBuy.toFixed(2)} 元 + 本笔 ${amount.toFixed(2)} 元 = `
        + `${(changePct * 100).toFixed(2)}% 总资产，超过 ${MAX_DAILY_POSITION_CHANGE * 100}% 上限`,
      cap: tier.cap, drawdown: stats.drawdown, thisChangePct: changePct, tier,
    };
  }

  // ② 下单后总仓位不超过回撤档位上限
  //    仓位口径 = (已持股市值 + 已冻结资金 + 本笔占用) ÷ 总资产
  //    注：总资产 status.total 已含冻结，故冻结部分不再重复加，用它算「占比」即可。
  const heldValue = stats.marketValue;               // 已持股市值
  const afterPosPct = (heldValue + (stats.freeze || 0) + amount) / total;
  if (afterPosPct > tier.cap + 1e-9) {
    return {
      ok: false, reason: RISK_REJECT.DD_CAP,
      detail: `下单后仓位将达 ${(afterPosPct * 100).toFixed(2)}% 总资产，`
        + `当前档位上限 ${(tier.cap * 100).toFixed(0)}%（${tier.label}，当前回撤 ${(stats.drawdown * 100).toFixed(2)}%）`,
      cap: tier.cap, drawdown: stats.drawdown, afterPosPct, tier,
    };
  }

  return {
    ok: true, cap: tier.cap, drawdown: stats.drawdown,
    afterPosPct, thisChangePct: changePct, amount, tier,
  };
}

// ────────────────────────── 五、下单校验（唯一判据来源） ──────────────────────────

export const REJECT = {
  BAD_CODE: '代码非法',
  NOT_TRADABLE: '该代码不在模拟器可交易范围（B股/未知板段）',
  NO_QUOTE: '当日无真实行情，无法预估资金占用',
  BAD_QTY: '数量非法',
  LOT: `买入数量须为 ${LOT} 股整数倍`,
  ODD_SELL: '卖出零股时须一次性卖出全部持仓',
  NO_POSITION: '无该股持仓',
  OVER_AVAIL: '超过可卖数量（T+1：当日买入次一交易日才可卖）',
  NO_CASH: '可用资金不足（按今收价 + 费用预冻结）',
  PENDING_SAME: '该股已有待成交委托，请先撤单',
};

/**
 * 校验一笔委托。返回 { ok, reason, detail, price, gross, fee, need }。
 *
 * 资金/股份按「下单日收盘价」预冻结——真实券商就是这样：委托提交时冻结，成交时按实际价结算。
 * 次日实际成交价可能更高，届时资金不足则委托被撤（见 settleDay）。
 */
export function validateOrder(acct, order, quote) {
  const { code, side, qty } = order;
  const b = boardOf(code);
  if (!/^\d{6}$/.test(String(code || ''))) return reject(REJECT.BAD_CODE, `代码 ${code}`);
  if (!b.tradable) return reject(REJECT.NOT_TRADABLE, b.label);
  if (!Number.isInteger(qty) || qty <= 0) return reject(REJECT.BAD_QTY, `数量 ${qty}`);
  if (!quote || quote.price == null || !Number.isFinite(+quote.price) || +quote.price <= 0) {
    return reject(REJECT.NO_QUOTE, quote?.reason || '存档无该股收盘价');
  }
  const dup = (acct.pending || []).find((p) => p.code === code);
  if (dup) return reject(REJECT.PENDING_SAME, `已有 ${dup.side === 'buy' ? '买入' : '卖出'} ${dup.qty} 股待成交`);

  if (side === 'buy') {
    if (qty % LOT !== 0) return reject(REJECT.LOT, `${qty} 股`);
    const px = fillPrice(+quote.price, 'buy', order.slip ?? DEFAULT_SLIP);
    const gross = round2(px * qty);
    const fee = fees(gross, 'buy').total;
    const need = round2(gross + fee);
    if (acct.cash + 1e-9 < need) {
      return reject(REJECT.NO_CASH, `需冻结 ${need.toFixed(2)} 元，可用 ${acct.cash.toFixed(2)} 元`);
    }
    return { ok: true, price: px, gross, fee, need };
  }

  // 卖出
  const pos = acct.positions[code];
  if (!pos || pos.qty <= 0) return reject(REJECT.NO_POSITION, code);
  const frozen = (acct.pending || []).filter((p) => p.code === code && p.side === 'sell').reduce((a, p) => a + p.qty, 0);
  const freeAvail = Math.max(0, (pos.avail || 0) - frozen);
  if (qty > freeAvail) {
    return reject(REJECT.OVER_AVAIL, `可卖 ${freeAvail} 股 / 持仓 ${pos.qty} 股（当日买入 ${pos.qty - (pos.avail || 0)} 股）`);
  }
  if (qty % LOT !== 0 && qty !== pos.qty) return reject(REJECT.ODD_SELL, `零股卖出仅限一次性清仓（${pos.qty} 股）`);
  if (qty > pos.qty) return reject(REJECT.BAD_QTY, `卖出 ${qty} > 持仓 ${pos.qty}`);
  const px = fillPrice(+quote.price, 'sell', order.slip ?? DEFAULT_SLIP);
  const gross = round2(px * qty);
  const fee = fees(gross, 'sell').total;
  return { ok: true, price: px, gross, fee, need: 0 };
}

function reject(reason, detail) {
  return { ok: false, reason, detail: detail || '' };
}

// ────────────────────────── 六、委托挂单（T+1 撮合，消除前视偏差） ──────────────────────────

/**
 * 提交委托 → 进入待成交队列（不立即成交）。
 * 买入预冻结资金（按今收价 + 费用）、卖出预冻结股份（券商的真实行为）。
 * 返回 { next, order }；被拒单直接写入 orders（status='rejected'），不占用冻结。
 */
export function submitOrder(acct, order, quote, ctx = {}) {
  const date = ctx.date || acct.lastSettle || null;
  const v = validateOrder(acct, order, quote);
  const id = (acct.orders?.length || 0) + 1;
  const base = {
    id, submitDate: date, code: order.code, name: quote?.name || '',
    side: order.side, qty: order.qty, reason: order.reason || '手动下单',
    submitPrice: quote?.price != null ? +quote.price : null,
  };
  if (!v.ok) {
    const rec = { ...base, status: 'rejected', reject: v.reason, detail: v.detail };
    return {
      next: {
        ...acct,
        orders: [...acct.orders, rec],
        logs: appendLog(acct, { date, code: order.code, name: base.name, side: order.side, qty: order.qty, stage: 'order', result: 'rejected', reason: v.reason, text: `委托被拒：${v.reason}${v.detail ? '（' + v.detail + '）' : ''}` }),
      },
      order: rec,
    };
  }
  const rec = {
    ...base, status: 'pending',
    estPrice: v.price, estFee: v.fee, estGross: v.gross, need: v.need,
    slip: order.slip ?? DEFAULT_SLIP,
  };
  return {
    next: {
      ...acct,
      freeze: toYuan(toCents(acct.freeze || 0) + toCents(v.need)),
      cash: order.side === 'buy' ? toYuan(toCents(acct.cash) - toCents(v.need)) : acct.cash,
      pending: [...(acct.pending || []), rec],
      orders: [...acct.orders, rec],
      logs: appendLog(acct, { date, code: order.code, name: base.name, side: order.side, qty: order.qty, stage: 'order', result: 'submitted', reason: rec.reason,
        text: `委托提交成功：${order.side === 'buy' ? '买入' : '卖出'} ${order.qty} 股 @预估 ${v.price} 元，`
          + (order.side === 'buy' ? `冻结 ${v.need.toFixed(2)} 元` : '待成交后回款') + '，T+1 次一交易日按真实收盘价撮合' }),
    },
    order: rec,
  };
}

// ────────────────────────── 六·B、委托与拦截日志（V5.2-pro 规则第六块） ──────────────────────────
//
// 为什么要独立的日志流，而不是只靠 orders[]：
//   orders 只记「到达了下单这一步」的委托；而龙虎过滤拦截与风控拦截发生在**下单之前**，
//   它们根本没有 order 记录。若只靠 orders，被拦的标的会彻底消失——用户看不到
//   「我为什么买不了这只票」。日志流把三类事件（过滤拦截 / 风控拦截 / 委托流转）
//   统一到一条时间线上，可直接追加到每日研判报告。

/** 日志条数上限：防止长期运行把账本撑爆（保留最近 N 条，旧的可从 orders/trades 追溯） */
export const MAX_LOGS = 2000;

/**
 * 追加一条日志（返回新数组，不原地改）。日志字段固定：
 * { ts, date, code, name, side, qty, stage, result, reason, text }
 *   stage  : 'lhb'   龙虎榜前置过滤拦截
 *            'risk'  账户全局风控拦截
 *            'order' 委托流转（提交/被拒）
 *            'settle' 结算（成交/失效）
 *            'stop'  止损扫描
 *   result : 'pass' | 'rejected' | 'submitted' | 'filled' | 'expired' | 'cancelled'
 * ts 用真实时间戳（毫秒），date 用交易日——两者不同：ts 是「什么时候操作的」，
 * date 是「按哪个交易日的口径」。备份追溯时两者都需要。
 */
export function appendLog(acct, entry) {
  const logs = Array.isArray(acct?.logs) ? acct.logs : [];
  const row = {
    ts: Date.now(),
    date: entry.date ?? acct?.lastSettle ?? null,
    code: entry.code ?? null,
    name: entry.name ?? null,
    side: entry.side ?? null,
    qty: entry.qty ?? null,
    stage: entry.stage || 'order',
    result: entry.result || 'info',
    reason: entry.reason ?? null,
    text: entry.text || '',
  };
  const out = [...logs, row];
  return out.length > MAX_LOGS ? out.slice(out.length - MAX_LOGS) : out;
}

/** 读取日志（可按交易日 / 阶段 / 结果过滤），默认返回全部（最新在后） */
export function readLogs(acct, filter = {}) {
  let rows = Array.isArray(acct?.logs) ? acct.logs : [];
  if (filter.date) rows = rows.filter((r) => r.date === filter.date);
  if (filter.stage) rows = rows.filter((r) => r.stage === filter.stage);
  if (filter.result) rows = rows.filter((r) => r.result === filter.result);
  if (filter.code) rows = rows.filter((r) => r.code === filter.code);
  if (filter.limit > 0) rows = rows.slice(-filter.limit);
  return rows;
}

/** 日志 → 可粘贴进每日研判报告的文本块（Markdown）。无日志时返回空串，不产生空表格。 */
export function logsToReport(acct, filter = {}) {
  const rows = readLogs(acct, filter);
  if (!rows.length) return '';
  const STAGE = { lhb: '龙虎过滤', risk: '风控', order: '委托', settle: '结算', stop: '止损' };
  const RESULT = { pass: '通过', rejected: '拦截', submitted: '已提交', filled: '已成交', expired: '失效', cancelled: '已撤单', info: '记录' };
  const lines = rows.map((r) => {
    const head = `- \`${r.date || '—'}\` ${r.code ? r.code + ' ' + (r.name || '') : ''} `
      + `[${STAGE[r.stage] || r.stage}/${RESULT[r.result] || r.result}]`;
    return head + ' ' + r.text;
  });
  return `### 交易引擎事件日志（${rows.length} 条）\n\n` + lines.join('\n');
}

/** 撤单：释放冻结资金，委托状态改为 cancelled（保留在 orders 里可追溯） */
export function cancelOrder(acct, id) {
  const p = (acct.pending || []).find((x) => x.id === id);
  if (!p) return { next: acct, ok: false, error: '该委托不在待成交队列' };
  const rec = { ...p, status: 'cancelled', cancelDate: acct.lastSettle || null };
  return {
    ok: true,
    next: {
      ...acct,
      cash: toYuan(toCents(acct.cash) + toCents(p.need || 0)),
      freeze: toYuan(Math.max(0, toCents(acct.freeze || 0) - toCents(p.need || 0))),
      pending: acct.pending.filter((x) => x.id !== id),
      orders: acct.orders.map((o) => (o.id === id ? rec : o)),
    },
  };
}

// ────────────────────── 六·C、批量委托（V5.2-pro 规则第五块） ──────────────────────
//
// 批量委托的完整链路（每只标的独立走一遍，单只失败不影响其他）：
//   ① 龙虎榜前置过滤（src/lhbfilter.js）——不通过则拦截，记日志，**绝不生成买入委托**
//   ② 账户全局风控（riskGuard）——含「当日累计买入金额」口径，防止分笔绕过 20% 上限
//   ③ 单笔合法性校验（validateOrder）——代码/数量/资金/可卖
//   ④ 提交委托（submitOrder）——冻结资金、进 T+1 待成交队列
//
// 为什么必须把「当日累计」在批量内部自己累加：单笔各自看都不超 20%，
// 但 5 笔加起来 100% 就绕过了上限。风控是账户层面的，批次内必须共享同一个累加器。

/**
 * 批量生成买入委托。
 *
 * @param {object} acct 账户
 * @param {Array<{code:string, qty?:number, pct?:number, reason?:string, slip?:number}>} items
 *        每项：qty 直接指定股数；或 pct 指定「占总资产比例」（由 qtyByAssetPct 换算整手）
 * @param {object} day   archive 的某一天（提供行情 + 龙虎榜过滤依据）
 * @param {object} [opts]
 * @param {boolean} [opts.applyLhbFilter=true] 是否执行龙虎榜前置过滤（回测/实盘统一：恒为 true）
 * @param {boolean} [opts.checkRisk=true]      是否执行账户全局风控
 * @param {string}  [opts.date]                交易日（默认取 day.trade_date）
 * @returns {{next:object, results:Array, submitted:Array, blocked:Array, summary:object}}
 */
export function batchSubmit(acct, items, day, opts = {}) {
  const date = opts.date || day?.trade_date || acct.lastSettle || null;
  const quotes = quotesFromDay(day);
  const applyLhb = opts.applyLhbFilter !== false;
  const checkRisk = opts.checkRisk !== false;

  let cur = acct;
  const results = [];
  // 当日已提交买入金额累加器：从「今天已提交的 pending 买入委托」起步，
  // 保证跨批次（页面上先下一批、再下一批）也共享同一个上限。
  let todayBuy = (acct.pending || [])
    .filter((p) => p.side === 'buy' && p.submitDate === date)
    .reduce((a, p) => a + (p.estGross || 0) + (p.estFee || 0), 0);
  // 本批次内已被过滤拦截的票，不再重复尝试（同票在 items 里重复出现时）
  const doneCodes = new Set();

  const lhbCache = new Map();

  for (const raw of (Array.isArray(items) ? items : [])) {
    const code = String(raw?.code || raw?.symbol || '').trim();
    const row = { code, name: '', side: 'buy', qty: null, status: 'blocked', stage: null, reason: null, detail: null, order: null };
    if (!code) { row.reason = '代码为空'; results.push(row); continue; }
    if (doneCodes.has(code)) { row.reason = '本批次内重复标的，已跳过'; results.push(row); continue; }
    doneCodes.add(code);

    const quote = quotes[code] || null;
    row.name = quote?.name || code;

    // ① 龙虎榜前置过滤 —— 买入的第一道闸门（规则第一块）
    if (applyLhb) {
      let f = lhbCache.get(code);
      if (!f) {
        try {
          f = filterOne(code, day, { marketNetWan: (day?.summary?.lhb_daily_net != null ? +day.summary.lhb_daily_net * 1e4 : null) });
        } catch (e) {
          f = { bucket: 'rejected', text: '过滤异常：' + (e?.message || e), rejectedBy: [{ code: 'FILTER_ERROR', text: '过滤异常' }], features: null };
        }
        lhbCache.set(code, f);
      }
      if (f.bucket !== 'main') {
        row.status = 'blocked'; row.stage = 'lhb';
        row.reason = f.bucket === 'watch' ? '备选观察池（禁止自动下单）' : '龙虎榜前置过滤未通过';
        row.detail = f.text;
        row.filter = f;
        cur = { ...cur, logs: appendLog(cur, { date, code, name: row.name, side: 'buy', qty: raw?.qty ?? null, stage: 'lhb', result: 'rejected', reason: row.reason, text: row.detail }) };
        results.push(row);
        continue;
      }
      row.filter = f;
      cur = { ...cur, logs: appendLog(cur, { date, code, name: row.name, side: 'buy', qty: raw?.qty ?? null, stage: 'lhb', result: 'pass', reason: null, text: `龙虎榜前置过滤通过：${f.text}` }) };
    }

    // 行情缺失时无法估算股数/资金——如实拦下，不猜
    if (!quote || quote.price == null || !Number.isFinite(+quote.price)) {
      row.status = 'blocked'; row.stage = 'quote'; row.reason = REJECT.NO_QUOTE;
      results.push(row); continue;
    }

    // 股数：显式 qty 优先；否则按 pct（占总资产比例）换算整手
    let qty = Number.isInteger(raw?.qty) ? raw.qty : null;
    if (qty == null && Number.isFinite(+raw?.pct)) {
      const stats = accountStats(cur);
      const px = fillPrice(+quote.price, 'buy', raw?.slip ?? DEFAULT_SLIP);
      const r = qtyByAssetPct(stats.total, +raw.pct, px, { cash: cur.cash });
      qty = r.qty;
      row.capped = r.capped;
    }
    row.qty = qty;
    if (!qty || qty <= 0) {
      row.status = 'blocked'; row.stage = 'qty'; row.reason = '换算后股数为 0（资金不足或比例过小）';
      cur = { ...cur, logs: appendLog(cur, { date, code, name: row.name, side: 'buy', qty: 0, stage: 'risk', result: 'rejected', reason: row.reason, text: row.reason }) };
      results.push(row); continue;
    }

    // ② 账户全局风控 —— 用「当日累计」口径
    if (checkRisk) {
      const g = riskGuard(cur, { side: 'buy', qty, slip: raw?.slip }, quote, { todayBuyAmount: todayBuy });
      if (!g.ok) {
        row.status = 'blocked'; row.stage = 'risk'; row.reason = g.reason; row.detail = g.detail; row.risk = g;
        cur = { ...cur, logs: appendLog(cur, { date, code, name: row.name, side: 'buy', qty, stage: 'risk', result: 'rejected', reason: g.reason, text: g.detail }) };
        results.push(row);
        continue;
      }
      row.risk = g;
    }

    // ③④ 提交委托（validateOrder 在 submitOrder 内部执行）
    const sub = submitOrder(cur, { code, side: 'buy', qty, reason: raw?.reason || '批量买入委托', slip: raw?.slip }, { ...quote, name: row.name }, { date });
    cur = sub.next;
    row.order = sub.order;
    row.status = sub.order.status === 'pending' ? 'submitted' : 'blocked';
    row.reason = sub.order.status === 'pending' ? null : sub.order.reject;
    if (sub.order.status === 'pending') {
      todayBuy += (sub.order.estGross || 0) + (sub.order.estFee || 0);
      row.detail = `冻结 ${(sub.order.need || 0).toFixed(2)} 元，待次一交易日撮合`;
      // 提交成功的日志由 submitOrder 写入，这里不再重复
    } else {
      row.stage = 'order';
    }
    results.push(row);
  }

  cur = { ...cur, logs: appendLog(cur, { date, code: null, name: null, side: 'buy', qty: null, stage: 'order', result: 'info',
    text: `批量买入委托完成：提交 ${results.filter((r) => r.status === 'submitted').length} 笔 / 共 ${results.length} 只，`
      + `拦截 ${results.filter((r) => r.status === 'blocked').length} 笔（其中龙虎过滤 ${results.filter((r) => r.stage === 'lhb').length} 笔、`
      + `风控 ${results.filter((r) => r.stage === 'risk').length} 笔）` }) };

  return {
    next: cur,
    results: results.map((r) => ({ ...r, detail8: r.order ? orderDetail(r.order, cur) : null })),
    submitted: results.filter((r) => r.status === 'submitted').map((r) => ({ ...r, detail8: orderDetail(r.order, cur) })),
    blocked: results.filter((r) => r.status === 'blocked'),
    summary: {
      total: results.length,
      submitted: results.filter((r) => r.status === 'submitted').length,
      blocked: results.filter((r) => r.status === 'blocked').length,
      blockedByLhb: results.filter((r) => r.stage === 'lhb').length,
      blockedByRisk: results.filter((r) => r.stage === 'risk').length,
      todayBuyAmount: round2(todayBuy),
      todayBuyPct: round2((todayBuy / Math.max(1e-9, accountStats(cur).total)) * 100),
    },
  };
}

/**
 * 批量卖出（减仓/清仓）。与买入不同：卖出**不做**龙虎过滤（那是买入闸门），
 * 但同样逐笔独立校验；风控对卖出是放行的（降仓不会让账户越界）。
 *
 * @param {Array<{code:string, qty?:number, pct?:number, reason?:string}>} items
 *        pct 为「占该票可卖数量的比例」；qty 与 pct 二选一，优先 qty。
 */
export function batchSell(acct, items, day, opts = {}) {
  const date = opts.date || day?.trade_date || acct.lastSettle || null;
  const quotes = quotesFromDay(day);
  let cur = acct;
  const results = [];
  const seen = new Set();

  for (const raw of (Array.isArray(items) ? items : [])) {
    const code = String(raw?.code || raw?.symbol || '').trim();
    const row = { code, name: '', side: 'sell', qty: null, status: 'blocked', stage: null, reason: null, order: null };
    if (!code) { row.reason = '代码为空'; results.push(row); continue; }
    if (seen.has(code)) { row.reason = '本批次内重复标的，已跳过'; results.push(row); continue; }
    seen.add(code);

    const quote = quotes[code] || null;
    const pos = cur.positions[code];
    row.name = quote?.name || pos?.name || code;
    if (!pos || pos.qty <= 0) { row.status = 'blocked'; row.stage = 'position'; row.reason = REJECT.NO_POSITION; results.push(row); continue; }
    if (!quote || quote.price == null) { row.status = 'blocked'; row.stage = 'quote'; row.reason = REJECT.NO_QUOTE; results.push(row); continue; }

    // 冻结已有卖单占用的可卖数量（同一票多笔卖出不能超卖）
    const frozen = (cur.pending || []).filter((p) => p.code === code && p.side === 'sell').reduce((a, p) => a + p.qty, 0);
    const freeAvail = Math.max(0, (pos.avail || 0) - frozen);

    let qty = Number.isInteger(raw?.qty) ? raw.qty : null;
    if (qty == null) {
      const p = Number.isFinite(+raw?.pct) ? +raw.pct : 1;
      qty = p >= 1 ? freeAvail : qtyByHoldPct(freeAvail, p);
    }
    qty = Math.min(qty, freeAvail);
    row.qty = qty;
    if (!qty || qty <= 0) { row.status = 'blocked'; row.stage = 'qty'; row.reason = '可卖数量为 0（T+1 未解冻或已全部挂单）'; results.push(row); continue; }

    const sub = submitOrder(cur, { code, side: 'sell', qty, reason: raw?.reason || '批量卖出委托', slip: raw?.slip }, { ...quote, name: row.name }, { date });
    cur = sub.next;
    row.order = sub.order;
    row.status = sub.order.status === 'pending' ? 'submitted' : 'blocked';
    row.reason = sub.order.status === 'pending' ? null : sub.order.reject;
    if (row.status === 'submitted') row.detail = '待次一交易日按真实收盘价撮合后回款';
    results.push(row);
  }

  cur = { ...cur, logs: appendLog(cur, { date, code: null, side: 'sell', qty: null, stage: 'order', result: 'info',
    text: `批量卖出委托完成：提交 ${results.filter((r) => r.status === 'submitted').length} 笔 / 共 ${results.length} 只` }) };

  return {
    next: cur, results,
    submitted: results.filter((r) => r.status === 'submitted'),
    blocked: results.filter((r) => r.status === 'blocked'),
    summary: {
      total: results.length,
      submitted: results.filter((r) => r.status === 'submitted').length,
      blocked: results.filter((r) => r.status === 'blocked').length,
    },
  };
}

// ────────────────────── 六·D、委托详情（结构化输出，V5.2-pro 规则第八块） ──────────────────────
//
// 规则要求：每次委托运算输出结构化结果——是否提交成功、文字说明、委托详情
// （代码/名称/方向/价格/股数/成交金额/各项费用/冻结或回款资金/撮合说明）。
//
// 为什么单独成函数而不是让前端自己拼：这些字段的口径（费用怎么拆、冻结与回款怎么算）
// 只在引擎里定义一次，散到 UI 就会各算一套。且「撮合说明」是**唯一能让用户理解
// T+1 到底发生了什么**的字段，必须由引擎给出，不能由前端猜。

/**
 * 把一笔委托（orders / trades / pending 里的记录）转成规则第八块要求的结构化详情。
 *
 * @param {object} rec 委托或成交记录
 * @param {object} [acct] 账户（用于在需要时取持仓信息，可省）
 * @returns {object} 结构化详情
 */
export function orderDetail(rec, acct) {
  if (!rec) return null;
  const side = rec.side;
  // 成交记录（trades[]）没有 status 字段，但有 fillDate —— 视为已成交
  const status = rec.status || (rec.fillDate ? 'filled' : 'unknown');
  const settled = status === 'filled';
  const settleDate = rec.settleDate ?? rec.fillDate ?? null;
  const qty = +rec.qty || 0;
  // 成交价字段有三处来源：orders 里叫 fillPrice、trades 里叫 price、待成交叫 estPrice。
  // 必须统一，否则「实际成交价」在成交记录上会显示为空——这正是详情最容易出错的地方。
  const fillPrice = rec.fillPrice != null ? +rec.fillPrice : (settled && rec.price != null ? +rec.price : null);
  const price = fillPrice != null ? fillPrice : (rec.estPrice != null ? +rec.estPrice : (rec.price != null ? +rec.price : (rec.submitPrice != null ? +rec.submitPrice : null)));
  const gross = rec.gross != null ? +rec.gross : (price != null ? round2(price * qty) : null);
  const feeTotal = rec.fee != null ? +rec.fee : (rec.estFee != null ? +rec.estFee : null);
  const feeBreak = gross != null && gross > 0
    ? fees(gross, side)
    : { comm: 0, transfer: 0, stamp: 0, total: 0 };
  // 冻结（买入，提交时按预估价）/ 回款（卖出，成交后按实际价）
  let frozenOrReturn = null;
  if (side === 'buy') {
    const amount = gross != null && feeTotal != null ? round2(gross + feeTotal) : (rec.need != null ? +rec.need : null);
    frozenOrReturn = { kind: 'freeze', amount, label: settled ? '实际占用' : '冻结资金' };
  } else {
    const amount = gross != null && feeTotal != null ? round2(gross - feeTotal) : null;
    frozenOrReturn = { kind: 'return', amount, label: settled ? '实际回款' : '预估回款' };
  }
  // 撮合说明：解释这笔委托当前处于 T+1 链路的哪一步
  let matchNote;
  if (status === 'pending') {
    matchNote = `收盘提交，将于次一交易日按真实收盘价撮合（T+1）；预估成交价 ${price} 元（含滑点 ${((rec.slip ?? DEFAULT_SLIP) * 1e4).toFixed(0)}‱）`;
  } else if (settled) {
    matchNote = `已于 ${settleDate || '—'} 按真实收盘价撮合，实际成交价 ${price} 元`
      + (rec.driftPct != null ? `（相对提交价漂移 ${rec.driftPct > 0 ? '+' : ''}${rec.driftPct}%）` : '');
  } else if (status === 'rejected') {
    matchNote = `未提交：${rec.reject || '未知原因'}${rec.detail ? '（' + rec.detail + '）' : ''}`;
  } else if (status === 'expired') {
    matchNote = `委托失效：${rec.reject || '未知原因'}${rec.detail ? '（' + rec.detail + '）' : ''}`;
  } else if (status === 'cancelled') {
    matchNote = `已撤单（${rec.cancelDate || '—'}），冻结资金已释放`;
  } else {
    matchNote = '';
  }
  return {
    id: rec.id ?? null,
    code: rec.code, name: rec.name || '',
    side, sideLabel: side === 'buy' ? '买入' : '卖出',
    status,
    ok: status === 'pending' || status === 'filled',
    qty,
    submitDate: rec.submitDate ?? null,
    settleDate,
    submitPrice: rec.submitPrice ?? null,
    estPrice: rec.estPrice ?? null,
    fillPrice,
    price,
    grossAmount: gross,
    fee: {
      commission: feeBreak.comm,
      transfer: feeBreak.transfer,
      stampTax: feeBreak.stamp,
      total: feeTotal != null ? feeTotal : feeBreak.total,
    },
    frozenOrReturn,
    reason: rec.reason || '',
    text: matchNote,
    // 冻结/回款资金的扁平字段（规则原文口径，便于直接展示）
    freezeAmount: side === 'buy' ? frozenOrReturn.amount : 0,
    returnAmount: side === 'sell' ? frozenOrReturn.amount : 0,
    holdingQty: acct?.positions?.[rec.code]?.qty ?? null,
  };
}

/** 批量把委托列表转成结构化详情 */
export function orderDetails(list, acct) {
  return (Array.isArray(list) ? list : []).map((r) => orderDetail(r, acct)).filter(Boolean);
}

// ────────────────────────── 七、逐日结算（撮合 + T+1 解冻 + 净值） ──────────────────────────

/**
 * 用「某交易日的真实行情」推进一天，按顺序做四件事：
 *   1. 撮合待成交委托：按该日真实收盘价成交（涨停买不进 / 跌停卖不掉 / 资金不足则委托失效）
 *   2. T+1 解冻：把 avail 补到 qty
 *   3. 逐票更新最新价（浮动盈亏）——取不到行情的票沿用上一价并标注 pxStale
 *   4. 记录当日净值（现金 + 市值），供绩效与曲线使用
 *
 * 关键：第 1 步用的是「今天」的真实成交价，而委托是「昨天」下的——这是本模拟器唯一的
 * 防作弊机制。用户永远无法用一个已经知道的价格下单。
 */
export function settleDay(acct, date, quotes = {}, opts = {}) {
  const log = [];
  let cur = acct;
  // 已处理的委托 id：撮合是「一次性」的——今天成交/失效的单必须从 pending 里摘掉，
  // 否则它会在后续每个交易日重复成交（同一张委托撮合出无数笔成交，账本彻底失真）。
  const settledIds = new Set();
  // 每条分支都会 push 进这里，函数末尾统一从 pending 中剔除
  const markDone = (id) => settledIds.add(id);

  // T+1 门禁（引擎级防前视，最后防线）：submitDate ≥ 结算日的委托一律顺延。
  //   结算价必须晚于「提交时可知」——同日撮合（提交当天就成交）与倒挂撮合（结算日
  //   早于提交日）都意味着用户用已知价成交，正是设计文档说的「后视镜作弊」。
  //   UI 侧 settleByLive / autoCatchUp 各有日期把关，但引擎不信任调用方：
  //   即使调用方传错日期，也绝不撮合。顺延 ≠ 失效——委托原样留在队列等更晚的交易日。
  let t1Hold = 0;

  for (const p of cur.pending || []) {
    if (p.submitDate && date && String(p.submitDate) >= String(date)) { t1Hold++; continue; }
    const q = quotes[p.code];
    if (!q || q.price == null || !Number.isFinite(+q.price)) {
      log.push({ id: p.id, code: p.code, name: p.name, side: p.side, qty: p.qty, status: 'expired', reason: REJECT.NO_QUOTE, detail: `${date} 无该股真实行情，委托失效并释放冻结` });
      cur = { ...cur, cash: toYuan(toCents(cur.cash) + toCents(p.need || 0)), freeze: toYuan(Math.max(0, toCents(cur.freeze || 0) - toCents(p.need || 0))), orders: cur.orders.map((o) => (o.id === p.id ? { ...o, status: 'expired', settleDate: date, reject: REJECT.NO_QUOTE, detail: '该交易日无真实行情' } : o)) };
      markDone(p.id);
      continue;
    }
    const name = q.name || p.name || '';
    // 停板判定：实时源（有 prevClose）走精确停板价；存档源只有 change_pct 走近似口径
    const hit = isLimitHit(q.changePct, p.code, name, 0.5, q.price, q.prevClose ?? null);

    // 跌停卖不掉 / 涨停买不进——按「该日」的实际情况判定，而非下单日
    if (p.side === 'buy' && hit === 'up') {
      log.push({ ...pick(p), status: 'expired', reason: '涨停价无法买入', detail: `${date} ${q.changePct}% 一字/触板涨停，无卖盘，委托失效` });
      cur = releaseFreeze(cur, p, { status: 'expired', settleDate: date, reject: '涨停价无法买入', detail: `${date} 触及涨停，无卖盘` });
      markDone(p.id);
      continue;
    }
    if (p.side === 'sell' && hit === 'down') {
      log.push({ ...pick(p), status: 'expired', reason: '跌停价无法卖出', detail: `${date} ${q.changePct}% 触及跌停，无买盘，委托失效` });
      cur = { ...cur, orders: cur.orders.map((o) => (o.id === p.id ? { ...o, status: 'expired', settleDate: date, reject: '跌停价无法卖出', detail: `${date} 触及跌停，无买盘` } : o)) };
      markDone(p.id);
      continue;
    }

    const px = fillPrice(+q.price, p.side, p.slip ?? DEFAULT_SLIP);
    const gross = round2(px * p.qty);
    const fee = fees(gross, p.side).total;
    const need = p.side === 'buy' ? round2(gross + fee) : 0;

    if (p.side === 'buy') {
      // 释放本单冻结后，按实际成交价重算：真实价可能比预估价高，届时资金不足 → 委托失效
      const cashBack = toCents(cur.cash) + toCents(p.need || 0);
      const freezeAfter = Math.max(0, toCents(cur.freeze || 0) - toCents(p.need || 0));
      if (cashBack + 1e-9 < toCents(need)) {
        log.push({ ...pick(p), status: 'expired', reason: REJECT.NO_CASH, detail: `${date} 实际成交价 ${px} 元需 ${need.toFixed(2)} 元，冻结 ${(p.need || 0).toFixed(2)} 元不足` });
        cur = { ...cur, cash: toYuan(cashBack), freeze: toYuan(freezeAfter), orders: cur.orders.map((o) => (o.id === p.id ? { ...o, status: 'expired', settleDate: date, reject: REJECT.NO_CASH, detail: `实际成交价 ${px} 元，资金不足` } : o)) };
        markDone(p.id);
        continue;
      }
      const pos = cur.positions[p.code] || { code: p.code, name, qty: 0, avail: 0, avgCost: 0, cost: 0, grossBuy: 0, fee: 0, openDate: date, days: 0, lastBuyDate: null };
      const applied = applyBuy(pos, { qty: p.qty, price: px, fee });
      const newPos = { ...pos, ...applied, name, avail: pos.avail || 0, openDate: pos.openDate || date, lastBuyDate: date, last: +q.price, lastDate: date, pxStale: false };
      cur = {
        ...cur,
        cash: toYuan(cashBack - toCents(need)),
        freeze: toYuan(freezeAfter),
        positions: { ...cur.positions, [p.code]: newPos },
        totalFee: toYuan(toCents(cur.totalFee || 0) + toCents(fee)),
        orders: cur.orders.map((o) => (o.id === p.id ? fillRec(o, { date, px, gross, fee }) : o)),
        trades: [...cur.trades, tradeRec(p, { date, px, gross, fee, name })],
      };
      log.push({ ...pick(p), status: 'filled', price: px, gross, fee });
      markDone(p.id);
    } else {
      const pos = cur.positions[p.code];
      if (!pos) {
        log.push({ ...pick(p), status: 'expired', reason: REJECT.NO_POSITION, detail: `${date} 已无持仓` });
        cur = { ...cur, orders: cur.orders.map((o) => (o.id === p.id ? { ...o, status: 'expired', settleDate: date, reject: REJECT.NO_POSITION } : o)) };
        markDone(p.id);
        continue;
      }
      const applied = applySell(pos, { qty: p.qty, price: px, fee });
      const positions = { ...cur.positions };
      if (applied.qty === 0) delete positions[p.code];
      else positions[p.code] = { ...pos, ...applied, avail: Math.max(0, (pos.avail || 0) - p.qty), last: +q.price, lastDate: date, pxStale: false };
      cur = {
        ...cur,
        cash: toYuan(toCents(cur.cash) + toCents(gross) - toCents(fee)),
        realized: toYuan(toCents(cur.realized || 0) + toCents(applied.realized)),
        totalFee: toYuan(toCents(cur.totalFee || 0) + toCents(fee)),
        positions,
        orders: cur.orders.map((o) => (o.id === p.id ? fillRec(o, { date, px, gross, fee }) : o)),
        trades: [...cur.trades, tradeRec(p, { date, px, gross, fee, name })],
      };
      log.push({ ...pick(p), status: 'filled', price: px, gross, fee, realized: applied.realized });
      markDone(p.id);
    }
  }

  // 从待成交队列剔除本轮已处理的委托（成交 / 失效 / 资金不足），并同步回 cur
  cur = { ...cur, pending: (cur.pending || []).filter((x) => !settledIds.has(x.id)) };

  // ② T+1 解冻 + ③ 更新最新价（对撮合后的持仓统一做一遍，避免新买入的票漏掉）
  //
  // T+1 的判据必须是「明确的成交日」，不能用 lastDate（那是「最近一次有行情的日」——
  // 一个票连着几天都有行情时 lastDate 会天天等于当天，导致永远不解冻）。
  // 所以持仓上单独记 lastBuyDate：只有 lastBuyDate !== 今天 的票，才把 avail 解冻为 qty。
  const positions = {};
  const missing = [];
  for (const [code, p] of Object.entries(cur.positions || {})) {
    const q = quotes[code];
    const px = q && q.price != null && Number.isFinite(+q.price) ? +q.price : null;
    if (px == null) missing.push(code);
    const boughtToday = p.lastBuyDate === date;       // 今天买入 → 今天不可卖
    positions[code] = {
      ...p,
      last: px != null ? px : p.last,
      lastDate: px != null ? date : p.lastDate,
      pxStale: px == null,
      avail: boughtToday ? (p.avail || 0) : p.qty,
      days: (p.days || 0) + 1,
    };
  }

  const next0 = { ...cur, positions, lastSettle: date };

  // ④ 结算日志：把本轮每笔撮合结果写入日志流（规则第六块）。
  //    只对「本轮真正处理过」的委托记日志，未处理的 pending 不产生噪音。
  let logged = next0;
  for (const x of log) {
    const isFill = x.status === 'filled';
    logged = {
      ...logged,
      logs: appendLog(logged, {
        date, code: x.code, name: x.name, side: x.side, qty: x.qty, stage: 'settle',
        result: isFill ? 'filled' : 'expired',
        reason: isFill ? null : (x.reason || null),
        text: isFill
          ? `成交：${x.side === 'buy' ? '买入' : '卖出'} ${x.qty} 股 @${x.price} 元，成交额 ${(x.gross || 0).toFixed(2)} 元，费用 ${(x.fee || 0).toFixed(2)} 元`
            + (x.side === 'buy' ? `，占用 ${((x.gross || 0) + (x.fee || 0)).toFixed(2)} 元` : `，回款 ${((x.gross || 0) - (x.fee || 0)).toFixed(2)} 元`)
          : `委托失效：${x.reason || '未知原因'}${x.detail ? '（' + x.detail + '）' : ''}`,
      }),
    };
  }

  // ⑤ 收盘持仓扫描止损（规则第七块）：浮亏达 −8% 自动生成 T+1 卖出委托。
  //    必须在净值记录「之前」做，否则止损产生的挂单不会体现在当天的仓位里。
  //    止损卖出同样受 T+1 约束：当日买入的票不可卖（avail 不足则本轮跳过，留痕说明）。
  const stops = opts.scanStopLoss === false ? { list: [], apply: (a) => a } : scanStopLoss(logged, date);
  if (stops.list.length) logged = stops.apply(logged, date);

  const stats = accountStats(logged);
  const navRow = { date, equity: round2(stats.total), cash: round2(stats.cash + stats.freeze), marketValue: round2(stats.marketValue) };
  const nav = [...(acct.nav || [])];
  if (!nav.some((r) => r.date === date)) nav.push(navRow);

  return {
    account: { ...logged, nav },
    fills: log.filter((x) => x.status === 'filled'),
    expired: log.filter((x) => x.status !== 'filled'),
    t1Hold,                        // 因 T+1 门禁顺延的委托数（留在 pending，未失效）
    stopLoss: stops.list || [],    missing,
    ...navRow,
  };
}

/**
 * 收盘持仓扫描止损（V5.2-pro 规则第七块）。
 *
 * 判据：单票浮亏比例 ≤ HARD_STOP_LOSS（−8%）→ 生成 T+1 卖出委托（清仓该票可卖部分）。
 *
 * 为什么用「浮亏比例 ≤ −8%」而不是「浮亏金额」：仓位大小不同，金额不可比；
 * 比例才是「这笔交易亏了多少」的统一尺度，也是规则原文的口径。
 *
 * 为什么卖出数量取「可卖数量」而不是「全部持仓」：
 *   T+1 约束下，当日买入的股份今天不可卖。若强行下全部持仓，validateOrder 会因超可卖被拒，
 *   止损单根本发不出去——那才是真正的风险。故取 avail（可卖），并把「因 T+1 无法止损」的情形
 *   如实记进日志，让用户看到「这只票触发止损但今天卖不掉」。
 *
 * 返回 { list, apply } —— list 供上层展示，apply(account, date) 返回新账户。
 * 拆成两段是为了：即使不应用（如回测只想看信号），也能拿到止损清单。
 */
export function scanStopLoss(acct, date) {
  const list = [];
  const positions = acct?.positions || {};
  for (const [code, p] of Object.entries(positions)) {
    if (!p || p.qty <= 0 || !(p.avgCost > 0) || p.last == null) continue;
    const pnlPct = (p.last - p.avgCost) / p.avgCost;      // 浮亏比例（未含卖出费用，与止损线同口径）
    if (pnlPct > HARD_STOP_LOSS + 1e-12) continue;        // 未触及 −8%，不动作

    const avail = Math.max(0, p.avail || 0);
    const frozen = (acct.pending || []).filter((x) => x.code === code && x.side === 'sell').reduce((a, x) => a + x.qty, 0);
    const freeAvail = Math.max(0, avail - frozen);
    const item = {
      code, name: p.name || code, pnlPct: round2(pnlPct * 100), last: p.last, avgCost: p.avgCost,
      qty: p.qty, avail, freeAvail, willSell: Math.min(freeAvail, p.qty), skipped: null,
    };
    if (freeAvail <= 0) {
      // T+1 未解冻 / 已全部挂单 —— 无法生成止损委托，如实记录，不假装已处理
      item.skipped = frozen > 0 ? '已有卖出委托待成交' : 'T+1 约束：当日买入次一交易日才可卖';
    } else if ((acct.pending || []).some((x) => x.code === code)) {
      // 已有同票待成交委托（无论方向）→ validateOrder 会以 PENDING_SAME 拒绝，提前拦下
      item.skipped = '该股已有待成交委托';
    }
    list.push(item);
  }
  return {
    list,
    apply: (account, d) => {
      let cur = account;
      for (const it of list) {
        if (it.skipped || it.willSell <= 0) {
          cur = { ...cur, logs: appendLog(cur, { date: d, code: it.code, name: it.name, side: 'sell', qty: it.qty, stage: 'stop', result: 'expired',
            reason: it.skipped, text: `触发 −8% 止损（浮亏 ${it.pnlPct}%），但无法生成卖出委托：${it.skipped}` }) };
          continue;
        }
        const q = { code: it.code, name: it.name, price: it.last };
        const sub = submitOrder(cur, { code: it.code, side: 'sell', qty: it.willSell, reason: `止损（浮亏 ${it.pnlPct}%）` }, q, { date: d });
        cur = sub.next;
        if (sub.order.status !== 'pending') {
          cur = { ...cur, logs: appendLog(cur, { date: d, code: it.code, name: it.name, side: 'sell', qty: it.willSell, stage: 'stop', result: 'rejected',
            reason: sub.order.reject, text: `触发 −8% 止损，但卖出委托被拒：${sub.order.reject}${sub.order.detail ? '（' + sub.order.detail + '）' : ''}` }) };
        } else {
          cur = { ...cur, logs: appendLog(cur, { date: d, code: it.code, name: it.name, side: 'sell', qty: it.willSell, stage: 'stop', result: 'submitted',
            reason: `止损 -8%`, text: `触发 −8% 止损（浮亏 ${it.pnlPct}%，现价 ${it.last} 元 / 成本 ${it.avgCost} 元），已生成 T+1 卖出委托 ${it.willSell} 股` }) };
        }
      }
      return cur;
    },
  };
}

function pick(p) {
  return { id: p.id, code: p.code, name: p.name, side: p.side, qty: p.qty };
}
function releaseFreeze(acct, p, patch) {
  return {
    ...acct,
    cash: toYuan(toCents(acct.cash) + toCents(p.need || 0)),
    freeze: toYuan(Math.max(0, toCents(acct.freeze || 0) - toCents(p.need || 0))),
    orders: acct.orders.map((o) => (o.id === p.id ? { ...o, ...patch } : o)),
  };
}
function fillRec(o, { date, px, gross, fee }) {
  return { ...o, status: 'filled', settleDate: date, fillPrice: px, gross, fee, amount: o.side === 'buy' ? round2(gross + fee) : round2(gross - fee) };
}
function tradeRec(p, { date, px, gross, fee, name }) {
  return {
    id: p.id, code: p.code, name, side: p.side, qty: p.qty,
    submitDate: p.submitDate, fillDate: date, submitPrice: p.submitPrice, price: px,
    gross, fee, net: p.side === 'buy' ? round2(gross + fee) : round2(gross - fee),
    reason: p.reason || '手动下单',
    // 委托价 → 成交价的漂移：T+1 撮合的必然结果，如实展示（真实交易也是这个体验）
    driftPct: p.submitPrice ? +(((px - p.submitPrice) / p.submitPrice) * 100).toFixed(2) : null,
  };
}

// ────────────────────────── 八、绩效（对齐 src/backtest.js 口径） ──────────────────────────

export const ANN = 252;

/**
 * 由「每日净值序列」算绩效，指标定义与 src/backtest.js 的 metrics() 完全一致，
 * 这样模拟账户的夏普/回撤与策略回测可以放在同一张表里比较。
 */
export function paperMetrics(nav) {
  const n = nav.length;
  if (!n) return null;
  const rets = [];
  for (let i = 1; i < n; i++) rets.push(nav[i] / nav[i - 1] - 1);
  const total = nav[n - 1] / nav[0] - 1;
  const annual = n > 1 ? (1 + total) ** (ANN / (n - 1)) - 1 : 0;
  let peak = nav[0], maxDd = 0;
  for (const v of nav) { peak = Math.max(peak, v); maxDd = Math.max(maxDd, 1 - v / peak); }
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) : 0;
  const sharpe = sd > 1e-12 ? (mean / sd) * Math.sqrt(ANN) : 0;
  const winDays = rets.filter((r) => r > 0).length;
  return {
    days: n, total, annual, maxDd, sharpe,
    winRate: rets.length ? winDays / rets.length : 0,
    ddPct: maxDd * 100,
  };
}

// ────────────────────────── 九、导出 / 导入（可核验的存档） ──────────────────────────

export function exportAccount(acct) {
  return JSON.stringify({
    version: PAPER_VERSION,
    exportedAt: new Date().toISOString(),
    initCash: acct.initCash,
    cash: acct.cash,
    freeze: acct.freeze || 0,
    realized: acct.realized,
    totalFee: acct.totalFee,
    positions: acct.positions,
    pending: acct.pending || [],
    orders: acct.orders,
    trades: acct.trades,
    // 事件日志必须随档迁移：委托/拦截/止损的时间线是「可核验存档」的一半，
    //   只带账本不带日志，跨设备复盘就断了（orders/trades 都在、偏偏日志丢，口径残缺）
    logs: Array.isArray(acct.logs) ? acct.logs.slice(-MAX_LOGS) : [],
    nav: acct.nav || [],
    startDate: acct.startDate,
    lastSettle: acct.lastSettle,
  }, null, 2);
}

/** 导入时严格校验：宁可拒绝，也不要把来路不明的账本灌进界面 */
export function importAccount(text) {
  let d;
  try { d = JSON.parse(text); } catch (e) { return { ok: false, error: '不是合法 JSON：' + e.message }; }
  if (!d || typeof d !== 'object') return { ok: false, error: '顶层不是对象' };
  if (d.version !== PAPER_VERSION) return { ok: false, error: `版本不匹配（文件 ${d.version || '无'} / 当前 ${PAPER_VERSION}）` };
  if (!Number.isFinite(+d.cash) || +d.cash < 0) return { ok: false, error: 'cash 非法' };
  if (!Number.isFinite(+d.initCash) || +d.initCash <= 0) return { ok: false, error: 'initCash 非法' };
  const positions = d.positions && typeof d.positions === 'object' ? d.positions : {};
  for (const [code, p] of Object.entries(positions)) {
    if (!Number.isInteger(p.qty) || p.qty <= 0) return { ok: false, error: `持仓 ${code} 数量非法` };
    if (!Number.isFinite(+p.avgCost) || +p.avgCost < 0) return { ok: false, error: `持仓 ${code} 成本非法` };
    if (!Number.isInteger(p.avail) || p.avail < 0 || p.avail > p.qty) return { ok: false, error: `持仓 ${code} 可卖数量非法` };
  }
  const pending = Array.isArray(d.pending) ? d.pending : [];
  for (const p of pending) {
    if (!Number.isInteger(p.qty) || p.qty <= 0) return { ok: false, error: `待成交委托 ${p.id} 数量非法` };
    if (p.side !== 'buy' && p.side !== 'sell') return { ok: false, error: `待成交委托 ${p.id} 方向非法` };
  }
  const nav = Array.isArray(d.nav) ? d.nav.filter((r) => r && typeof r.date === 'string' && Number.isFinite(+r.equity)) : [];
  // 事件日志：只收「形状合法」的条目（对象 + text 字符串），截尾到 MAX_LOGS——
  //   旧版导出没有 logs 字段 → 空数组（缺失如实，不伪造）；来路不明的条目丢弃前不报错，
  //   因为日志是辅助核验材料，不像 cash/positions 那样错了会污染账本。
  const logs = Array.isArray(d.logs)
    ? d.logs.filter((x) => x && typeof x === 'object' && typeof x.text === 'string').slice(-MAX_LOGS)
    : [];
  return {
    ok: true,
    account: {
      ...emptyAccount(+d.initCash, d.startDate || null),
      cash: +d.cash,
      freeze: +d.freeze || 0,
      realized: +d.realized || 0,
      totalFee: +d.totalFee || 0,
      positions,
      pending,
      orders: Array.isArray(d.orders) ? d.orders : [],
      trades: Array.isArray(d.trades) ? d.trades : [],
      logs,
      nav,
      lastSettle: d.lastSettle || null,
    },
  };
}

// ────────────────────────── 十、行情适配 ──────────────────────────

/**
 * 把存档一天的数据转成「可成交行情表」：code → { price, name, changePct, src }。
 * 只使用真实收盘价（hot.close / lhb.close），缺价一律不进表——缺失就是缺失，
 * 绝不填 0（0 在行情里是真实价格，会把「没数据」伪装成「跌到 0」）。
 * 同一票同时出现在热点榜与龙虎榜时，用龙虎榜的（其 close 更权威：交易所口径）。
 */
export function quotesFromDay(day) {
  const out = {};
  for (const h of day?.hot || []) {
    if (h?.code && h.close != null && Number.isFinite(+h.close)) {
      out[h.code] = { code: h.code, name: h.name || '', price: +h.close, changePct: h.change_pct ?? null, huanshou: h.huanshou ?? null, src: 'hot' };
    }
  }
  for (const l of day?.lhb || []) {
    if (l?.code && l.close != null && Number.isFinite(+l.close)) {
      out[l.code] = { code: l.code, name: l.name || '', price: +l.close, changePct: l.change_pct ?? null, reason: l.reason || '', src: 'lhb' };
    }
  }
  // 实时价覆盖层：paper_ui 的 batchDay() 会把腾讯实时价写进 day.quotes——
  //   优先级最高（「今天的真实价」优于存档收盘价），prevClose 一并透传给停板判定。
  //   ⚠ 此前 batchDay 写的是 day.quotes、而本函数只读 hot/lhb——实时价注入是**死代码**：
  //   不在当日热点/龙虎榜（各约百只）的票批量买入必被 NO_QUOTE 拦截，
  //   在榜票则用存档旧价估算冻结金额。现在真正接上。
  for (const [code, q] of Object.entries(day?.quotes || {})) {
    if (!code || !q || q.price == null || !Number.isFinite(+q.price)) continue;
    out[code] = {
      code, name: q.name || (out[code] && out[code].name) || '',
      price: +q.price, changePct: q.changePct ?? null, prevClose: q.prevClose ?? null,
      src: q.src || 'live',
    };
  }
  return out;
}
