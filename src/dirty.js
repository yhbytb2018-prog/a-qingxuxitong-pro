// 异常值 / 脏数据自动标脏（#3）
//
// ── 为什么需要这一层 ────────────────────────────────────────────────────────
//
// 现状：抓取层拿到的任何数字都会**静默进入档案**，一路流到 computeSentiment，
//   变成情绪分的一部分。实测 241 天档的字段可用率（up_count 3/241、seats 3/241、
//   zt_count 18/241、amount_yi 33/241）说明：**绝大多数天的原料来自回填与代理**，
//   而这些路径没有一道"这个值合不合理"的检查。用户点名的三类事故：
//     ① 某行业涨跌幅 ±20% 但指数只动 1%  → 单源抽风，值本身越界
//     ② 净买单位万/亿搞反              → 量级差 1e4，值"合法"但离谱
//     ③ 同一 code 重复出现             → 重复计数，家数/净额双双虚高
//
// 设计原则（与本项目一贯纪律对齐）：
//   • **标脏 ≠ 删值**：脏字段打 `dirty` 标记并**从该因子入参中剔除**，但原值保留在档里
//     （可追溯、可比对、可人工复核）。绝不像"抓不到就中性 50"那样把失败伪装成平静。
//   • **口径唯一出处**：所有阈值集中在本文件 `VALIDATION_RULES`，下游不得各自写死数字。
//   • **缺失显式化**：unknown ≠ ok，null ≠ 0。判不出的字段返回 `unknown`，不是 `ok`。
//   • **纯函数 + 无依赖**：不 import 业务模块，可被管线、切片、前端、审计共用。
//
// 与 #2（跨源互证）的分工：
//   本层是**单源内部**校验（范围/单位/重复/一致性），不需要第二个源，故能覆盖全部
//   241 天（甚至没有行业明细的历史天，也能校验净买/涨跌家数）。#2 是**跨源**校验，
//   只在双源齐备的日子可用（当前行业明细 33 天）。两层是串联关系：#2 的输出可直接
//   喂进本层的 `extraDirty` 参数，共用同一套标脏语义与同一份报告结构。

// ── 销案台账主键（唯一实现在 src/outlier_review.js，零依赖工具层）──────────
//   OUTLIER_INDUSTRY 是 WARN（只标不剔除）：真实行情的离群会重复报，久了会被忽略。
//   data/industry_outlier_review.json 记录「已跨源核验为真实」的 (日期, 行业)，
//   扫描时命中即不再重复报，转为 suppressedReviews（诚实披露：不是没发现，是已销案）。
//   ⚠ 销案只影响是否重复报警，不动任何数值、不改 dirty/干净判定。
import { reviewKey } from './outlier_review.js';

// ── 阈值唯一出处 ──────────────────────────────────────────────────────────

