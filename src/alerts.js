// 双层预警引擎（唯一来源，ESM 纯函数、零依赖、Node 与浏览器共用）
//
// 定位：把「已经算好的档位与账户事实」对照一遍，翻译成**用户当场能执行的动作**
//       （加仓 / 减仓 / 空仓 / 清仓 / 买入 / 卖出 / 观望 / 持有 / 等 T+1 解冻 / 补足止损）。
//       它不产生新的市场判断，只做「事实 → 动作」的映射。
//
// 为什么必须集中在这里、不能写在 UI：
//   预警是「用户会照着操作」的东西，规则一旦在 UI 里再写一遍，就会和交易引擎漂移。
//   所以：档位阈值取自 src/picks.js（唯一出处），止损/回撤阈值取自 src/config.js（唯一出处），
//   账户口径取自 src/paper.js 的 accountStats（唯一出处）。本文件只负责**排列组合与措辞**。
//
// 三条硬纪律：
//   1. **每条例警必须能追溯到具体字段**：说不清「因为哪个数字」就不许出。
//      禁止「注意风险」「综合来看」这类无法核验的措辞。
//   2. **只提示，不代下单**：引擎产出的是「建议动作 + 可执行参数」（如卖出股数），
//      绝不产生委托、不改账户。是否下单永远由用户点确认。
//   3. **档位未知时只给风险类预警**：没有情绪分就不知道目标仓位，此时说「该加仓 30%」
//      是无依据的。所以缺档位时只保留与档位无关的持仓层规则（止损/回撤/集中度）。
//
// 关于「区间卡片 + 一键动作」：每条预警带 action 字段，UI 据 type 决定按钮文案
//   （如「填入卖出」只把代码/数量填进下单区，不提交——与研判推荐的「填入下单」同纪律）。

// ── 口径唯一出处（复用，不重写） ──
// 档位阈值/档位表：与研判报告、回测引擎、研判推荐同源
import { marketTier, TIER_THRESHOLDS, POSITION_TIERS } from './picks.js';
// 风控阈值：与 V5.2 回测引擎同源（止损线、回撤降仓触发线、单日仓位变动上限）
import backtestCfg from './config.js';
const RISK = backtestCfg.backtest;
// 龙虎降级规则（净买入 ≤ 0）：判据与告警标签文案的唯一出处。
// 依赖方向：alerts → picks → {predict, lhbfilter}，而 lhbfilter 不引 alerts，
// 故无环（check_frontend 里各模块被包成 IIFE 即时求值，成环会直接崩，这条注释是给未来的自己看的）。
import { isNetOutflow, FLAG_LHB } from './lhbfilter.js';

// ────────────────────────── 一、阈值（集中在此，UI 不重写） ──────────────────────────

/**
 * 大盘层参数。
 *   band         档位偏离容忍带（占总资产比例）。持仓与目标仓位差在此带内视为「贴合」，不提示。
 *                取 10%：比一个标准仓位档差（轻 10%/半 50%/重 80%）小得多，
 *                但又能吸收「100 股零头 + 建仓日价格波动」造成的日常抖动，避免天天刷提示。
 *   minActionPos 触发「有意义的动作」所需的最小仓位差。低于此值即使超出容忍带也只给提示级，
 *                因为「调整 3% 仓位」在 100 股整手的约束下往往根本执行不了。
 */
export const MARKET_CFG = {
  band: 0.10,
  minActionPos: 0.05,
};

/**
 * 持仓层参数。
 *   stopLoss       单笔止损线（与 src/config.js backtest.stopLoss 同源，默认 -8%）。
 *                  浮亏达到此线 → 风险（红），动作「止损卖出全部可卖」。
 *   ddTrigger      回撤降仓触发线（与 backtest.ddTrigger 同源，默认 -15%）。
 *                  从持仓最高浮盈回撤达此幅度 → 减仓（橙黄），动作「减仓 1/2」。
 *   concMax        单票市值占总资产上限 20%。与 picks.suggestWeight 的 perStockCap 一致——
 *                  系统给不出「这只该比那只多拿」的依据，所以单票上限全系统统一 20%。
 *   nearStopRatio  接近止损线的预警比例（0.6 → 浮亏达止损线的 60%，即 -4.8% 时先给提示）。
 *   ddArmPct       回撤预警只在「曾经浮盈达到此比例」后才启用。否则一只从买入就亏、
 *                  从未有过浮盈的票，会被算成「从 0 回撤到 -15% = 回撤 15%」而误报。
 *   effMinPct      目标仓位低于此比例时视为「不需动作」——半仓档 50%/5 只 = 10% 恰好压线，
 *                  说明这条线卡在「值得建仓的最小仓位」附近，是刻意的。
 */
