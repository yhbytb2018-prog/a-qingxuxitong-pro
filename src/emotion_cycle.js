// 涨停池情绪周期判定（2026-10-08）：基于东财 getTopicZTPool 每日快照的六指标 + 六状态纯函数
//
// ── 规则唯一出处纪律 ──────────────────────────────────────────────────────────
// 输入 pool 为每日涨停池数组，元素字段（2026-10-08 接口实测口径）：
//   c 代码 / m 市场(0深1沪) / n 名称 / p 价格×1000 / zdp 涨跌幅 / amount 成交额 /
//   ltsz 流通市值 / tshare 总市值 / hs 换手率% / lbc 连板数 / fbt 首次封板时间 /
//   lbt 最后封板时间 / fund 封板资金 / zbc 炸板次数 / hybk 行业板块 / zttj {days,ct}
//
// ── 六指标口径 ──────────────────────────────────────────────────────────────
//   limit_up_count      涨停家数 = pool.length
//   continuous_count    连板家数 = lbc ≥ 2 的家数
//   broken_rate         炸板率 = zbc>0 家数 / pool.length（涨停池内「封后炸过又回封」占比，
//                       与报告线 zb_pct（收盘炸板/盘中触板）**口径不同，勿混用**）
//   max_board           最高板 = max(lbc)，pool 空时为 0
//   theme_concentration 主线集中度 = 众数 hybk 家数 / pool.length
//                       （hybk 缺失条目计入分母但不对任何板块计数；全缺失 → null）
//   theme_top           [附] 众数板块名（集中度的可解释性伴生字段）
//   hard_board_rate     封板强度 = zbc==0 家数 / pool.length（硬板占比，= 1 - broken_rate）
//
// ── 六状态规则与优先级（规则可重叠，防御性排序：极端风险 > 风险 > 强势 > 转强 > 兜底）──
//   ① 冰点：涨停 < 30 且 炸板率 > 40%
//   ② 退潮：炸板率 > 40% 且 最高板较前一日下降（需 prev）
//   ③ 高潮：涨停 > 100 且 封板强度 > 70%
//   ④ 主升：涨停 > 60 且 连板 > 15 且 主线集中度 > 0.3
//   ⑤ 复苏：涨停较前一日上升 且 炸板率较前一日下降（需 prev）
//   ⑥ 震荡：兜底
//   排序依据（重叠场景的拍板，均有数学互斥性验证）：
//   · 高潮 vs 退潮数值互斥（封板强度>70% ⇔ 炸板率<30%），先后无歧义
//   · 冰点 vs 复苏可同真（前日炸板更高、今日仍>40%）→ 冰点优先：弱到极致先定性
//   · 主升 vs 退潮可同真（涨停多但炸板也多）→ 退潮优先：风险信号优先
//   · 主升 vs 复苏可同真 → 主升优先：更强的状态先定性
//   · 环比规则（②⑤）在 prev 缺失或对应指标为 null 时不触发，自然落到其余规则
//
// ── score（0-100，设计值，非规格给定）────────────────────────────────────────
//   20×min(涨停/100,1) + 20×min(连板/20,1) + 20×(1-min(炸板率/0.5,1))
//   + 15×min(最高板/8,1) + 15×min(集中度/0.5,1) + 10×封板强度
//   缺失指标按中性 0.5 折算（近似轨无 hybk 时不奖不罚）。示例日（52/18/0.15/5/0.35/0.72）→ 69。
//   score 与 emotion 独立：score 是当日强度，emotion 是周期相位，弱相关而非绑定。
//
// 近似轨提示：scripts/emotion_history.mjs 在无完整 pool 的日期用 archive.json 汇总字段
// 近似（broken_rate ← zb/(zt+zb)、hard_board_rate ← zt/(zt+zb)、theme_concentration ← null），
// 该轨输出的主升永不触发（集中度缺失），且 broken_rate 口径偏小，仅供趋势参考。

export const EMOTION_RULES = {
  freeze: { limit_up_count_max: 30, broken_rate_min: 0.40 },
  ebb: { broken_rate_min: 0.40 },
  climax: { limit_up_count_min: 100, hard_board_rate_min: 0.70 },
  surge: { limit_up_count_min: 60, continuous_count_min: 15, theme_concentration_min: 0.30 },
};

const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);