export const VALIDATION_RULES = {
  // ① 范围校验（Range）
  //    行业涨跌幅：A 股单日个股涨跌幅上限 ±20%（创业板/科创板），行业指数是成分股
  //    加权，单日 |涨跌| 超过 15% 在数学上需要几乎所有成分股同时涨停/跌停——现实中
  //    不存在。用 15% 作行业阈值（挡住 ±20%+ 这类字段错位脏值）。
  //    ⚠ 规则修正记录（第二版，实测打脸，勿回退）：初版取 12%，2026-03-02/03-03
  //    油气开采及服务 +12.23%/+12.22% 被判 ERROR 剔除——经腾讯K线微观验证，两日
  //    油服权重股集体顶板（中国海油/中海油服/中曼石油/贝肯能源 +10%、通源石油/
  //    潜能恒信 +20%），加权 12.2% 是真实极端行情；且两日龙头均有邻居（贵金属
  //    10.69% / 燃气 9.47%），符合"主题级行情有邻居"形态。把真行情判 ERROR 剔除
  //    是把信号当噪声（本项目头号纪律），阈值上调至 15。
  INDUSTRY_CHANGE_ABS_MAX: 15,
  //    行业截面离群判定（gap 判据）：某行业与「最近的其他行业」相距超过此百分点数，
  //    且自身 |涨跌| > DIVERGENCE_MAX → 判为孤立离群（无人印证，疑源抽风）。
  //    取 4.0：真实行情里强板块总有邻居（实测 8-18 龙头 9.36% 与次强 3.51% 相距 5.85，
  //    但中间还有 2.95/2.3/2.07/1.53 一串递减值 → 龙头与**最近者**仅差 0.44）；
  //    源抽风则是孤峰，与最近者相差常 >5。
  INDUSTRY_GAP: 4,
  INDUSTRY_DIVERGENCE_MAX: 8,
  //    参与 MAD 计算的最少行业数（不足则不做离群判定，宁可不判也不误报）
  MIN_INDUSTRY_SAMPLE: 20,
  //    指数「系统性波动」阈值：指数 |涨跌| 超此值说明当日有系统性行情，
  //    此时才启用"行业逆势极端"判定（轮动日指数不动，该判定无意义）
  INDEX_SYSTEMIC_MOVE: 2,
  //    指数系统性波动时，行业与其反向下偏离超过此幅度 → 判脏
  INDUSTRY_COUNTER_MAX: 10,
  //    个股涨跌幅：考虑新股/无涨跌幅限制标的，上限放到 100%（首日暴涨常见 +44%~+300%，
  //    但我们只校验"是否超过 100"这种明显错位；涨跌幅字段本应 ≤ 44% 对主板，
  //    但科创板/创业板 20%、北交所 30%、新股不设限 → 用一个宽阈值只挡"数据错位"）
  STOCK_CHANGE_ABS_MAX: 100,
  //    情绪分：模型定义域 [0,100]
  SCORE_MIN: 0,
  SCORE_MAX: 100,
  //    因子分：模型定义域 [0,100]（computeSentiment 内部 clamp，故此处只做兜底）
  FACTOR_MIN: 0,
  FACTOR_MAX: 100,
  // ② 单位校验（Unit）
  //    龙虎榜净买额（亿）：A 股单日全市场龙虎榜净买的历史量级在 ±50 亿内（实测 241 天
  //    p50=11.65、p75=20.09、max≈28）。若出现 |净买| > 300 亿，几乎必然是「万/亿」
  //    单位搞反（把万元当亿元 → 放大 1e4）；或解析错位。
  LHB_NET_YI_ABS_MAX: 300,
  //    成交额（亿）：全 A 单日成交额常态 0.5~2.5 万亿 → [500, 40000] 亿。
  //    低于 500 亿说明只统计了部分市场（口径残缺），高于 4 万亿超出历史极值。
  AMOUNT_YI_MIN: 500,
  AMOUNT_YI_MAX: 40000,
  // ③ 重复检测（Duplicate）
  //    同一 code 在「当日榜」里出现多次 → 重复计数（家数虚高、净额重复累加）
  DUPLICATE_CODE_ALLOWED: 0,
  // ④ 一致性校验（Consistency）
  //    涨跌家数之和应 ≈ 全市场股票数；低于此值说明只抓到部分（口径残缺）
  BREADTH_MIN_TOTAL: 1000,
  //    涨停数不应大于上涨家数（逻辑不可能）
  ZT_LE_UP: true,
  //    席位覆盖率：席位明细覆盖的上榜个股比例，分母是当日榜个股数
  SEAT_COVER_MAX: 100,
};

// 脏数据等级：error = 必剔（值不可信）；warn = 留用但标记（值可疑）
export const SEVERITY = { ERROR: 'error', WARN: 'warn' };

// ── 工具（本地实现，避免 import 业务模块造成的循环依赖）────────────────────

// 与 src/breadth.js 的 num 同款加固：拒绝数组/对象/布尔（+[]===0 陷阱）。
// 本项目已多次踩 +0 类陷阱（+null 判成有限数、+[]===0、+''===0），
// 故凡是"把外部值转数字"的地方一律走这里。
export function num(v) {
  if (v == null || v === '') return null;
  const t = typeof v;
  if (t !== 'number' && t !== 'string') return null;
  const n = +v;
  return Number.isFinite(n) ? n : null;
}

export function round2(v) {
  return v == null ? null : Math.round(v * 100) / 100;
}

