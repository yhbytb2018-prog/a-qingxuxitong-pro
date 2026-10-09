// 研判推荐引擎（唯一来源，ESM 纯函数、零依赖、Node 与浏览器共用）
//
// 定位：把系统已有的「市场研判结论」落到**具体个股**上，作为模拟交易的下单参考。
// 它不产生新的市场判断，只做一件事——**把已经算好的信号按同一套口径排序并给出可读理由**。
//
// ⚠ 2026-10-01 升级：推荐目标从「列出今天有资金证据的票」改为「**预测买入后大概率会涨的票**」。
//   打分/剔除规则全部下沉到 src/predict.js（基于 33 交易日真实前瞻收益回溯实测）。
//   本文件负责：候选池构建（去噪）→ 调用预测引擎筛选排序 → 组装展示字段。
//   职责边界：picks.js 管「哪些票进了池子、池子怎么去噪」；predict.js 管
//   「池子里哪些大概率涨、哪些必须扔掉」。两处都不要重复实现对方的规则。
//
// 为什么必须集中在这里、不能写在 UI：
//   推荐是「用户会照着下单」的东西，最容易因为口径漂移而误导。所以：
//     · 龙虎榜一律走 src/lhb.js 的当日榜口径（区间累计榜必须剔除，否则净买额是三天累计值）
//     · 情绪分与仓位档位取自与研判报告/回测引擎同源的输入，绝不另算一套
//     · 每只票的每条理由都必须能追溯到某个具体字段，禁止输出「综合来看不错」这类无依据措辞
//
// 三条硬纪律：
//   1. **只在有真实资金依据的池子里选**：龙虎榜当日净买 > 0，或当日涨停。其他票再好也不进推荐——
//      没有上榜就没有真实资金证据，推荐它就等于凭感觉。
//   2. **不做盈亏承诺、不给目标价**：只给「为什么今天值得看」与「风险在哪」，
//      概率分是「历史同特征组上涨占比」这个可核验统计量，不是主观置信度。
//   3. **仓位建议与市场档位联动**：市场情绪决定总仓位，个股均分——冰点区就该少拿甚至空仓，
//      逆着档位推荐重仓是自相矛盾。

// 口径唯一出处：区间榜判别式与新股判定一律走 src/lhb.js。
// 但 picks.js 是**浏览器也要用**的零依赖模块（paper_ui.js 直接 import），不能引 node 侧依赖——
// lhb.js 本身是纯函数无 node 依赖，故可直接复用，不再自己写正则（口径守卫会拦重复实现）。
import { RANGE_BOARD_RE, isNewStock } from './lhb.js';
// 龙虎降级规则（净买入 ≤ 0）：判据、扣分值、告警文案的唯一出处都在 src/lhbfilter.js。
// 本文件只负责「把扣分应用到综合分上」，绝不自己写 `netWan <= 0` 或手抄 10 分
// （判据/阈值一旦出现第二份，两处就会不同步——口径守卫会拦）。
import { isNetOutflow, LHB_NET_OUTFLOW_PENALTY, FLAG_LHB } from './lhbfilter.js';

/** 告警标签文案（唯一出处仍是 lhbfilter.js 的 FLAG_LHB，这里只是取个别名方便渲染层引用） */
export const NET_OUTFLOW_TAG = FLAG_LHB.NET_OUTFLOW;
// 预测与剔除引擎（上涨概率、连板概率、预期收益、止损位）。规则唯一出处，本文件不重写任何阈值。
import {
  predictPicks, probBandText, streakBandText, streakTagText,
  PREDICT_VERSION, BASELINE_UP, STREAK_BASELINE,
} from './predict.js';

// ────────────────────────── 常量（阈值集中在此，UI 不重写） ──────────────────────────

/** 推荐条数上限（Top N） */
export const PICK_TOP_N = 5;

/**
 * 评分权重。**必须和为 1**，否则分数不可比（有单测锁住）。
 * 每一项都对应一个可核验的原始字段，见下方 scoreCandidate 的注释。
 */