export const POS_CFG = {
  stopLoss: Number.isFinite(+RISK.stopLoss) ? +RISK.stopLoss : -0.08,
  ddTrigger: Number.isFinite(+RISK.ddTrigger) ? +RISK.ddTrigger : -0.15,
  concMax: 0.20,
  nearStopRatio: 0.60,
  ddArmPct: 0.08,
  effMinPct: 0.10,
  /** 回撤降仓比例（该票可卖数量的比例）——与 src/paper.js CUT_TIERS 的「减 1/2」一致 */
  cutPct: 0.50,
};

/**
 * 严重度：风险 > 机会 > 提示。
 *   risk  会直接亏钱或违反纪律的事（击穿止损、单票超配、档位要求大幅降仓）
 *   opp   值得动手的机会（档位允许加仓、可低吸）
 *   tip   状态告知 / 待办（T+1 未解冻、未匹配推荐池、已到目标仓位该拿住）
 */
export const LEVELS = ['risk', 'opp', 'tip'];

/** 动作类型 → 中文动作。UI 据此决定按钮文案与是否可一键填入。 */
export const ACTIONS = {
  buy: '买入', sell: '卖出', add: '加仓', reduce: '减仓',
  clear: '空仓', exit: '清仓', hold: '持有', wait: '等待', watch: '观望',
};

// ────────────────────────── 二、工具 ──────────────────────────

/**
 * 「是有限数字」判定。**不能写成 `Number.isFinite(+v)`**：
 *   `+null === 0`、`+'' === 0`、`+false === 0` 全都是有限数，于是「价格缺失」会被读成
 *   「价格 = 0」→ 浮亏算成 -100% → 凭空触发止损预警；「情绪分缺失」会被读成 0 分 → 误判清仓档。
 * 这个坑在 picks.marketTier 里已经踩过一次（那里的注释也记着），这里显式拦住 null/''/布尔。
 * 真正的数字字符串（'12.5'）仍然接受——存档里价格是数字，但导入的账本可能带字符串。
 */
const finite = (v) => v != null && v !== '' && typeof v !== 'boolean' && Number.isFinite(+v);
/**
 * 金额（元）→ 带千分位的整数字符串，用于「约 400,000 元」这类必须能核验的数字。
 * 刻意**不带**「元」后缀：调用方拼文案时加，避免出现「20,000 元 元」。
 * 早期版本在同一处既格式化又拼单位（如 pp 带 %、yuan 带 元），结果模板里再补一次单位就变成
 * 「100%%」——这类重复单位是文案级 bug，测试里已按「单位只出现一次」锁死。
 */
const yuan = (v) => (finite(v) ? Math.round(+v).toLocaleString('en-US') : '0');
/**
 * 比例 → 百分数文本（0.1234 → 12.3%）。**返回值已含 `%`**，调用方不得再补一个。
 * 同族还有 sp1/sp0：同一功能不同小数位的预设，避免到处传第二参。
 */
const pp = (v, d = 1) => `${(+v * 100).toFixed(d)}%`;
const pp0 = (v) => pp(v, 0);
/** 带正负号的百分数（-0.08 → -8.0%）。同样**已含 `%`**。 */
const sp = (v, d = 1) => `${+v > 0 ? '+' : ''}${(+v * 100).toFixed(d)}%`;

// ────────────────────────── 三、大盘层 ──────────────────────────