// 中位数（稳健统计量）。空数组 → null（不猜 0，缺失显式化）。
//   ⚠ 必须走 num() 而不是对值直接做有限性判断：后者会把空数组 / 空串 / 布尔
//   当成合法数字（一元加号下它们都变 0），把"空数组"混进统计量里。
//   这是本项目第四次同类教训（详见 num() 的注释）。
export function median(vals) {
  const a = (Array.isArray(vals) ? vals : []).map((v) => num(v)).filter((v) => v !== null);
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ── 单条校验记录构造 ──────────────────────────────────────────────────────
// 统一形态：{ field, code, rule, severity, reason, value, expected }
//   • field    —— 哪个字段（'summary.amount_yi' 这种带路径的，便于定位）
//   • code     —— 涉及的股票代码（非个股问题为 null）
//   • reason   —— 人类可读的原因（报告直接引用，不得下游重写）
function issue(field, rule, severity, reason, value, expected = null, code = null) {
  return { field, code, rule, severity, reason, value: round2(value) ?? value, expected };
}

// ── 主校验函数 ────────────────────────────────────────────────────────────
//
// 输入一个「日」（archive 里的一天），输出：
//   {
//     date,
//     status: 'ok' | 'warn' | 'dirty',      // dirty 表示有 error 级问题
//     dirtyFields: string[],                // 需要从因子入参剔除的字段路径
//     warnFields: string[],                 // 留用但标记的字段
//     issues: [...],                        // 全部问题明细（含 warn）
//     checked: { days: 1, rules: n },       // 校验覆盖度（供报告"校验了哪些"）
//   }
//
// 关键输出是 **dirtyFields**：管线在 computeSentiment 之前先跑本函数，拿到
// dirtyFields 后把对应入参置 null → computeSentiment 自然走它的 missing/proxy 路径
// （这是既有的、已测试的"缺失显式化"通道），而不是被脏值污染。
export function validateDay(day, opts = {}) {
  const issues = [];
  // 销案集合：Set<'date|industry'>（由 src/outlier_review.js 的 confirmedSet 生成）。
  // 未注入 = 空集 = 全部照常报警（缺省不销案——销案必须显式）。
  const reviewed = opts.reviewedOutliers instanceof Set
    ? opts.reviewedOutliers
    : new Set(Array.isArray(opts.reviewedOutliers) ? opts.reviewedOutliers : []);
  const suppressed = [];
  if (!day || typeof day !== 'object') {
    return { date: null, status: 'dirty', dirtyFields: [], warnFields: [], issues: [issue('day', 'STRUCTURE', SEVERITY.ERROR, '不是对象', null)], suppressedReviews: [], checked: { days: 0, rules: 0 } };
  }
  const s = day.summary || {};
  const em = day.emotion || {};
  const R = VALIDATION_RULES;

  // ── ① 范围校验：行业涨跌幅 ────────────────────────────────────────────
  const industries = Array.isArray(day.industry) ? day.industry : [];
  //
  // ⚠ 规则修正记录（第一版设计错误，实测抓出，勿回退）：
  //   初版规则是「行业 |涨跌| > 8% 而指数 |涨跌| < 1.5% → 判脏」。全档 241 天实测
  //   命中 2 天（2026-08-18 种植业与林业 +9.36%、2026-08-20 生物制品 +9.12%）。
  //   经查证**两天都是真实行情**：
  //     • 8-18 农林牧渔板块领涨（粮食/猪肉概念爆发、十余只涨停），当日 2121 涨 /
  //       3292 跌、指数近乎持平 —— 这是典型的**板块轮动**；
  //     • 8-20 东财口径生物制品 +8.64%、医疗服务 +6.06%、掀涨停潮（mRNA 癌症疫苗
  //       消息驱动），与本地档 +9.12% 相互印证。
  //   根本谬误：A 股指数是**自由流通市值加权**，由权重股主导。小板块涨 9% 而指数
  //   不动，恰恰是"轮动"的定义——而这正是本项目要研究的现象。用它判脏等于把
  //   **信号当噪声**过滤掉。
  //
  // 正确判据（第二版，MAD 版亦被实测证伪，见下）：
  //   直觉是「这个行业的涨幅有没有**邻居印证**」。真实板块行情一定是**簇状**的
  //   ——龙头板块涨，上下游/同类板块跟着涨（8-18 的种植业与林业 9.36% 旁边就有
  //   农产品加工 3.51%、养殖业 2.95%；8-20 的生物制品 9.12% 旁边有医疗服务 5.9%、
  //   医疗器械 4.14%）。源抽风则是**孤零零一个值**跳出分布，与第二名的差距巨大。
  //   故用**排序后相邻两点间的断崖（gap）**判据：某值的"离群度" = 它与**其他所有
  //   值**中最近者的距离。若这个最近者仍离它很远（> GAP），说明无人印证 → 判脏。
  //
  // ⚠ 为什么不用 MAD：初版用「偏离中位数 > k×MAD」，但 MAD 在「多数行业涨跌幅
  //   相同」时会退化为 0（实测构造中 60/95 个行业都是 +0.2% → MAD=0），此时任何
  //   偏离都成 Infinity → 全体误报。MAD 适合"单点污染"，而我们面对的是"尾部整体抬升"，
  //   两者形态不同，工具必须换。gap 判据对尾部抬升天然免疫（簇内每点都有邻居）。
  const indVals = industries.map((it) => num(it.change_pct)).filter((v) => v != null);
  const sorted = indVals.slice().sort((a, b) => a - b);
  const gapThreshold = R.INDUSTRY_GAP;
  industries.forEach((it) => {
    const c = num(it.change_pct);
    if (c == null) return; // 缺失不在此层判（由 missing 通道负责）
    const abs = Math.abs(c);
    // (a) 硬物理上限：超过单日个股最大涨跌幅的行业指数，数学上不可能
    if (abs > R.INDUSTRY_CHANGE_ABS_MAX) {
      issues.push(issue('industry[].change_pct', 'RANGE_INDUSTRY', SEVERITY.ERROR,
        `行业「${it.name || '?'}」涨跌幅 ${round2(c)}% 超出 ±${R.INDUSTRY_CHANGE_ABS_MAX}% 物理上限`, c, `±${R.INDUSTRY_CHANGE_ABS_MAX}`));
      return;
    }
    // (b) 孤立离群：与"最近的其他行业值"相距也超过 GAP，且自身幅度够大
    if (indVals.length >= R.MIN_INDUSTRY_SAMPLE && abs > R.INDUSTRY_DIVERGENCE_MAX) {
      let nearest = null;
      for (const v of sorted) {
        if (v === c) continue;
        const d = Math.abs(v - c);
        if (nearest == null || d < nearest) nearest = d;
      }
      // 同值的其他行业（有兄弟）→ 最近的同向值就在旁边，差值 0，不会判脏
      if (nearest != null && nearest > gapThreshold) {
        // ⚠ 严重度：WARN 而非 ERROR（第三版决定，实测两轮打脸后定稿）
        //   实测 2026-08-18：种植业与林业 9.36% 与次强 3.51% 相距 5.85（断崖明显），
        //   但该日农林牧渔整条产业链（农产品加工/养殖业/农化制品）齐涨——印证是
        //   **主题级**的，不在"数值相邻"上体现。故"数值孤立"无法可靠区别于"主题集中"，
        //   把真行情判成 ERROR 并剔除数据，等于**把信号当噪声**（本项目头号纪律）。
        //   本规则退为 WARN：**只标记、不剔除、不污染情绪分**，交人工复核。
        //   真正的源抽风检测交给 #2 跨源互证（同一行业在两个独立源的值直接比对），
        //   那才是"同一事实的两个独立测量"，形态清晰。
        //
        //   销案（v2）：若该 (日期, 行业) 已在 data/industry_outlier_review.json 中
        //   经**跨源复算**确认为真实行情 → 不再重复报 warn，转为 suppressedReviews。
        //   缺省（未注入台账）一律照报——销案必须显式，不存在"默认闭嘴"。
        const key = reviewKey(day.trade_date, it.name);
        if (reviewed.has(key)) {
          suppressed.push({
            rule: 'OUTLIER_INDUSTRY', industry: it.name || null,
            changePct: round2(c), nearest: round2(nearest),
            reason: '已跨源核验为真实行情，销案（data/industry_outlier_review.json）',
          });
        } else {
          issues.push(issue('industry[].change_pct', 'OUTLIER_INDUSTRY', SEVERITY.WARN,
            `行业「${it.name || '?'}」${round2(c)}% 与最近的其他行业相距 ${round2(nearest)} 个百分点（数值孤立，需人工复核是否主题集中）`,
            c, `与其他行业相距 ≤${gapThreshold}`));
        }
      }
    }
  });
  // (c) 行业涨跌幅与「同源指数」的**方向性**矛盾：仅在指数也大幅波动时才有意义。
  //     指数动 >2% 说明当日确有系统性行情；此时若出现**反向且离群**的行业值，
  //     比"指数不动而行业动"更可疑。
  //     ⚠ 严重度：WARN 而非 ERROR（2026-10-05 降级，实测第三例打脸）：
  //       2026-03-03 深证 -3.07% / 创业板 -2.57% 的系统性下跌中，能源链条逆势大涨
  //       （油气开采 +12.22 / 燃气 +9.47 / 港口航运 +4.81 / 石油加工 +4.58 / 煤炭
  //       +3.04）。经同花顺行业指数（881xxx）日K 收盘口径独立复算，五个值全部
  //       Δ=0.00 精确吻合——真实主题行情（系统性下跌中资金轮动进能源/防御链）。
  //       本规则原前提「轮动不会逆着系统性大跌走极端」被实证证伪，与 (b) 的两例
  //       （8-18 农林牧渔链、贵金属链）同构：链条式逆势大涨是真实行情形态。
  //       判 ERROR 会剔除 industryUp（s_brd 退化为 upRatio 代理）＝把信号当噪声
  //       （头号纪律）。降为 WARN：只标记、不剔除，交人工复核 + 跨源核验销案
  //       （scripts/verify_industry_outliers.mjs 已纳入本规则的自动核验收集）。
  const idxChange = indexChangePct(day);
  if (idxChange != null && Math.abs(idxChange) > R.INDEX_SYSTEMIC_MOVE) {
    industries.forEach((it) => {
      const c = num(it.change_pct);
      if (c == null) return;
      if (Math.abs(c) > R.INDUSTRY_DIVERGENCE_MAX && Math.sign(c) !== Math.sign(idxChange)
          && Math.abs(c - idxChange) > R.INDUSTRY_COUNTER_MAX) {
        const key = reviewKey(day.trade_date, it.name);
        if (reviewed.has(key)) {
          suppressed.push({
            rule: 'COUNTER_INDEX', industry: it.name || null,
            changePct: round2(c), indexChange: round2(idxChange),
            reason: '已跨源核验为真实行情，销案（data/industry_outlier_review.json）',
          });
        } else {
          issues.push(issue('industry[].change_pct', 'COUNTER_INDEX', SEVERITY.WARN,
            `行业「${it.name || '?'}」${round2(c)}% 与大盘 ${round2(idxChange)}% 反向且幅度异常（系统性波动下逆势极端，需复核是否主题轮动）`, c, `同向`));
        }
      }
    });
  }

  // ── ① 范围校验：个股涨跌幅（hot 强势股）──────────────────────────────
  const hot = Array.isArray(day.hot) ? day.hot : [];
  hot.forEach((h) => {
    const c = num(h.change_pct);
    if (c == null) return;
    if (Math.abs(c) > R.STOCK_CHANGE_ABS_MAX) {
      issues.push(issue('hot[].change_pct', 'RANGE_STOCK', SEVERITY.ERROR,
        `${h.name || h.code || '?'} 涨跌幅 ${round2(c)}% 超物理可能（疑字段错位）`, c, `±${R.STOCK_CHANGE_ABS_MAX}`, h.code || null));
    }
  });

  // ── ① 范围校验：成交额 ────────────────────────────────────────────────
  const amt = num(s.amount_yi);
  if (amt != null) {
    if (amt < R.AMOUNT_YI_MIN || amt > R.AMOUNT_YI_MAX) {
      issues.push(issue('summary.amount_yi', 'RANGE_AMOUNT', SEVERITY.ERROR,
        `成交额 ${round2(amt)} 亿不在 [${R.AMOUNT_YI_MIN}, ${R.AMOUNT_YI_MAX}] 合理区间（疑单位/口径错）`, amt, `[${R.AMOUNT_YI_MIN}, ${R.AMOUNT_YI_MAX}]`));
    }
  }

  // ── ① 范围校验：情绪分 / 因子分 ──────────────────────────────────────
  const score = num(em.value ?? em.score);
  if (score != null && (score < R.SCORE_MIN || score > R.SCORE_MAX)) {
    issues.push(issue('emotion.value', 'RANGE_SCORE', SEVERITY.ERROR,
      `情绪分 ${score} 越界 [${R.SCORE_MIN}, ${R.SCORE_MAX}]`, score, `[${R.SCORE_MIN}, ${R.SCORE_MAX}]`));
  }
  const emFactors = em.factors || {};
  for (const [k, v] of Object.entries(emFactors)) {
    const fv = num(v);
    if (fv == null) continue;
    if (fv < R.FACTOR_MIN || fv > R.FACTOR_MAX) {
      issues.push(issue(`emotion.factors.${k}`, 'RANGE_FACTOR', SEVERITY.ERROR,
        `因子 ${k} = ${fv} 越界 [${R.FACTOR_MIN}, ${R.FACTOR_MAX}]`, fv, `[${R.FACTOR_MIN}, ${R.FACTOR_MAX}]`));
    }
  }

  // ── ② 单位校验：龙虎榜净买额 ─────────────────────────────────────────
  for (const [field, label] of [
    ['lhb_daily_net', '当日榜净买'],
    ['lhb_all_net', '全量口径净买'],
    ['lhb_new_net', '新股净买'],
  ]) {
    const v = num(s[field]);
    if (v == null) continue;
    if (Math.abs(v) > R.LHB_NET_YI_ABS_MAX) {
      issues.push(issue(`summary.${field}`, 'UNIT_LHB', SEVERITY.ERROR,
        `${label} ${round2(v)} 亿超 ±${R.LHB_NET_YI_ABS_MAX} 亿（疑万/亿单位搞反）`, v, `±${R.LHB_NET_YI_ABS_MAX}`));
    }
  }

  // ── ③ 重复检测：同一 code 在 hot 里重复 ──────────────────────────────
  const codeCount = new Map();
  hot.forEach((h) => {
    const c = h && h.code;
    if (!c) return;
    codeCount.set(c, (codeCount.get(c) || 0) + 1);
  });
  //   ⚠ 阈值语义：DUPLICATE_CODE_ALLOWED 是「允许的**额外**出现次数」。
  //     取 0 表示「每个 code 只许出现 1 次」，故判据是「出现次数 − 1 > ALLOWED」，
  //     而不是「出现次数 > ALLOWED」——后者会把每个只出现一次的 code 也判成重复
  //     （初版即踩此坑，单测「hot 里 code 各不相同」当场抓到）。
  const dupCode = [...codeCount.entries()].filter(([, n]) => (n - 1) > R.DUPLICATE_CODE_ALLOWED);
  if (dupCode.length) {
    const names = dupCode.map(([c, n]) => `${c}×${n}`).join(', ');
    const extra = dupCode.reduce((a, [, n]) => a + (n - 1), 0);
    issues.push(issue('hot[].code', 'DUPLICATE', SEVERITY.ERROR,
      `强势股列表出现重复代码：${names}（多计 ${extra} 条，家数/题材计数虚高）`, extra, '唯一', dupCode[0][0]));
  }

  // ── ④ 一致性校验：涨跌家数 ───────────────────────────────────────────
  const up = num(s.up_count), down = num(s.down_count), flat = num(s.flat_count);
  if (up != null && down != null) {
    if (up < 0 || down < 0) {
      issues.push(issue('summary.up_count', 'RANGE_BREADTH', SEVERITY.ERROR,
        `涨跌家数出现负值（up=${up}, down=${down}）`, up, '>=0'));
    } else if (up + down < R.BREADTH_MIN_TOTAL) {
      issues.push(issue('summary.up_count', 'RANGE_BREADTH', SEVERITY.ERROR,
        `涨跌家数合计 ${up + down} 不足 ${R.BREADTH_MIN_TOTAL}（口径残缺，非全市场）`, up + down, `>=${R.BREADTH_MIN_TOTAL}`));
    }
  }
  // 涨停数不应大于上涨家数
  const zt = num(s.zt_count);
  if (R.ZT_LE_UP && zt != null && up != null && zt > up) {
    issues.push(issue('summary.zt_count', 'CONSIST_ZT', SEVERITY.ERROR,
      `涨停 ${zt} 大于上涨家数 ${up}（逻辑不可能）`, zt, `<=${up}`));
  }
  // 涨停 + 跌停不应超过全市场
  const dt = num(s.dt_count);
  if (zt != null && dt != null && up != null && down != null && (zt + dt) > (up + down)) {
    issues.push(issue('summary.zt_count', 'CONSIST_ZDT', SEVERITY.ERROR,
      `涨停+跌停 ${zt + dt} 大于涨跌家数合计 ${up + down}`, zt + dt, `<=${up + down}`));
  }
  // 封板率必须在 [0,100]
  const seal = num(s.seal_pct);
  if (seal != null && (seal < 0 || seal > 100)) {
    issues.push(issue('summary.seal_pct', 'RANGE_PCT', SEVERITY.ERROR,
      `封板率 ${seal}% 越界 [0,100]`, seal, '[0,100]'));
  }

  // ── ④ 一致性校验：席位覆盖率 ─────────────────────────────────────────
  const seats = s.seats;
  if (seats && typeof seats === 'object') {
    const cover = num(seats.cover);
    if (cover != null && (cover < 0 || cover > R.SEAT_COVER_MAX)) {
      issues.push(issue('summary.seats.cover', 'RANGE_PCT', SEVERITY.ERROR,
        `席位覆盖率 ${cover}% 越界 [0,100]`, cover, '[0,100]'));
    }
  }
  // 席位明细条数 vs 上榜个股数 —— ⚠ 必须用**同口径**分母（本规则初版踩坑，实测抓出）
  //
  // 事实（实测 2026-09-28/29/30）：
  //   lhb_daily_stocks = 48 / 56 / 56   ← 只含「当日榜」
  //   lhb_stocks       = 55 / 66 / 66   ← 含「当日榜 + 连续N日区间累计榜」
  //   seats.detail 键数 = 55 / 66 / 66   ← 与 lhb_stocks 完全一致（交集 55/55、66/66、66/66）
  // 即：席位明细覆盖的是**全量上榜个股**（含区间榜），不是仅当日榜。
  // 初版拿 detailN 与 lhb_daily_stocks 比，跨口径混比 → 三天全部误报（48<55、56<66）。
  // 修正：与 lhb_stocks（全量口径）比。这才是 like-for-like。
  //
  // 另注：detailN 允许**小于** lhb_stocks（席位明细抓取可能只覆盖部分个股），
  // 但**不应大于**（多于上榜个股数意味着出现了榜外的票 → 口径泄漏）。
  if (seats && seats.detail && typeof seats.detail === 'object') {
    const detailN = Object.keys(seats.detail).length;
    const allStocks = num(s.lhb_stocks);        // 全量口径（含区间榜）
    const dailyStocks = num(s.lhb_daily_stocks); // 当日榜口径（仅留痕参考）
    if (allStocks != null && allStocks > 0 && detailN > allStocks) {
      issues.push(issue('summary.seats.detail', 'CONSIST_SEATS', SEVERITY.WARN,
        `席位明细 ${detailN} 条多于全量上榜个股数 ${allStocks}（疑榜外票混入）`,
        detailN, `<=${allStocks}`));
    } else if (dailyStocks != null && allStocks == null && dailyStocks > 0 && detailN > dailyStocks) {
      // 缺 lhb_stocks 的老档：退化为与当日榜比，但**不作为判据**（跨口径，仅留痕）
      // 不产生 issue —— 宁可不判也不误报（本项目纪律）。
    }
  }

  // ── 外部注入的脏字段（#2 跨源互证复用此通道）────────────────────────
  //   #2 算出「东财 vs 同花顺 同一行业差太大」后，把该字段路径塞进 extraDirty，
  //   本层统一按 ERROR 处理并给出 source='cross-source' 的 issue —— 保持单一报告结构。
  const extra = Array.isArray(opts.extraDirty) ? opts.extraDirty : [];
  extra.forEach((e) => {
    const field = typeof e === 'string' ? e : e.field;
    if (!field) return;
    issues.push(issue(field, (e && e.rule) || 'CROSS_SOURCE', SEVERITY.ERROR,
      (e && e.reason) || `跨源互证不一致：${field}`, (e && e.value) ?? null, (e && e.expected) ?? null));
  });

  // ── 汇总 ──────────────────────────────────────────────────────────────
  const errFields = [...new Set(issues.filter((i) => i.severity === SEVERITY.ERROR).map((i) => i.field))];
  const warnFields = [...new Set(issues.filter((i) => i.severity === SEVERITY.WARN).map((i) => i.field))];
  const status = issues.some((i) => i.severity === SEVERITY.ERROR) ? 'dirty'
    : issues.length ? 'warn' : 'ok';

  return {
    date: day.trade_date || null,
    status,
    dirtyFields: errFields,
    warnFields,
    issues,
    // 已销案的复核项（真实行情、台账已核验）：不是"没发现"，是"已核验不再重复报"
    suppressedReviews: suppressed.map((s) => ({ date: day.trade_date || null, ...s })),
    checked: { days: 1, rules: Object.keys(VALIDATION_RULES).length },
  };
}

// ── 指数涨跌幅提取（供 divergence 判定；多个指数取绝对变动最大者）──────────
export function indexChangePct(day) {
  const idx = day && day.indexes;
  if (!idx) return null;
  const vals = [];
  if (Array.isArray(idx)) {
    idx.forEach((x) => { const v = num(x && (x.change_pct ?? x.pct)); if (v != null) vals.push(v); });
  } else if (typeof idx === 'object') {
    Object.values(idx).forEach((x) => {
      if (x == null) return;
      const v = num(typeof x === 'object' ? (x.change_pct ?? x.pct) : x);
      if (v != null) vals.push(v);
    });
  }
  if (!vals.length) return null;
  return vals.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), vals[0]);
}

