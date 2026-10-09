// 主线识别（2026-10-08）：涨停池 hybk 聚类 + 主线判定/分级/持续性/轮动，纯函数模块。
//
// ── 口径（2026-10-08 拍板）────────────────────────────────────────────────────
// · 聚类按 hybk（东财行业板块）字面分组；hybk 缺失条目不参与聚类，但计入全市场
//   封板资金均值（它是市场整体的一部分）。
// · 主线三条件（全 AND）：板块涨停家数 ≥ min_zt_count(3) 且 连板家数(lbc≥2) ≥ 1
//   且 板块平均封板资金 > 全市场均值（严格 >；板块内全部缺 fund → avg_fund=null
//   → 条件不满足；当日全池无有效 fund → 无主线）。
// · 强度分级（按板块涨停家数）：3-5 弱主线 / 6-10 强主线 / ≥11 绝对主线。
// · 持续性（主线身份连续，2026-10-08 拍板）：昨日是主线且今日仍是主线才 +1，
//   断一天即清零重来；consecutive_days ≥ 3 → is_continuous=true。首日 = 1。
// · 轮动（掉出也算衰减，2026-10-08 拍板）：昨日任一主线的板块今日涨停家数
//   < 昨日 × rotation_drop_ratio(50%)（今日彻底消失按 0 计）→ 旧主线衰减；
//   且 今日主线中存在昨日非主线的板块 → 新主线出现。二者同时成立 → rotation=true。
//   环比恰等 50% 不算衰减（严格 <）。
// · prev_main_theme：昨日主线中涨停家数最大者（并列取字典序最小）；昨日无主线 → null。
//
// ── 已知局限（如实披露）───────────────────────────────────────────────────────
// · hybk 是行业口径，同一概念炒作会散在多个板块（如固态电池散在电池/消费电子/化工），
//   本模块会**低估概念级集中度**；概念合并需外部映射表，另行扩展，不混入本模块。
// · 阈值常量化于 MAIN_THEME_RULES（未进 config.json）：ztpool_history 积累满月后
//   按实际分布复核 3/6/10 与 50% 衰减线再定是否固化。
//
// ── 回放约定 ─────────────────────────────────────────────────────────────────
// computeMainTheme(pool, prevState, date) 的 prevState 为**截至昨日**的 state
// （本模块 computeMainTheme 上一日返回值），逐日回放无未来泄漏。

/** 主线规则常量（防误改锚点；阈值复核后可迁 config.json） */
export const MAIN_THEME_RULES = {
  min_zt_count: 3,        // 主线门槛：板块涨停家数 ≥3
  min_lb_count: 1,        // 主线门槛：板块连板家数 ≥1
  weak_max: 5,            // 弱主线上界（含）
  strong_max: 10,         // 强主线上界（含）；≥ strong_max+1 为绝对主线
  continuous_min_days: 3, // 持续主线门槛：连续 ≥3 天
  rotation_drop_ratio: 0.5, // 旧主线衰减线：今日 < 昨日 × 50%
};

const intOr = (v, dft) => (Number.isFinite(+v) ? Math.trunc(+v) : dft);
// fund 有效性：null 经 +null 会变 0（被当「0 元封板资金」拉低均值），必须先挡 null
const validFund = (v) => (v != null && Number.isFinite(+v) ? +v : null);

/** 按 hybk 聚类（纯函数）。返回按 zt_count 降序（并列 name 升序）的板块统计。 */
export function clusterThemes(pool) {
  if (!Array.isArray(pool)) return [];
  const groups = new Map();
  for (const s of pool) {
    if (!s) continue;
    const bk = typeof s.hybk === 'string' ? s.hybk.trim() : '';
    if (!bk) continue; // 无板块归属不聚类（计入全市场均值由 identifyMainThemes 负责）
    const code = s.c != null ? String(s.c) : null;
    let g = groups.get(bk);
    if (!g) { g = { name: bk, zt_count: 0, lb_count: 0, fundSum: 0, fundCnt: 0, stocks: [] }; groups.set(bk, g); }
    g.zt_count++;
    if (intOr(s.lbc, 1) >= 2) g.lb_count++;
    const f = validFund(s.fund);
    if (f != null) { g.fundSum += f; g.fundCnt++; }
    if (code) g.stocks.push(code);
  }
  return [...groups.values()]
    .map((g) => ({
      name: g.name,
      zt_count: g.zt_count,
      lb_count: g.lb_count,
      avg_fund: g.fundCnt ? Math.round(g.fundSum / g.fundCnt) : null,
      stocks: g.stocks,
    }))
    .sort((a, b) => b.zt_count - a.zt_count || (a.name < b.name ? -1 : 1));
}

/** 强度分级（按板块涨停家数；主线门槛已保证 ≥3）。 */
export function classifyThemeStrength(ztCount) {
  const n = +ztCount;
  if (!Number.isFinite(n)) return null;
  if (n <= MAIN_THEME_RULES.weak_max) return '弱主线';
  if (n <= MAIN_THEME_RULES.strong_max) return '强主线';
  return '绝对主线';
}