export const SCORE_WEIGHTS = {
  fund: 0.40,     // 龙虎榜当日净买额（真实资金，最强证据）
  streak: 0.25,   // 连板高度（市场共识强度）
  theme: 0.20,    // 是否归属当日主线题材（板块效应）
  liquidity: 0.15, // 龙虎榜成交额占当日全榜比重（可交易性/关注度）
};

/** 净买额分档（万元 → 0~1）。用对数尺度：1 亿与 10 亿的差别不该是 10 倍分数。
 *  注意：本表只处理**正数**；0 / null / 负数由 scoreFund 提前拦掉返回 0，
 *  否则 min:0 那一档会把「无净买记录」也算成有资金进场。 */
export const NET_STEPS = [
  { min: 50000, s: 1.00 },  // ≥5 亿
  { min: 20000, s: 0.90 },  // ≥2 亿
  { min: 10000, s: 0.80 },  // ≥1 亿
  { min: 5000, s: 0.65 },   // ≥5000 万
  { min: 2000, s: 0.50 },   // ≥2000 万
  { min: 1, s: 0.35 },      // 任何正的净买
];

/** 连板高度 → 0~1。1 板 0.35，之后每加一板 +0.25，4 板及以上封顶 1。 */
export const STREAK_MAX = 4;

/** 情绪分（七因子主分数，与研判报告/回测引擎同源）→ 市场档位。
 *  阈值与 V5.2 引擎一致：≥80 过热只减不新建 / ≥65 满仓 / 24~65 半仓 / ≤24 清仓。 */
export const TIER_THRESHOLDS = { overheat: 80, full: 65, half: 24 };

/** 档位 → { 标签、建议总仓位（占总资产比例）、是否允许新建仓 } */
export const POSITION_TIERS = [
  { key: 'overheat', label: '过热（只减仓不新建）', pos: 0.40, allowNew: false },
  { key: 'full', label: '满仓', pos: 1.00, allowNew: true },
  { key: 'half', label: '半仓', pos: 0.50, allowNew: true },
  { key: 'clear', label: '清仓', pos: 0.00, allowNew: false },
];

const r2 = (v) => Math.round(v * 100) / 100;
const finite = (v) => Number.isFinite(+v);

// ────────────────────────── 一、市场档位 ──────────────────────────

/**
 * 情绪分 → 市场档位（与 V5.2 引擎阈值同源）。
 * 独立导出便于单测直接锁阈值边界，不必构造整份存档。
 * @param {number|null} score 七因子加权情绪分（0~100）
 * @returns {{key:string,label:string,pos:number,allowNew:boolean}|null}
 */
export function marketTier(score) {
  // 注意：不能用 Number.isFinite(score)——空字符串 +'' 会得到 0，被当成「情绪分=0」→ 误判清仓。
  // 情绪分缺失必须返回 null（UI 据此显示「档位未知」），绝不默认任何档位。
  if (score == null || score === '' || typeof score === 'boolean') return null;
  if (!finite(score)) return null;
  const s = +score;
  const t = TIER_THRESHOLDS;
  if (s >= t.overheat) return POSITION_TIERS[0];
  if (s >= t.full) return POSITION_TIERS[1];
  if (s > t.half) return POSITION_TIERS[2];
  return POSITION_TIERS[3];
}

// ────────────────────────── 二、候选池构建（含去噪） ──────────────────────────

/**
 * 把当日的原始记录整理成「候选个股」列表。
 *
 * 去噪规则（每条都有实测依据，见注释）：
 *   · **剔除区间累计榜**：其净买额是连续 N 日累计值，当日值会被放大数倍（2026-09-30 实测
 *     全量 511 亿 vs 当日榜 136 亿），拿它排序会让区间票无脑霸榜。
 *   · **剔除新股/无涨跌幅限制个股**：上市首 5 日无涨跌停，涨跌幅可达 200%+（实测力勤资源
 *     +206.59%），与正常个股不可比，且本模拟器按板段判定涨跌停会误判。
 *   · **只保留净买为正**：净买为负说明资金在出，不能作为买入推荐（但可出现在「对冲提示」里）。
 *
 * @param {object} day archive 的某一天（含 lhb / hot / summary）
 * @param {object} [opts]
 * @param {number} [opts.minNetWan=0] 当日榜净买额下限（万元），默认只要为正
 * @returns {Array<object>} 候选（未评分、未排序）
 */