// ── 把 dirtyFields 映射到「computeSentiment 的入参名」────────────────────
//   computeSentiment 收的是扁平入参（upCount/amount/...），而 dirtyFields 是
//   summary 的字段路径。这层映射是**唯一**的翻译点，管线照它把对应入参置 null。
//   返回 Set，便于管线 O(1) 查询。
export const FIELD_TO_FACTOR_ARG = {
  'summary.up_count': ['upCount'],
  'summary.down_count': ['downCount'],
  'summary.amount_yi': ['amount'],
  'summary.zt_count': ['limitUp'],
  'summary.dt_count': ['limitDown'],
  'summary.zb_count': ['brokenCount'],
  'summary.ind_up': ['industryUp'],
  'summary.ind_count': ['industryTotal'],
  'summary.lhb_daily_net': ['netBuy'],
  'summary.lhb_new_net': ['newStockNet'],
  'emotion.value': [],
  'emotion.factors.s_net': ['netBuy'],
  'industry[].change_pct': ['industryUp', 'industryTotal'],
  'hot[].code': [],
  'hot[].change_pct': [],
};

// 从校验结果导出「需要置 null 的 computeSentiment 入参名」
export function dirtyArgsOf(vres) {
  const out = new Set();
  (vres && vres.dirtyFields ? vres.dirtyFields : []).forEach((f) => {
    const args = FIELD_TO_FACTOR_ARG[f];
    if (args) args.forEach((a) => out.add(a));
    else if (f.startsWith('industry[].')) { out.add('industryUp'); out.add('industryTotal'); }
  });
  return out;
}

