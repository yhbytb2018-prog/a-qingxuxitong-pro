// 老龙头识别（2026-10-08）：涨停池「首板反抽老龙头」纯函数模块。
//
// ── 口径 ─────────────────────────────────────────────────────────────────────
// · 老龙头：历史上曾达到 ≥5 连板（dragon_pool 记录）的票。
// · 候选五条件（全部满足，缺一即排除）：
//   ① code 在 dragon_pool 中（历史有过 ≥5 板）
//   ② 距上次出现在涨停池 ≥ MIN_ABSENCE_DAYS(10) 个交易日（absenceDays 由调用方
//     按交易日索引差维护；无记录=数据不足 → 保守排除，不猜）
//   ③ 今日涨停且 lbc == 1（首板反抽；lbc 缺省按 1）
//   ④ zbc == 0（硬板未炸；zbc 缺省按 0）
//   ⑤ fund > 当日涨停池平均封板资金（严格大于；均值只计有效 fund 条目，
//     缺 fund 的条目不参与均值且自身被排除；当日无任何有效 fund → 无候选）
// · days_since_peak 输出的是「距最后一次出现在涨停池的交易日数」（= 传入 absenceDays），
//   字段名保留规格原文；dragon_pool.peak_date 仅作龙头身份与首次波峰锚点。
// · deriveDragonPool：从 ztpool_history 派生龙头池——peak_date = 首次 lbc≥5 的日期，
//   peak_height = 该波（首次达标日起连续在池期间）的最大 lbc；离场后第二波不覆盖
//   第一波（「首次」语义）。截断传入 history 即得「截至某日」的无未来泄漏快照。
//
// ── 数据源现状（如实披露）──────────────────────────────────────────────────────
// · 项目暂无独立 dragon_pool.json；scripts/scan_old_dragon.mjs 优先读外部文件
//   （若用户提供，peak_date ≤ 当日的记录参与判定），否则从 ztpool_history.json 派生。
// · ztpool_history 自 2026-09-30 起积累（接口历史不可回补，2026-10-08 实测），
//   派生龙头池随每日 --fetch-latest 增长，老龙头候选自此逐日可识别。

/** 候选门槛常量（防误改锚点） */
export const OLD_DRAGON_RULES = {
  dragon_min_lbc: 5,        // 入龙头池门槛：连板 ≥5
  min_absence_days: 10,     // 冷却期：距最后出现 ≥10 交易日
  today_lbc: 1,             // 首板反抽
  hard_zbc: 0,              // 硬板：未炸
};

const intOr = (v, dft) => (Number.isFinite(+v) ? Math.trunc(+v) : dft);
// fund 有效性：+null 会变 0（被当「0 元封板资金」拉低均值），必须先挡 null
const validFund = (v) => (v != null && Number.isFinite(+v) ? +v : null);

/**
 * 识别当日老龙头候选（纯函数）。
 * @param {Array}    pool        当日涨停池（getTopicZTPool 快照）
 * @param {Array}    dragonPool  历史龙头池 [{code, name, peak_date, peak_height}]
 * @param {Object}   absenceDays {code: 交易日数}——今日与该 code 最后一次出现在
 *                              涨停池的索引差（截至前一交易日）；无记录则该 code 不满足条件②
 * @param {string|null} date    日期标签（YYYYMMDD，透传）
 * @returns {{date, old_dragons: Array}}
 *   空池 / 龙头池空 / 无有效 fund → {date, old_dragons: []}
 */
export function identifyOldDragons(pool, dragonPool, absenceDays = {}, date = null) {
  const out = { date: date ?? null, old_dragons: [] };
  if (!Array.isArray(pool) || !pool.length || !Array.isArray(dragonPool) || !dragonPool.length) return out;
  const dragonByCode = new Map();
  for (const d of dragonPool) {
    if (d && d.code != null && !dragonByCode.has(String(d.code))) dragonByCode.set(String(d.code), d);
  }
  if (!dragonByCode.size) return out;

  // 当日平均封板资金（只计有效 fund）
  let fundSum = 0, fundCnt = 0;
  for (const s of pool) {
    const f = s ? validFund(s.fund) : null;
    if (f != null) { fundSum += f; fundCnt++; }
  }
  if (!fundCnt) return out; // 无任何有效封板资金 → 条件⑤不可判，无候选
  const avgFund = fundSum / fundCnt;

  for (const s of pool) {
    if (!s || s.c == null) continue;
    const code = String(s.c);
    const dragon = dragonByCode.get(code);
    if (!dragon) continue;                                          // ① 历史非龙头
    const lbc = intOr(s.lbc, 1);
    if (lbc !== OLD_DRAGON_RULES.today_lbc) continue;               // ③ 非首板
    const zbc = intOr(s.zbc, 0);
    if (zbc !== OLD_DRAGON_RULES.hard_zbc) continue;                // ④ 炸过板
    const fund = validFund(s.fund);
    if (fund == null || !(fund > avgFund)) continue;      // ⑤ 封板资金不过均值（严格>）
    const absence = absenceDays[code];
    if (!Number.isFinite(+absence) || +absence < OLD_DRAGON_RULES.min_absence_days) continue; // ② 冷却不足/无记录
    out.old_dragons.push({
      code,
      name: s.n ?? dragon.name ?? null,
      first_wave_height: Number.isFinite(+dragon.peak_height) ? +dragon.peak_height : null,
      days_since_peak: Math.trunc(+absence),
      today_board: lbc,
      fund,
      hard_board: true,                                             // ④ 已过滤，恒真（保规格字段）
    });
  }
  return out;
}

/**
 * 从涨停池历史派生龙头池（纯函数）。
 * @param {Array} history [{date:'YYYYMMDD', pool:[...]}]（按日期升序；截断即得无未来泄漏快照）
 * @returns {[{code, name, peak_date, peak_height}]}
 *   peak_date = 首次 lbc≥5 的日期；peak_height = 该波（连续在池期间）最大 lbc。
 */
export function deriveDragonPool(history) {
  if (!Array.isArray(history)) return [];
  const dragons = new Map();   // code -> {code, name, peak_date, peak_height}
  const inWave = new Set();    // 当前仍在第一波中的 code（离场即封波，后续波不再更新）
  for (const day of history) {
    if (!day || !Array.isArray(day.pool)) continue;
    const seen = new Set(day.pool.map((s) => (s && s.c != null ? String(s.c) : null)).filter(Boolean));
    for (const s of day.pool) {
      if (!s || s.c == null) continue;
      const code = String(s.c);
      const lbc = intOr(s.lbc, 1);
      if (!dragons.has(code)) {
        if (lbc >= OLD_DRAGON_RULES.dragon_min_lbc) {
          dragons.set(code, { code, name: s.n ?? null, peak_date: String(day.date), peak_height: lbc });
          inWave.add(code);
        }
        continue; // 未达门槛的票不建记录（lbc 1-4 属未入池状态）
      }
      if (inWave.has(code)) {
        const d = dragons.get(code);
        if (lbc > d.peak_height) d.peak_height = lbc; // 波内刷新高度
      }
    }
    // 离场封波：昨日 inWave 但今日不在池 → 第一波结束
    for (const code of [...inWave]) {
      if (!seen.has(code)) inWave.delete(code);
    }
  }
  return [...dragons.values()];
}