/**
 * 当日主线识别（纯函数，不含持续性/轮动——那需要跨日状态）。
 * @returns {[{name, zt_count, lb_count, avg_fund, strength, stocks}]} 按 zt_count 降序
 */
export function identifyMainThemes(pool) {
  const clusters = clusterThemes(pool);
  if (!clusters.length) return [];
  // 全市场平均封板资金：当日池全部条目（含 hybk 缺失票），只计有效 fund
  let sum = 0, cnt = 0;
  for (const s of pool || []) {
    const f = s ? validFund(s.fund) : null;
    if (f != null) { sum += f; cnt++; }
  }
  if (!cnt) return []; // 全池无有效 fund → 条件③不可判 → 无主线
  const marketAvg = sum / cnt;
  return clusters.filter((g) =>
    g.zt_count >= MAIN_THEME_RULES.min_zt_count
    && g.lb_count >= MAIN_THEME_RULES.min_lb_count
    && g.avg_fund != null && g.avg_fund > marketAvg)
    .map((g) => ({ ...g, strength: classifyThemeStrength(g.zt_count) }));
}

/**
 * 轮动检测（纯函数）。
 * @param {Array} todayClusters clusterThemes 输出（查旧主线今日涨停家数；彻底消失按 0）
 * @param {Array} todayMainThemes identifyMainThemes 输出（新主线=今日主线中昨日非主线者）
 * @param {Array} prevMainThemes 昨日主线列表
 * @returns {{rotation: boolean, faded: string[], emerging: string[]}}
 *   faded=衰减旧主线名列表，emerging=新晋主线名列表（rotation = 两者都非空）
 */
export function detectRotation(todayClusters, todayMainThemes, prevMainThemes) {
  const todayCount = new Map((todayClusters || []).map((g) => [g.name, g.zt_count]));
  const faded = [];
  for (const t of prevMainThemes || []) {
    if (!t) continue;
    const today = todayCount.get(t.name) ?? 0; // 彻底消失按 0（掉出也算衰减口径）
    if (today < t.zt_count * MAIN_THEME_RULES.rotation_drop_ratio) faded.push(t.name);
  }
  const prevNames = new Set((prevMainThemes || []).map((t) => t && t.name).filter(Boolean));
  const emerging = (todayMainThemes || [])
    .filter((t) => t && t.name && !prevNames.has(t.name))
    .map((t) => t.name);
  return { rotation: faded.length > 0 && emerging.length > 0, faded, emerging };
}

/**
 * 主线识别主入口（纯函数，含持续性追踪与轮动检测）。
 * @param {Array}  pool      当日涨停池
 * @param {Object|null} prevState 截至昨日状态（本函数上一日返回的 state；首日传 null）
 * @param {string|null} date  日期标签（YYYYMMDD，透传）
 * @returns {{result: {date, main_themes, rotation, prev_main_theme}, state}}
 *   result.main_themes 含 consecutive_days/is_continuous；
 *   state = { themeDays, mainThemes, mainTheme } 供次日传入。
 */
export function computeMainTheme(pool, prevState = null, date = null) {
  const themes = identifyMainThemes(pool);
  const clusters = clusterThemes(pool);
  const prevDays = prevState && typeof prevState === 'object' ? (prevState.themeDays || {}) : {};
  const prevMainThemes = Array.isArray(prevState?.mainThemes) ? prevState.mainThemes : [];
  const prevMainTheme = prevState?.mainTheme ?? null;

  // 持续性：主线身份连续（断即清零）；今日主线 → 昨日值+1 或 1
  const themeDays = {};
  const mainThemes = themes.map((t) => {
    const days = (prevDays[t.name] || 0) + 1;
    themeDays[t.name] = days;
    return { ...t, consecutive_days: days, is_continuous: days >= MAIN_THEME_RULES.continuous_min_days };
  });

  // 轮动（新主线 = 今日主线中昨日非主线者；faded = 昨日主线今日涨停家数 < 昨日×50%）
  const rot = detectRotation(clusters, mainThemes, prevMainThemes);
  const rotation = rot.rotation;

  // 今日首要主线（明日 prev_main_theme；并列取 zt_count 最大、再并列字典序最小）
  let mainTheme = null;
  for (const t of mainThemes) {
    if (!mainTheme || t.zt_count > mainTheme.zt_count
      || (t.zt_count === mainTheme.zt_count && t.name < mainTheme.name)) mainTheme = t;
  }

  return {
    result: {
      date: date ?? null,
      main_themes: mainThemes,
      rotation,
      prev_main_theme: prevMainTheme,
    },
    state: { themeDays, mainThemes, mainTheme: mainTheme ? mainTheme.name : null },
  };
}