/** 指标计算。pool 非数组或为空 → null（调用方据此标 no_data）。 */
export function computeEmotionMetrics(pool) {
  if (!Array.isArray(pool) || !pool.length) return null;
  const n = pool.length;
  let broken = 0, hard = 0, maxBoard = 0, continuous = 0;
  const hybkCount = new Map();
  for (const s of pool) {
    const lbc = Number.isFinite(+s?.lbc) ? Math.trunc(+s.lbc) : 1;
    if (lbc >= 2) continuous++;
    if (lbc > maxBoard) maxBoard = lbc;
    const zbc = Number.isFinite(+s?.zbc) ? Math.trunc(+s.zbc) : 0;
    if (zbc > 0) broken++; else hard++;
    const bk = typeof s?.hybk === 'string' && s.hybk.trim() ? s.hybk.trim() : null;
    if (bk) hybkCount.set(bk, (hybkCount.get(bk) || 0) + 1);
  }
  let themeTop = null, themeConc = null;
  for (const [k, c] of hybkCount) {
    if (!themeTop || c > hybkCount.get(themeTop)) { themeTop = k; themeConc = c / n; }
  }
  return {
    limit_up_count: n,
    continuous_count: continuous,
    broken_rate: r4(broken / n),
    max_board: maxBoard,
    theme_concentration: themeConc == null ? null : r4(themeConc),
    theme_top: themeTop,
    hard_board_rate: r4(hard / n),
  };
}

/**
 * 状态判定。m 为 computeEmotionMetrics 输出；prev 为前一交易日同结构指标（可选）。
 * 缺失指标一律判 false（保守），详见模块头「优先级」注释。
 */
export function classifyEmotion(m, prev = null) {
  if (!m) return 'no_data';
  const has = (v) => Number.isFinite(+v);
  const prevHas = (k) => !!(prev && prev[k] != null && Number.isFinite(+prev[k]));
  // ① 冰点
  if (m.limit_up_count < EMOTION_RULES.freeze.limit_up_count_max
    && has(m.broken_rate) && m.broken_rate > EMOTION_RULES.freeze.broken_rate_min) return '冰点';
  // ② 退潮
  if (has(m.broken_rate) && m.broken_rate > EMOTION_RULES.ebb.broken_rate_min
    && prevHas('max_board') && has(m.max_board) && m.max_board < prev.max_board) return '退潮';
  // ③ 高潮
  if (m.limit_up_count > EMOTION_RULES.climax.limit_up_count_min
    && has(m.hard_board_rate) && m.hard_board_rate > EMOTION_RULES.climax.hard_board_rate_min) return '高潮';
  // ④ 主升
  if (m.limit_up_count > EMOTION_RULES.surge.limit_up_count_min
    && m.continuous_count > EMOTION_RULES.surge.continuous_count_min
    && m.theme_concentration != null && m.theme_concentration > EMOTION_RULES.surge.theme_concentration_min) return '主升';
  // ⑤ 复苏
  if (prevHas('limit_up_count') && m.limit_up_count > prev.limit_up_count
    && prevHas('broken_rate') && has(m.broken_rate) && m.broken_rate < prev.broken_rate) return '复苏';
  // ⑥ 震荡
  return '震荡';
}

/** 强度分（0-100 整数）。缺失指标按中性 0.5 折算；空指标 → null。 */
export function computeEmotionScore(m) {
  if (!m) return null;
  const half = (v) => (v == null || !Number.isFinite(+v) ? 0.5 : Math.max(0, Math.min(1, +v)));
  const cap = (v, scale) => half(v == null ? null : v / scale);
  const score = 20 * cap(m.limit_up_count, 100)
    + 20 * cap(m.continuous_count, 20)
    + 20 * (1 - cap(m.broken_rate, 0.5))
    + 15 * cap(m.max_board, 8)
    + 15 * cap(m.theme_concentration, 0.5)
    + 10 * half(m.hard_board_rate);
  return Math.round(score);
}

/**
 * 情绪判定主入口（纯函数）。
 * @param {Array}    pool        当日涨停池数组（最新快照）
 * @param {Object|null} prevMetrics 前一交易日指标（computeEmotionMetrics 输出，可选）
 * @param {string|null} date     日期标签（YYYYMMDD，可选，仅透传）
 * @returns {{date, emotion, score, metrics}}
 *   pool 为空/非数组 → {date, emotion:'no_data', score:null, metrics:null}
 */
export function computeEmotion(pool, prevMetrics = null, date = null) {
  const metrics = computeEmotionMetrics(pool);
  if (!metrics) return { date: date ?? null, emotion: 'no_data', score: null, metrics: null };
  return {
    date: date ?? null,
    emotion: classifyEmotion(metrics, prevMetrics),
    score: computeEmotionScore(metrics),
    metrics,
  };
}