export function buildCandidates(day, opts = {}) {
  const d = day || {};
  const s = d.summary || {};
  const hot = Array.isArray(d.hot) ? d.hot : [];
  const lhbRows = Array.isArray(d.lhb) ? d.lhb : [];
  const minNet = finite(opts.minNetWan) ? +opts.minNetWan : 0;

  const ztCodes = new Set(Array.isArray(s.zt_codes) ? s.zt_codes : []);
  const ztLb = s.zt_lb && typeof s.zt_lb === 'object' ? s.zt_lb : {};
  const mainTheme = s.main_theme && s.main_theme.name ? s.main_theme.name : null;

  const byCode = new Map();

  const ensure = (code, seed) => {
    if (!code) return null;
    if (!byCode.has(code)) byCode.set(code, { code, name: seed.name || code, ...seed });
    const c = byCode.get(code);
    if (seed.name && (!c.name || c.name === c.code)) c.name = seed.name;
    return c;
  };

  // ① 龙虎榜当日榜：真实资金证据（主来源）
  for (const l of lhbRows) {
    if (!l || !l.code) continue;
    // 区间累计榜：值不是当日值，直接不进候选池（口径纪律，见 src/lhb.js 文件头）
    const isRange = l.is_range != null ? !!l.is_range : RANGE_BOARD_RE.test(String(l.reason || ''));
    if (isRange) continue;
    // 新股/无涨跌幅限制：涨跌幅不可比，且板段涨跌停判定会失真（判定走 lhb.js 唯一出处）
    if (isNewStock(l)) continue;

    const c = ensure(l.code, {
      name: l.name, close: l.close, changePct: l.change_pct,
      netWan: l.net_buy_wan, buyWan: l.buy_wan, sellWan: l.sell_wan,
      turnoverPct: l.turnover_pct, reason: l.reason, source: ['lhb'],
    });
    if (!c) continue;
    c.close = l.close ?? c.close;
    c.changePct = l.change_pct ?? c.changePct;
    c.netWan = l.net_buy_wan;
    c.buyWan = l.buy_wan;
    c.sellWan = l.sell_wan;
    c.turnoverPct = l.turnover_pct ?? c.turnoverPct;
    c.lhbReason = l.reason;
  }

  // ② 涨停/连板：市场共识证据（补充来源；已在龙虎榜里的做字段合并，不重复计一次）
  for (const code of ztCodes) {
    const h = hot.find((x) => x && x.code === code) || null;
    const c = ensure(code, {
      name: h ? h.name : code, close: h ? h.close : null, changePct: h ? h.change_pct : null,
      turnoverPct: h ? h.huanshou : null, reason: h ? h.reason : '', source: [],
    });
    if (!c) continue;
    if (!c.source.includes('zt')) c.source.push('zt');
    c.isZt = true;
    c.streak = finite(ztLb[code]) ? +ztLb[code] : 1;
    if (!finite(c.netWan)) c.netWan = null;
  }

  // ②B 用热点榜补充「业务/题材诱因」到**所有**已有候选（不限涨停股）。
  // 为什么单独一步：热点榜的 reason 是业务题材（「汽车电子+业绩预增」），
  // 龙虎榜的 reason 是上榜制度原因（「日涨幅偏离值达7%」），两者互不覆盖。
  // 早先只在涨停分支里合并，导致「上了龙虎榜但当天没涨停」的票题材匹配全部落空
  // （实测 themes 为空数组，主线判定因此失效）。
  const hotByCode = new Map();
  for (const h of hot) if (h && h.code) hotByCode.set(h.code, h);
  for (const c of byCode.values()) {
    const h = hotByCode.get(c.code);
    if (!h) continue;
    if (h.reason) c.hotReason = h.reason;
    // 主 reason 优先保留热点诱因（信息量更大），龙虎榜原因另存 lhbReason
    if (!c.reason || c.reason === c.lhbReason) c.reason = h.reason || c.reason;
    if (!finite(c.turnoverPct) && finite(h.huanshou)) c.turnoverPct = h.huanshou;
    if (c.close == null && h.close != null) c.close = h.close;
    if (c.changePct == null && h.change_pct != null) c.changePct = h.change_pct;
    if (!c.name || c.name === c.code) c.name = h.name || c.name;
    if (!c.source.includes('hot')) c.source.push('hot');
  }

  // ③ 题材归属：从 reason 文本里匹配当日题材词（与个股抽屉的匹配方式一致，避免两处口径不同）
  //
  // 但主线题材名可能是**聚合桶标签**，不会字面出现在任何 reason 里——实测
  // 「业绩线」在当日 56 只热点股的 reason 中出现 0 次，而「业绩增长/业绩预增/半年报扭亏」
  // 出现 8 次。若只做 includes(主线名)，主线判定会恒为 false（既有 scoreMainStructure /
  // selectMainLine 也有同样盲区）。这里做**两级匹配**并如实标注：
  //   精确命中（reason 含主线名）→ match 字段标 'exact'
  //   词根命中（reason 含与主线名共享 2 字词根的当日题材词）→ 标 'stem'，不冒充精确
  // 只在**当日题材词表**里找词根，不从任意文本里猜，避免把无关票算进主线。
  const themeWords = Object.keys(d.themes || {}).filter((t) => t && t.length >= 2);
  const stemOf = (w) => (String(w).length >= 2 ? String(w).slice(0, 2) : String(w));
  const mainStem = mainTheme ? stemOf(mainTheme) : null;
  const out = [];
  for (const c of byCode.values()) {
    // 题材词的来源文本 = 热点诱因 + 龙虎榜上榜原因 + 主 reason，三者取并集。
    // 只用其中一条会漏：热点诱因含业务题材，龙虎榜原因含上榜制度原因，互不覆盖。
    const text = [c.reason, c.hotReason, c.lhbReason].filter(Boolean).join(' ');
    c.themes = themeWords.filter((t) => text.includes(t)).slice(0, 4);
    let match = null;
    if (mainTheme && c.themes.includes(mainTheme)) match = 'exact';
    else if (mainStem && themeWords.some((t) => t !== mainTheme && stemOf(t) === mainStem && text.includes(t))) match = 'stem';
    c.inMainTheme = !!match;
    c.mainThemeMatch = match;
    // 硬门槛：净买为正（有真实资金进场）**或** 当日涨停（市场共识）
    const hasFund = finite(c.netWan) && c.netWan > minNet;
    const hasZt = !!c.isZt;
    if (!hasFund && !hasZt) continue;
    if (!c.source.length) continue;
    out.push(c);
  }
  return out;
}