/**
 * 大盘层：情绪分 → 档位 → 目标总仓位，与当前实际总仓位对比。
 *
 * 输出的四条规则（对应用户要求的「加仓/减仓/空仓/清仓」）：
 *   · 档位允许新建 且 实际 < 目标 − 容忍带 → **加仓**（机会）
 *   · 档位要求降至某比例 且 实际 > 目标 + 容忍带 → **减仓**（风险）
 *   · 档位 = 清仓（情绪分 ≤ 24）→ **空仓**（风险）；若无持仓则给「保持空仓（不新建）」
 *   · 档位 = 过热（≥ 80，只减不新建）且已超配 → **清仓超额部分**（风险）
 *
 * @param {object} p
 * @param {number|null} p.emotionScore 七因子情绪分（与研判报告同源）
 * @param {number} p.total     账户总资产（元）
 * @param {number} p.marketValue 当前持仓市值（元）
 * @returns {Array<object>} 预警列表（可能为空 —— 仓位贴合档位时本就不该打扰用户）
 */
export function marketAlerts({ emotionScore, total, marketValue } = {}) {
  const out = [];
  const tier = marketTier(emotionScore);
  const T = finite(total) ? +total : 0;
  const MV = finite(marketValue) ? +marketValue : 0;
  const cur = T > 0 ? MV / T : 0;

  const base = {
    layer: 'market',
    weight: 0,
    quote: {
      '情绪分': finite(emotionScore) ? (+emotionScore).toFixed(1) : '缺失',
      '市场档位': tier ? tier.label : '未知',
      '建议总仓位': tier ? pp0(tier.pos) : '无法给出（情绪分缺失）',
      '当前持仓占比': T > 0 ? pp(cur, 1) : '无资产',
      '持仓市值': `${yuan(MV)} 元`,
      '总资产': `${yuan(T)} 元`,
    },
  };

  // 情绪分缺失 / 档位未知：不猜档位，只如实说明为什么大盘层没有建议。
  // 这条不是「预警」而是「能力边界声明」——否则用户会以为系统漏了。
  if (!tier) {
    out.push({
      ...base, level: 'tip', type: 'market-unknown', action: 'watch',
      text: '市场情绪分缺失，无法判定档位，本日不给大盘仓位建议（不猜档）。',
      why: '档位由七因子情绪分按 ≥80 过热 / ≥65 满仓 / 24~65 半仓 / ≤24 清仓 划档；情绪分未算出时任何仓位建议都是无依据的。',
    });
    return out;
  }

  const gap = cur - tier.pos; // >0 超配，<0 低配

  // ① 清仓档（情绪分 ≤ 24）：这是最硬的一条——档位本身要求空仓
  if (tier.key === 'clear') {
    if (MV > 0) {
      out.push({
        ...base, level: 'risk', type: 'market-exit', action: 'clear',
        weight: 90,
        text: `情绪分 ${(+emotionScore).toFixed(1)} ≤ ${TIER_THRESHOLDS.half} → 市场档位「清仓」，建议空仓；`
          + `当前仍持有 ${pp(cur, 1)}（${yuan(MV)} 元），应清仓离场。`,
        why: `清仓档阈值为情绪分 ≤ ${TIER_THRESHOLDS.half}（与 V5.2 回测引擎同一阈值表），该区间历史上属于情绪冰点，持有风险显著大于机会。`,
      });
    } else {
      out.push({
        ...base, level: 'tip', type: 'market-stay-flat', action: 'hold',
        weight: 40,
        text: `市场档位「清仓」，建议空仓；当前已空仓，保持不新建即可。`,
        why: `情绪分 ≤ ${TIER_THRESHOLDS.half} 判为清仓档，此时不新建仓即是正确操作，无需额外动作。`,
      });
    }
    return out;
  }

  // ② 过热档（≥ 80，只减仓不新建）：超配 → 清掉超额部分；低配也不该加（档位不允许新建）
  if (tier.key === 'overheat') {
    const over = cur - tier.pos;
    if (over > MARKET_CFG.band) {
      const targetMV = T * tier.pos;
      const cutMV = Math.max(0, MV - targetMV);
      out.push({
        ...base, level: 'risk', type: 'market-trim', action: 'reduce',
        weight: 85,
        text: `情绪分 ${(+emotionScore).toFixed(1)} ≥ ${TIER_THRESHOLDS.overheat} → 市场档位「${tier.label}」，`
          + `建议总仓位降至 ${pp0(tier.pos)}；当前 ${pp(cur, 1)}，超出 ${pp(over, 1)}（约 ${yuan(cutMV)} 元）。`,
        why: `过热档的纪律是「只减仓、不新建」——高位加仓的期望收益为负。档位阈值 ≥ ${TIER_THRESHOLDS.overheat} 分，与 V5.2 引擎同源。`,
      });
    } else {
      out.push({
        ...base, level: 'tip', type: 'market-no-new', action: 'watch',
        weight: 50,
        text: `市场档位「${tier.label}」，仓位 ${pp(cur, 1)} 未超 ${pp0(tier.pos)}，但**过热档只减仓不新建**，不再买入。`,
        why: `情绪分 ≥ ${TIER_THRESHOLDS.overheat} 时新增仓位的风险收益比不佳，引擎不给出加仓建议（即便当前仓位低于建议值）。`,
      });
    }
    return out;
  }

  // ③ 满仓 / 半仓档：允许新建 → 低于目标就加仓、高于目标就减仓
  if (gap > MARKET_CFG.band) {
    // 超配：减仓。差额小于 minActionPos 时只算提示（整手约束下往往执行不了）
    const targetMV = T * tier.pos;
    const cutMV = Math.max(0, MV - targetMV);
    const strong = gap >= MARKET_CFG.minActionPos;
    out.push({
      ...base, level: strong ? 'risk' : 'tip', type: 'market-trim', action: 'reduce',
      weight: strong ? 70 : 45,
      text: `市场档位「${tier.label}」建议总仓位 ${pp0(tier.pos)}，当前 ${pp(cur, 1)}，`
        + `超配 ${pp(gap, 1)}（约 ${yuan(cutMV)} 元），${strong ? '应减仓至建议仓位' : '略超建议仓位，可择机微调'}。`,
      why: `满仓档建议 100%、半仓档建议 50%（与 V5.2 引擎仓位档位同源）。偏离超过容忍带 ${pp0(MARKET_CFG.band)} 即提示；`
        + `超过 ${pp0(MARKET_CFG.minActionPos)} 才升级为风险级——低于这个差额，100 股整手约束下常常根本调整不了。`,
    });
  } else if (gap < -MARKET_CFG.band) {
    // 低配：加仓。差额即「可加仓空间」，具体标的由研判推荐负责（本引擎不荐股）
    const addMV = Math.max(0, T * tier.pos - MV);
    out.push({
      ...base, level: 'opp', type: 'market-add', action: 'add',
      weight: 65,
      text: `市场档位「${tier.label}」建议总仓位 ${pp0(tier.pos)}，当前仅 ${pp(cur, 1)}，`
        + `低于建议 ${pp(-gap, 1)}（约 ${yuan(addMV)} 元可加仓空间）。`,
      why: `情绪分 ${(+emotionScore).toFixed(1)} 落在「${tier.label}」区间（阈值表 ≥${TIER_THRESHOLDS.overheat} 过热 / ≥${TIER_THRESHOLDS.full} 满仓 / ${TIER_THRESHOLDS.half}~${TIER_THRESHOLDS.full} 半仓），`
        + `档位允许新建仓；加仓方向由「研判推荐」小模块按资金证据给出具体标的（本引擎不荐股）。`,
    });
  } else {
    out.push({
      ...base, level: 'tip', type: 'market-on-target', action: 'hold',
      weight: 20,
      text: `仓位 ${pp(cur, 1)} 与档位建议 ${pp0(tier.pos)} 贴合（差距在 ${pp0(MARKET_CFG.band)} 容忍带内），无需调整总仓位。`,
      why: `容忍带用于吸收零手与建仓日价格波动造成的日常抖动，避免反复提示同一个「不用做」的结论。`,
    });
  }

  return out;
}