// ── 全档校验（批量）──────────────────────────────────────────────────────
export function validateAll(days, opts = {}) {
  const list = Array.isArray(days) ? days : [];
  const perDay = [];
  const dirtyDates = [];
  const fieldCounts = new Map();
  let ok = 0, warn = 0, dirty = 0;
  const extraMap = opts.extraDirtyByDate || null;
  const reviewed = opts.reviewedOutliers || null; // 销案台账（Set 或数组），逐日透传

  list.forEach((d) => {
    const extra = extraMap && d.trade_date ? extraMap[d.trade_date] : (opts.extraDirty || []);
    const r = validateDay(d, { extraDirty: extra, reviewedOutliers: reviewed });
    perDay.push(r);
    if (r.status === 'ok') ok++;
    else if (r.status === 'warn') warn++;
    else dirty++;
    if (r.status !== 'ok') dirtyDates.push(r.date);
    r.dirtyFields.forEach((f) => fieldCounts.set(f, (fieldCounts.get(f) || 0) + 1));
  });

  // 字段 → 受影响天数（报告"哪些字段最脏"，指导数据源治理）
  const byField = [...fieldCounts.entries()]
    .map(([field, daysN]) => ({ field, days: daysN, pct: list.length ? round2((daysN / list.length) * 100) : null }))
    .sort((a, b) => b.days - a.days);

  return {
    total: list.length,
    ok, warn, dirty,
    cleanRatio: list.length ? round2(((ok + warn) / list.length) * 100) : null,
    dirtyDates,
    byField,
    perDay,
    // 已销案的复核项总数（跨日汇总；明细在 perDay[].suppressedReviews）
    suppressed: perDay.reduce((a, r) => a + ((r.suppressedReviews && r.suppressedReviews.length) || 0), 0),
    // 汇总口径声明（报告引用，不得下游重写）
    scope: '单源内部校验：范围/单位/重复/逻辑一致性（不含跨源互证）；suppressed = 已跨源核验销案的重复告警',
  };
}