// ────────────────────────── 三、评分 ──────────────────────────

/** 净买额（万元）→ 0~1 分档。**无净买记录（null）返回 0**，不能被 min=0 档当成「净买为正」。 */
export function scoreFund(netWan) {
  if (!finite(netWan)) return 0;
  const v = +netWan;
  if (v <= 0) return 0;   // 净卖/零：没有进场证据，不给分
  for (const st of NET_STEPS) if (v >= st.min) return st.s;
  return 0;
}

/** 连板高度 → 0~1 */
export function scoreStreak(streak) {
  if (!finite(streak) || +streak < 1) return 0;
  return Math.min(1, 0.35 + (+streak - 1) * 0.25);
}

/**
 * 综合评分（0~100）。权重必须和为 1，否则分数不可跨日比较。
 * 每一项都能追溯到原始字段：
 *   fund ← net_buy_wan（当日榜净买，万元）
 *   streak ← summary.zt_lb[code]（连板数）
 *   theme ← summary.main_theme.name 是否出现在该股题材列表（精确 1.0 / 词根 0.6 / 仅泛题材 0.4）
 *   liquidity ← deal 占当日全榜比重（用对数压缩，避免大票垄断）
 *
 * ⚠ 修正项：龙虎榜净买入 ≤ 0 时**扣减固定分值**（LHB_NET_OUTFLOW_PENALTY.SCORE，来自 lhbfilter.js）。
 *   为什么用「减法后夹 0~100」而不是把扣分塞进权重表：权重表和必须为 1（有单测锁住），
 *   往表里加一项就要重配所有其他项、且会稀释掉「分档可解释」这个性质；
 *   而负面证据天然是「在基础分上扣」，减法语义更直白，也不破坏任何原有因子的读数。
 *   注意：净买 ≤ 0 时 fund 因子本就是 0 分（scoreFund 对非正数返回 0）——那不是扣分，是「没拿到分」；
 *   这里再扣固定分，表达的是「不但没拿到资金证据，而且资金在往外走」这层额外负面信息。
 */