// ────────────────────────── 四、持仓层 ──────────────────────────

/**
 * 单只持仓的「浮盈最高点回撤」。
 *
 * 依据：模拟账户不记录历史最高价（那是行情侧的事），但**每条仓位档建议都是按当前持仓
 * 状态给的**，所以这里用「持仓层已有的字段」能拿到的最近似值：
 *   · pos.realized 不含本仓（已实现已结转并清出），所以不能用它
 *   · pos.last 是最近真实价，pos.avgCost 是含费均价 → 浮盈率 = last/avgCost − 1
 *   · 历史峰值无法从账本复原 → **本函数返回 null**，回撤预警改由「浮盈 + 已处于减仓档」
 *     的组合规则承担（见 posAlerts）。这里保留函数名与返回约定，是为了让「当前浮盈率」
 *     有唯一的计算出口，UI 不再自己写一遍。
 *
 * @returns {null} 恒为 null —— 账本不含历史峰值，回撤幅度不可复原，宁可不说也不瞎说。
 */
export function peakDrawdownOf() {
  return null;
}

/**
 * 持仓层：逐只票检查「会不会亏钱 / 有没有违反纪律 / 有没有到该动手的时候」。
 *
 * 规则清单（每条都能追溯到具体字段，见 why）：
 *   1. **止损线击穿**（浮亏 ≤ stopLoss）→ 风险，「止损卖出全部可卖」
 *   2. **接近止损线**（浮亏 ≤ stopLoss × nearStopRatio）→ 提示，先提醒盯住
 *   3. **单票集中度超限**（市值/总资产 > concMax）→ 风险，「减仓至上限」
 *   4. **T+1 未解冻**（qty > avail）→ 提示，说明今天卖不掉、何时能卖
 *   5. **到达目标仓位**（档位允许新建 且 仓位已 ≥ 目标 × 1.4）→ 提示「持有、不再加」
 *   6. **不在今日推荐池**（有推荐池时）→ 提示，仅作信息，不构成卖出依据
 *   7. **停牌/无价**（pxStale）→ 提示，说明估值可能失真
 *
 * @param {object} p
 * @param {object} p.positions  account.positions（code → 持仓）
 * @param {object} p.stats      accountStats(account) 的结果
 * @param {object|null} p.tier  marketTier(emotionScore) 的结果（null = 档位未知）
 * @param {number[]} [p.pickCodes] 今日研判推荐的代码列表（用于「是否在池内」提示）
 * @returns {Array<object>} 预警列表
 */