// ── 从校验结果生成给 factor 的「脏标记」注入 ──────────────────────────────
//   computeSentiment 不支持"这个值脏"，它只认 null。故此处把脏字段对应的**原始值**
//   替换为 null，返回一份可直接喂 computeSentiment 的入参对象。
//   ⚠ 不改动 day 本体（原值保留在档里，供追溯与人工复核）。
export function sanitizeForFactors(day, vres) {
  const args = dirtyArgsOf(vres);
  const s = (day && day.summary) || {};
  const raw = {
    netBuy: s.lhb_daily_net ?? null,
    newStockNet: s.lhb_new_net ?? 0,
    newStockRatio: s.lhb_new_ratio ?? null,
    upCount: s.up_count ?? null,
    downCount: s.down_count ?? null,
    posRatio: (s.net_pos != null && s.net_neg != null && (s.net_pos + s.net_neg) > 0)
      ? s.net_pos / (s.net_pos + s.net_neg) : null,
    industryUp: s.ind_up ?? null,
    industryTotal: s.ind_count ?? null,
    limitUp: s.zt_count ?? null,
    limitDown: s.dt_count ?? null,
    brokenCount: s.zb_count ?? null,
    amount: s.amount_yi ?? null,
  };
  const cleaned = { ...raw };
  const dropped = [];
  args.forEach((a) => { if (a in cleaned) { cleaned[a] = null; dropped.push(a); } });
  return { raw, cleaned, dropped };
}