export function scoreCandidate(c, ctx = {}) {
  const totalDeal = finite(ctx.totalDealWan) && +ctx.totalDealWan > 0 ? +ctx.totalDealWan : null;
  const deal = (finite(c.buyWan) ? +c.buyWan : 0) + (finite(c.sellWan) ? +c.sellWan : 0);
  // 占全榜比重 → 0~1：拿 10% 以上给满分，用 sqrt 压缩（1% 与 4% 的差别比线性更合理）
  const liq = totalDeal && deal > 0 ? Math.min(1, Math.sqrt(deal / totalDeal / 0.10)) : 0;

  const parts = {
    fund: scoreFund(c.netWan),
    streak: scoreStreak(c.streak),
    // 精确命中主线给满分；词根命中（主线名为聚合桶标签时）给 0.6——证据弱于精确命中，但不为 0
    theme: c.mainThemeMatch === 'exact' ? 1 : (c.inMainTheme ? 0.6 : (c.themes && c.themes.length ? 0.4 : 0)),
    liquidity: liq,
  };
  const raw = Object.entries(SCORE_WEIGHTS)
    .reduce((a, [k, w]) => a + w * (parts[k] || 0), 0);

  // 龙虎净买 ≤ 0 → 固定扣分（判据唯一出处：lhbfilter.isNetOutflow）
  const outflow = isNetOutflow(c.netWan);
  const penalty = outflow.hit ? LHB_NET_OUTFLOW_PENALTY.SCORE : 0;
  const score = Math.max(0, Math.min(100, Math.round((raw * 1000) / 10) - penalty));

  return {
    score, parts, penalty,
    netOutflow: outflow.hit,
    // 保留扣分前的原始分，便于页面上说清「这一分是怎么被扣掉的」（可核验性）
    rawScore: Math.round(raw * 1000) / 10,
    outflowText: outflow.hit
      ? `龙虎榜净买入 ≤ 0 → 综合分扣 ${penalty} 分（${Math.round(raw * 1000) / 10} → ${score}）`
      : null,
  };
}

// ────────────────────────── 四、理由与风险（必须是可核验的事实） ──────────────────────────

const yi = (wan) => (finite(wan) ? (Math.abs(+wan) / 1e4).toFixed(2) : '—');

/**
 * 生成可读理由标签。**每条都对应一个真实字段**，不允许出现「综合来看不错」这类无依据措辞。
 */
export function reasonsOf(c) {
  const out = [];
  if (finite(c.netWan) && c.netWan > 0) {
    out.push({ kind: 'fund', text: `龙虎榜净买 ${yi(c.netWan)} 亿`, tone: 'up' });
  }
  if (c.isZt) {
    out.push({ kind: 'zt', text: c.streak > 1 ? `涨停（${c.streak} 连板）` : '涨停', tone: 'up' });
  }
  if (c.inMainTheme) {
    out.push({
      kind: 'theme',
      // 词根命中不得说成「属主线」——主线名是聚合桶标签时，只能说「与主线同源」
      text: c.mainThemeMatch === 'exact' ? '属当日主线题材' : '与主线题材同源（词根匹配）',
      tone: 'up',
    });
  } else if (c.themes && c.themes.length) out.push({ kind: 'theme', text: `题材：${c.themes.slice(0, 2).join('、')}`, tone: 'muted' });
  // 龙虎净买 ≤ 0：**必须显式打告警标签**（用户要求「增加告警标签，人工复核后才允许下单」）。
  // 文案与扣分值全部来自 lhbfilter.js，此处不重写一个字——标签就是规则对用户的可见面。
  // 放在最后（tone=warn）：负面标签排在正面理由之后，读起来是「有这些理由，但注意这一点」。
  if (isNetOutflow(c.netWan).hit) {
    out.push({ kind: 'outflow', text: NET_OUTFLOW_TAG, tone: 'warn' });
  }
  if (finite(c.turnoverPct) && c.turnoverPct >= 20) {
    out.push({ kind: 'turn', text: `换手 ${r2(c.turnoverPct)}%（高换手）`, tone: 'warn' });
  }
  return out;
}