export function positionAlerts({ positions, stats, tier, pickCodes } = {}) {
  const out = [];
  const pos = positions && typeof positions === 'object' ? positions : {};
  const T = stats && finite(stats.total) && +stats.total > 0 ? +stats.total : 0;
  const pickSet = new Set(Array.isArray(pickCodes) ? pickCodes.map(String) : []);

  for (const [code, p] of Object.entries(pos)) {
    if (!p || !(p.qty > 0)) continue;
    const name = p.name || code;
    const last = finite(p.last) ? +p.last : null;
    const avgCost = finite(p.avgCost) ? +p.avgCost : null;
    const qty = +p.qty;
    const avail = Math.max(0, Math.floor(+p.avail || 0));
    const frozenSell = 0; // 已挂卖单由「待成交委托」卡片展示，这里不重复算
    const freeSell = Math.max(0, avail - frozenSell);
    // 市值：无价时退化为成本（与 paper.accountStats 同口径），并在 why 里注明是估算
    const mv = last != null ? last * qty : (avgCost != null ? avgCost * qty : 0);
    const cost = finite(p.cost) ? +p.cost : (avgCost != null ? avgCost * qty : 0);
    const pnl = mv - cost;
    const pnlPct = cost > 0 ? pnl / cost : 0;
    const conc = T > 0 ? mv / T : 0;

    const quote = {
      '所属层': '持仓',
      '代码': code,
      '名称': name,
      '持仓/可卖': `${qty} / ${avail} 股`,
      '成本均价': avgCost != null ? `${avgCost.toFixed(3)} 元` : '—',
      '最新价': last != null ? `${last.toFixed(2)} 元${p.pxStale ? '（无当日行情，按最近价估）' : ''}` : '—',
      '浮动盈亏': `${yuan(pnl)} 元（${sp(pnlPct)}）`,
      '占总资产': T > 0 ? pp(conc, 1) : '—',
    };
    const base = { layer: 'position', code, name, quote, heldQty: qty };

    // ① / ② 止损线
    //
    // 注意这里**不能**直接 continue 掉整只票：止损建议最容易被「可卖数量不足」卡住，
    // 用户看到「应止损离场」却下不了单，必须同时把 T+1 原因说清楚（下面的 ④ 段）。
    // 只跳过「接近止损」这一条同类提示（击穿后再说「接近」是废话）。
    const brokeStop = pnlPct <= POS_CFG.stopLoss;
    if (brokeStop) {
      out.push({
        ...base, level: 'risk', type: 'pos-stop-loss', action: 'sell',
        weight: 100,
        // qty 必须严格等于**可卖**数量：写成 `freeSell || qty` 会在可卖为 0 时回退成全部持仓，
        // 于是预警给出「卖出 100 股」，用户照着下单却被 T+1 拒绝——这是最坏的一类误导。
        // 可卖为 0 时报 0，并在文案里说明原因（下面的 T+1 条目会补全理由）。
        qty: freeSell,
        text: `${name}（${code}）浮亏 ${sp(pnlPct)} 已击穿止损线 ${sp(POS_CFG.stopLoss)}，`
          + `按纪律应止损离场${freeSell ? `（可卖 ${freeSell} 股）` : '（当前无可卖数量，见 T+1 提示）'}。`,
        why: `止损线 ${sp(POS_CFG.stopLoss)} 与 V5.2 回测引擎的风控参数同源（src/config.js backtest.stopLoss）。`
          + `浮亏 = （最新价 ${last != null ? last.toFixed(2) : '—'} − 成本均价 ${avgCost != null ? avgCost.toFixed(3) : '—'}）÷ 成本均价 = ${sp(pnlPct)}。`,
      });
    } else if (pnlPct <= POS_CFG.stopLoss * POS_CFG.nearStopRatio) {
      out.push({
        ...base, level: 'tip', type: 'pos-near-stop', action: 'watch',
        weight: 55,
        text: `${name}（${code}）浮亏 ${sp(pnlPct)}，已达止损线 ${sp(POS_CFG.stopLoss)} 的 `
          + `${Math.round(POS_CFG.nearStopRatio * 100)}%，请盯住。`,
        why: `接近线设为止损线的 ${Math.round(POS_CFG.nearStopRatio * 100)}%（即 ${sp(POS_CFG.stopLoss * POS_CFG.nearStopRatio)}），`
          + `目的是给「准备止损」留出反应时间，而不是等到击穿才第一次提醒。`,
      });
    }

    // ③ 单票集中度
    //
    // 击穿止损时**不再**提集中度：止损的动作是「全部卖出」，已经比「减仓至 20%」更强；
    // 两条并列会让人以为有两个动作要做，而实际上做完止损就不需要再减了。
    // 集中度只在「仓位健康但太重」时才是独立问题。
    if (!brokeStop && T > 0 && conc > POS_CFG.concMax) {
      const targetMV = T * POS_CFG.concMax;
      const cutMV = mv - targetMV;
      // 要减多少股 = 超额市值 ÷ 最新价，向下取整到 100 股
      const cutQtyRaw = last && last > 0 ? Math.floor((cutMV / last) / 100) * 100 : 0;
      const cutQty = Math.min(freeSell, Math.max(0, cutQtyRaw));
      out.push({
        ...base, level: 'risk', type: 'pos-concentration', action: 'reduce',
        weight: 75,
        qty: cutQty,
        text: `${name}（${code}）占账户 ${pp(conc, 1)}，超过单票上限 ${pp0(POS_CFG.concMax)}`
          + `（市值 ${yuan(mv)} 元 / 总资产 ${yuan(T)} 元）`
          + `${cutQty ? `，建议减 ${cutQty} 股至上限附近` : '，但当前可卖数量不足，见 T+1 提示'}。`,
        why: `单票上限 ${pp0(POS_CFG.concMax)} 与「研判推荐」的个股建议仓位上限（picks.suggestWeight 的 perStockCap）一致：`
          + `系统给不出「这只该比那只多拿」的可靠依据，因此全系统统一按等权 + 20% 封顶。`
          + `单票超配会让账户收益被一只票的个体风险主导，与「分散」自相矛盾。`,
      });
    }

    // ④ T+1 未解冻
    if (qty > avail) {
      const locked = qty - avail;
      out.push({
        ...base, level: 'tip', type: 'pos-t1-locked', action: 'wait',
        weight: 35,
        qty: 0,
        text: `${name}（${code}）持仓 ${qty} 股中 ${locked} 股当日买入未解冻，今日不可卖；`
          + `可卖 ${avail} 股，次一交易日自动解冻。`,
        why: `A 股 T+1：settleDay 只在「明确的成交日」解冻（持仓字段 lastBuyDate ≠ 结算日才把 avail 置为 qty）。`
          + `这不是限制，而是如实告知——避免用户下了卖单却因可卖不足被拒。`,
      });
    }

    // ⑤ 到达目标仓位：档位允许新建时，单票目标 = 总仓位 ÷ 计划持有数，取 20% 封顶
    //    （与 picks.suggestWeight 同口径；这里用 20% 作为「单票目标上限」的保守参照）
    if (tier && tier.allowNew && conc >= POS_CFG.concMax * 0.8) {
      // 已在 16% 以上：接近 20% 单票上限，明确说「不要再加」
      out.push({
        ...base, level: 'tip', type: 'pos-at-target', action: 'hold',
        weight: 25,
        text: `${name}（${code}）已达单票目标仓位附近（${pp(conc, 1)} / 上限 ${pp0(POS_CFG.concMax)}），持有即可，不再加仓。`,
        why: `当前市场档位「${tier.label}」允许新建，但单票上限 ${pp0(POS_CFG.concMax)} 是硬约束；`
          + `把仓位加满一只票会牺牲分散度，收益并不因此更好。`,
      });
    }

    // ⑥ 不在今日推荐池（仅在引擎确实产出了推荐池时才提示——空池是无结论，不是「不推荐」）
    if (pickSet.size > 0 && !pickSet.has(String(code))) {
      out.push({
        ...base, level: 'tip', type: 'pos-not-in-picks', action: 'watch',
        weight: 15,
        text: `${name}（${code}）不在今日研判推荐池内`,
        why: `今日推荐池由「当日龙虎榜净买为正或涨停」筛出（区间累计榜与新股已剔除）。`
          + `不在池内只说明「今天没有新的资金证据支持加仓」，**不构成卖出依据**——持仓决策仍看成本、止损线与档位。`,
      });
    }

    // ⑦ 停牌 / 无当日行情
    if (p.pxStale || last == null) {
      out.push({
        ...base, level: 'tip', type: 'pos-stale-px', action: 'watch',
        weight: 30,
        text: `${name}（${code}）取不到当日真实行情（停牌或数据缺失），`
          + `市值按${last != null ? '最近成交价' : '成本价'}估算，浮盈与占比可能失真。`,
        why: `账户市值口径：有最新价按最新价、无价按成本（src/paper.js accountStats）。`
          + `无价时该票的浮动盈亏与仓位占比都是估算值，不应据此做强判断。`,
      });
    }

    // ⑧ 持仓票当日龙虎榜净买入 ≤ 0 —— 告警标签（用户要求「增加告警标签，人工复核后才允许下单」）
    //
    // 为什么持仓层也要有：这条规则的完整语义是「降低入选优先级 + 告警 + 人工复核」。
    // 如果标签只出现在「研判推荐」卡片上，那**已经持有**这只票的用户就完全看不到这个信号——
    // 而持仓恰恰是「可能还要加仓」的地方。这里只提示、不给一键买入动作：
    // 净流出是「谨慎开仓」的理由，不是「该抄底」的理由，给个买入按钮就把话说过头了。
    if (isNetOutflow(p.netWan).hit) {
      const v = p.netWan;
      const amt = v == null ? '当日龙虎榜无净买记录'
        : (v < 0 ? `当日龙虎榜净买 −${(Math.abs(+v) / 1e4).toFixed(2)} 亿` : '当日龙虎榜净买为 0');
      out.push({
        ...base, level: 'tip', type: 'pos-net-outflow', action: 'watch',
        weight: 40,
        netWan: v == null ? null : +v,
        text: `${name}（${code}）${FLAG_LHB.NET_OUTFLOW} —— ${amt}。`
          + `${qty > 0 ? '持仓已在，' : ''}如需加仓请先人工复核，不要照推荐位次直接下单。`,
        why: `判据：个股当日龙虎榜净买入 ≤ 0（与「研判推荐」的降级规则同一条，`
          + `唯一出处 src/lhbfilter.js::isNetOutflow）。该票在推荐链路里会被扣综合分/上涨概率、`
          + `降到备选观察池（禁止自动下单），并要求人工复核后才允许下单。`
          + `**净流出不等于次日必跌**，系统因此只标风险、不禁委托。`,
      });
    }
  }

  return out;
}