/**
 * 风险提示。**必须给出，且必须具体**——只说「注意风险」等于没说。
 * 这里的每条都对应一个可观察的负面特征。
 */
export function risksOf(c) {
  const out = [];
  if (finite(c.streak) && c.streak >= 3) {
    out.push(`${c.streak} 连板高位，断板当日回撤可能很大`);
  }
  if (finite(c.turnoverPct) && c.turnoverPct >= 25) {
    out.push(`换手 ${r2(c.turnoverPct)}% 偏高，筹码不稳定`);
  }
  if (finite(c.changePct) && c.changePct >= 9.8) {
    out.push('当日已涨停，次日存在冲高回落风险');
  }
  // 无龙虎榜资金证据（只靠涨停入选）——如实说明证据强度弱
  if (!finite(c.netWan) || c.netWan <= 0) {
    out.push('无当日龙虎榜净买记录，仅有涨停证据，证据强度弱于榜首标的');
  }
  // 科创板/创业板 20% 振幅
  const code = String(c.code || '');
  if (/^(30|688)/.test(code)) out.push('20% 涨跌幅品种，波动天然大于主板');
  if (/^(4|8|920)/.test(code)) out.push('北交所标的，流动性弱于沪深');
  return out;
}

// ────────────────────────── 五、仓位建议（与市场档位联动） ──────────────────────────

/**
 * 个股建议仓位（占总资产比例）。市场档位定总仓位，个股均分。
 * 为什么均分：系统给不出「这只比那只该多拿多少」的可靠依据，
 * 假装能给出差异化的个股权重是过度自信。宁可知乎其分。
 */
export function suggestWeight(tier, n, opts = {}) {
  if (!tier || !tier.allowNew || !(n > 0)) return 0;
  const cap = finite(opts.perStockCap) ? +opts.perStockCap : 0.20; // 单只上限，避免全押一只
  const avg = tier.pos / n;
  return Math.round(Math.min(cap, avg) * 1e4) / 1e4;
}

// ────────────────────────── 六、主入口 ──────────────────────────

/**
 * 产出推荐列表。这是 UI 唯一该调用的函数。
 *
 * 流程：候选池（去噪）→ 预测引擎（剔除大概率亏 + 概率排序）→ 仓位与说明组装。
 *
 * @param {object} day     archive 的某一天
 * @param {object} ctx     市场上下文
 * @param {number} ctx.emotionScore  七因子情绪分（与研判报告同源）
 * @param {number} [ctx.topN]
 * @param {number} [ctx.minProb] 概率分下限（默认取 predict.js 的中等档起点 57）
 * @param {number} [ctx.streakTopMin] 连板概率置顶门槛（默认 30，来自 predict.js 的 STREAK_TOP_MIN）
 * @param {number} [ctx.stopLossPct] 单笔止损线（调用方传 alerts.js 的 POS_CFG.stopLoss 保持同源；
 *                                   不在这里 import alerts.js 是为了避免 picks ⇄ alerts 互引）
 * @returns {{tier:object|null, score:number|null, picks:Array, rejected:Array,
 *            note:object, asOf:string|null, pool:number, pred:object, version:string}}
 */
export function recommendPicks(day, ctx = {}) {
  const d = day || {};
  const tier = marketTier(ctx.emotionScore);
  const topN = finite(ctx.topN) && +ctx.topN > 0 ? Math.floor(+ctx.topN) : PICK_TOP_N;

  const candidates = buildCandidates(d);
  const totalDealWan = candidates.reduce((a, c) => a + (finite(c.buyWan) ? +c.buyWan : 0) + (finite(c.sellWan) ? +c.sellWan : 0), 0);

  // 先补上「可核验理由/风险」与流动性分（这些是展示字段，与预测相互独立）
  const enriched = candidates.map((c) => {
    const sc = scoreCandidate(c, { totalDealWan });
    return {
      ...c, score: sc.score, scoreParts: sc.parts,
      // 扣分链路透出（页面要能说清「这一分是怎么被扣的」，不能只给一个变小了的数）
      scorePenalty: sc.penalty, scoreRaw: sc.rawScore, scoreOutflow: sc.netOutflow,
      reasons: reasonsOf(c), risks: risksOf(c),
    };
  });

  // 交给预测引擎：剔除大概率亏的，连板概率高的置顶，其余按上涨概率排序
  const ztCount = finite(d.summary && d.summary.zt_count) ? +d.summary.zt_count : null;
  const pred = predictPicks(enriched, {
    topN, ztCount, minProb: ctx.minProb, stopLossPct: ctx.stopLossPct,
    streakTopMin: ctx.streakTopMin,
  });

  const picks = pred.picks;
  const weight = suggestWeight(tier, picks.length);
  for (const p of picks) {
    p.suggestWeight = weight;
    // 宽波动品种（创业板/科创板）按预测引擎的建议把仓位打折
    const factor = p.stop && finite(p.stop.maxPosFactor) ? +p.stop.maxPosFactor : 1;
    p.suggestWeight = Math.round(weight * factor * 1e4) / 1e4;
    p.probText = probBandText(p.prob.score);
    // 连板标签：只有达到置顶门槛的票才给标签，避免「所有 2 板都贴连板」
    p.streakText = streakTagText(p.limitUp);
    p.streakBandText = p.limitUp && p.limitUp.prob != null ? streakBandText(p.limitUp.prob) : null;
  }

  // 空态与拒绝态必须说清原因，不能只给一个空列表
  let note;
  if (!candidates.length) {
    note = { level: 'empty', text: '当日没有同时满足「龙虎榜净买为正」或「涨停」的标的，本日不产生推荐。' };
  } else if (!picks.length) {
    // 有候选但全被预测引擎筛掉——必须如实说明，不能让人以为今天没票
    note = {
      level: 'empty',
      text: `当日候选池 ${candidates.length} 只，但按预测规则全部未达推荐门槛`
        + `（剔除 ${pred.stats.rejected} 只、概率分不足 ${pred.stats.minProb} 的 ${pred.stats.below} 只）。`
        + '宁可不推荐，也不推大概率亏的票。',
    };
  } else if (tier && !tier.allowNew) {
    note = {
      level: 'blocked',
      text: `当前市场档位为「${tier.label}」，系统建议总仓位 ${Math.round(tier.pos * 100)}%、不新建仓。`
        + `下列标的仅供观察，不建议此时建仓。`,
    };
  } else if (tier) {
    note = {
      level: 'ok',
      text: `当前市场档位「${tier.label}」，建议总仓位 ${Math.round(tier.pos * 100)}%，`
        + `按 ${picks.length} 只均分即每只约 ${(weight * 100).toFixed(1)}%（单只上限 20%）。`
        + (pred.stats.streakTop
          ? `其中 ${pred.stats.streakTop} 只 T+1 连板概率 ≥${pred.stats.streakTopMin}%，已置顶并打标签。`
          : '当日无连板概率达门槛的标的。'),
    };
  } else {
    note = { level: 'unknown', text: '市场情绪分缺失，无法给出仓位建议；下列标的仅按预测上涨概率排序。' };
  }

  return {
    tier, score: finite(ctx.emotionScore) ? +ctx.emotionScore : null,
    picks,
    // 三个「非推荐」桶全部透出，保证进池的每一只票都能被用户看见，不被静默丢弃：
    //   rejected       —— 命中剔除规则（大概率亏），必须展示原因
    //   belowThreshold —— 概率分不足门槛（没把握，宁可不推）
    //   overflow       —— 达门槛但被 topN 截断（够格，只是名额有限）
    rejected: pred.rejected.slice(0, 12),
    belowThreshold: pred.belowThreshold.slice(0, 8),
    overflow: pred.overflow.slice(0, 8),
    note, pool: candidates.length, asOf: d.trade_date || null,
    pred: pred.stats, version: PREDICT_VERSION, baseline: BASELINE_UP,
    streakBaseline: STREAK_BASELINE,
  };
}