// ────────────────────────── 五、主入口 ──────────────────────────

/**
 * 生成预警列表。这是 UI 唯一该调用的函数。
 *
 * @param {object} p
 * @param {number|null} p.emotionScore 七因子情绪分（与研判报告同源）
 * @param {object} p.account         模拟账户（account.positions 等）
 * @param {object} p.stats           accountStats(account) 的结果
 * @param {number[]} [p.pickCodes]   今日研判推荐代码列表
 * @param {string} [p.asOf]          数据日期（用于 UI 标注）
 * @param {number} [p.limit]         最多返回多少条（默认 12；UI 卡片有折叠）
 * @returns {{asOf:string|null, tier:object|null, score:number|null, alerts:Array, counts:object, total:number, truncated:boolean}}
 */
export function buildAlerts({ emotionScore, account, stats, pickCodes, asOf, limit } = {}) {
  const tier = marketTier(emotionScore);
  const st = stats || (account ? accountStatsLite(account) : null) || { total: 0, marketValue: 0, cash: 0 };

  const raw = [
    ...marketAlerts({ emotionScore, total: st.total, marketValue: st.marketValue }),
    ...positionAlerts({ positions: account?.positions, stats: st, tier, pickCodes }),
  ];

  // 排序：风险 > 机会 > 提示；同级按权重降序；再同级按代码稳定排序（保证可复现）
  const lv = (l) => LEVELS.indexOf(l);
  const sorted = raw
    .map((a, i) => ({ ...a, _i: i }))
    .sort((a, b) => (lv(a.level) - lv(b.level))
      || ((b.weight || 0) - (a.weight || 0))
      || (String(a.code || '').localeCompare(String(b.code || '')))
      || (a._i - b._i))
    .map(({ _i, ...a }) => a);

  const counts = { risk: 0, opp: 0, tip: 0 };
  for (const a of sorted) counts[a.level] = (counts[a.level] || 0) + 1;

  const cap = finite(limit) && +limit > 0 ? Math.floor(+limit) : 12;
  const alerts = sorted.slice(0, cap);

  return {
    asOf: asOf || null,
    tier,
    score: finite(emotionScore) ? +emotionScore : null,
    alerts,
    counts,
    total: sorted.length,
    truncated: sorted.length > alerts.length,
  };
}

/**
 * 账户统计的**兜底**实现（仅在调用方没传 stats 时用）。
 * 正式口径一律走 src/paper.js 的 accountStats —— 这里只做「少传一个参数也不至于崩」的降级，
 * 且字段口径与之一致（有价按价、无价按成本）。重复的口径是隐患，故函数名加 Lite 以示区别。
 */
function accountStatsLite(acct) {
  const positions = Object.values(acct?.positions || {});
  const marketValue = positions.reduce((a, p) => a + (p.last != null ? p.last * p.qty : (p.avgCost || 0) * p.qty), 0);
  const cash = +acct?.cash || 0;
  const freeze = +acct?.freeze || 0;
  return { cash, freeze, marketValue, total: cash + freeze + marketValue };
}
