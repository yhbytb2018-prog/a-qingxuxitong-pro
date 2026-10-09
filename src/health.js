// ── 数据健康面板（唯一出处）────────────────────────────────────────────────────
//
// 为什么需要这个模块：
//   项目已有两个"状态"模块，但都不回答"数据本身健康吗"：
//     · src/freshness.js —— 数据**新不新**（存档是不是最新已收盘会话）；只看时点
//     · src/alerts.js    —— 交易**该不该动**（档位 vs 仓位的动作映射）；只看账户与市场
//   缺的是第三个维度：数据**本身**能不能用。实测踩过的坑全属于这一类：
//     · up_count/down_count 只有 3/241 天有 → s_pos 长期走代理，但页面从不提及；
//     · industry/indexes 只有 33/241 天 → 相对强弱 208 天是"未计算"，用户会以为是 0；
//     · imputedRatio 高时情绪分可信度下降，但分数照样显示，看不出"这天是猜的"。
//   这些都不会报错、不会失败，只会让结论悄悄变弱。故必须有地方把它们摆出来。
//
// 三条纪律：
//   1. **只读不造**：本模块不重算任何指标，只对既有字段做统计与阈值判定。
//   2. **缺失显式化**：统计不到的维度返回 null（"未知"），不得填 0——0 与"没有"
//      在健康语境下含义相反（0 = 检查过且没问题；null = 没检查）。
//   3. **阈值集中在此**：UI 不得自行写 `> 0.34` 这类判断，否则改阈值要改多处。
//
// ⚠ 本模块是**纯函数**：入参是已解码的天数组，不读盘、不依赖 config 的运行期状态
//   （阈值通过 opts 注入，默认值取自 config 的同名项）。便于单测与前端复用。

// 健康等级：由差到好排序，aggregate 取最差项作为整档结论。
export const HEALTH_LEVEL = {
  fail: 'fail',   // 数据不可用于决策（如缺关键字段导致主结论不可算）
  warn: 'warn',   // 可用但可信度下降（如补位率过高、字段覆盖不足）
  ok: 'ok',       // 正常
  unknown: 'unknown', // 无法判定（数据不足，且不是"没问题"）
};

const LEVEL_RANK = { fail: 3, warn: 2, unknown: 1, ok: 0 };
const LEVEL_LABEL = { fail: '异常', warn: '注意', ok: '正常', unknown: '未知' };

// ── 阈值（唯一出处）─────────────────────────────────────────────────────────
//
// 每一项都给出"为什么是这个数"，避免将来被随手改动：
//   imputedWarn      单日补位因子占比告警线。7 因子里补位 ≥3 个（≈43%）时，
//                    情绪分实际有近半权重是中性 50 —— 分数仍在动，但动的是剩下的因子。
//                    取 0.34（≈2.4/7）为 warning 入口，与 config.healthWarnImputedRatio 同源。
//   imputedFail      补位 ≥5/7（≈0.71）→ 分数已基本由中性值主导，不具备解读价值。
//   fieldWarnRatio   关键字段的历史覆盖率告警线。低于 50% 意味着"多数历史天算不出来"，
//                    页面上的历史对比（分位、走势）会失真。
export const HEALTH_THRESHOLDS = {
  imputedWarn: 0.34,
  imputedFail: 0.71,
  fieldWarnRatio: 0.5,
  // 近 N 日窗口：健康面板看的是"最近这段能不能用"，不是全历史。
  // 取 20 个交易日≈一个月，够覆盖一个情绪周期，又不会被半年前的数据拖住。
  recentWindow: 20,
};

/**
 * 关键字段清单（唯一出处）。每项说明它"缺失会让什么功能退化"——
 * 这是给读者看的，不是给机器用的，故写进输出里。
 */
export const KEY_FIELDS = [
  { key: 'ind_up', label: '行业涨跌家数', affects: '板块宽度因子 s_brd、板块相对强弱' },
  { key: 'up_count', label: '全市场涨跌家数', affects: '涨跌家数因子 s_pos（缺失时走龙虎榜正负比代理）' },
  { key: 'amount_yi', label: '两市成交额', affects: '量能因子 s_amt（缺失时该因子为中性 50）' },
  { key: 'zt_count', label: '涨停家数', affects: '涨停强度 s_hot、涨跌停对比 s_zdt' },
  { key: 'zb_count', label: '炸板家数', affects: '封板质量 s_zbl' },
  { key: 'lhb_daily_net', label: '当日榜净买', affects: '核心资金因子 s_net' },
];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r = (v, d = 3) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

/**
 * 数据新鲜度评估（薄封装，不重写 freshness 的口径）。
 * @param {object} meta 存档 meta
 * @param {object} [opts] { assessFn, now, holidays } —— 注入以便单测与前端复用
 */
export function checkFreshness(meta = {}, opts = {}) {
  const fn = typeof opts.assessFn === 'function' ? opts.assessFn : null;
  if (!fn) {
    // 未注入 assessFreshness 时**返回 unknown 而非伪造状态**。
    // 佯装"正常"比说"不知道"危险得多：后者会让人去查，前者不会。
    return {
      item: 'freshness', label: '数据新鲜度', level: HEALTH_LEVEL.unknown,
      detail: '未注入新鲜度评估函数（通常因为运行环境没有日历）',
      state: null, stale: null, behindSessions: null,
    };
  }
  const f = fn(meta, opts.now, opts.holidays) || {};
  const level = f.state === 'behind' ? HEALTH_LEVEL.fail
    : f.state === 'pending' ? HEALTH_LEVEL.warn
      : f.state === 'fresh' ? HEALTH_LEVEL.ok : HEALTH_LEVEL.unknown;
  return {
    item: 'freshness', label: '数据新鲜度', level,
    detail: f.state === 'fresh' ? `存档已是最近已收盘会话（${f.tradeDate || '—'}）`
      : f.state === 'pending' ? `落后 ${f.behindSessions ?? '—'} 个交易日，尚未到预期更新时刻（正常等待）`
        : f.state === 'behind' ? `落后 ${f.behindSessions ?? '—'} 个交易日，已过预期更新时刻`
          : '新鲜度未知',
    state: f.state ?? null,
    stale: f.stale ?? null,
    behindSessions: num(f.behindSessions),
    publishDeadline: f.publishDeadline ?? null,
  };
}

/**
 * 因子补位率：看**近窗口**每日的 imputedRatio，取最差一天与均值。
 *
 * 为什么取"最差一天"而不是均值：补位是**逐日**的性质，一天烂不影响其他天。
 *   若只报均值，33 天里 1 天全缺（ratio=1.0）会被平均成 0.03 而被当成正常，
 *   但那天页面上的分数就是虚构的——必须单独暴露。
 */
export function checkImputed(days, opts = {}) {
  const win = opts.recentWindow || HEALTH_THRESHOLDS.recentWindow;
  const list = Array.isArray(days) ? days.slice(-win) : [];
  const vals = [];
  let worst = null; // { date, ratio, missing }
  for (const d of list) {
    const e = d?.emotion || {};
    const ratio = num(e.imputedRatio);
    if (ratio == null) continue;
    vals.push(ratio);
    if (!worst || ratio > worst.ratio) {
      worst = { date: d.trade_date, ratio, missing: Array.isArray(e.missing) ? e.missing.length : null };
    }
  }
  if (!vals.length) {
    return {
      item: 'imputed', label: '因子补位率', level: HEALTH_LEVEL.unknown,
      detail: `近 ${win} 日没有任何一天的补位率记录`, worstDay: null, meanRatio: null, sampled: 0, window: win,
    };
  }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const t = opts.thresholds || HEALTH_THRESHOLDS;
  // 判级看最差一天（见上），但 detail 把均值也给出，两者一起看才知道是"偶发"还是"持续"
  const level = worst.ratio >= t.imputedFail ? HEALTH_LEVEL.fail
    : worst.ratio >= t.imputedWarn ? HEALTH_LEVEL.warn : HEALTH_LEVEL.ok;
  const worstMissing = worst.missing != null ? `（缺 ${worst.missing}/7 因子）` : '';
  return {
    item: 'imputed', label: '因子补位率', level,
    detail: level === HEALTH_LEVEL.ok
      ? `近 ${win} 日最差 ${(worst.ratio * 100).toFixed(0)}%（${worst.date}），均值 ${(mean * 100).toFixed(0)}%`
      : `近 ${win} 日最差 ${(worst.ratio * 100).toFixed(0)}%${worstMissing}（${worst.date}），均值 ${(mean * 100).toFixed(0)}%——该日情绪分有较高比例来自中性补位`,
    worstDay: worst,
    meanRatio: r(mean, 3),
    sampled: vals.length,
    window: win,
  };
}

/**
 * 字段可用率：关键字段在**全档**与**近窗口**两个尺度上的覆盖率。
 *
 * 为什么要两个尺度：全档覆盖率回答"这个字段历史上有没有被采集"（3/241 说明采集起步晚），
 *   近窗口覆盖率回答"现在能不能用"。只看全档会让人以为"现在也不好"，
 *   只看近期又不知道历史缺口有多大（影响分位与走势）。
 */
export function checkFields(days, opts = {}) {
  const all = Array.isArray(days) ? days : [];
  const win = opts.recentWindow || HEALTH_THRESHOLDS.recentWindow;
  const recent = all.slice(-win);
  const t = opts.thresholds || HEALTH_THRESHOLDS;
  const rows = [];
  for (const f of KEY_FIELDS) {
    const has = (d) => (d?.summary ? num(d.summary[f.key]) != null : false);
    const nAll = all.filter(has).length;
    const nRecent = recent.filter(has).length;
    const ratioAll = all.length ? nAll / all.length : null;
    const ratioRecent = recent.length ? nRecent / recent.length : null;
    // 判级：**只看近窗口**——历史缺口是既成事实（改不了），近期缺口才是"现在要不要担心"
    const level = ratioRecent == null ? HEALTH_LEVEL.unknown
      : ratioRecent < t.fieldWarnRatio ? HEALTH_LEVEL.warn : HEALTH_LEVEL.ok;
    rows.push({
      key: f.key, label: f.label, affects: f.affects,
      hasAll: nAll, totalAll: all.length, ratioAll: r(ratioAll, 3),
      hasRecent: nRecent, totalRecent: recent.length, ratioRecent: r(ratioRecent, 3),
      level,
    });
  }
  const bad = rows.filter((x) => x.level === HEALTH_LEVEL.warn);
  const level = rows.some((x) => x.level === HEALTH_LEVEL.unknown && rows.every((y) => y.level === HEALTH_LEVEL.unknown))
    ? HEALTH_LEVEL.unknown
    : bad.length ? HEALTH_LEVEL.warn : HEALTH_LEVEL.ok;
  return {
    item: 'fields', label: '关键字段可用率', level,
    detail: bad.length
      ? `${bad.length}/${rows.length} 个关键字段近 ${win} 日覆盖不足 ${((t.fieldWarnRatio) * 100).toFixed(0)}%：${bad.map((x) => x.label).join('、')}`
      : `${rows.length} 个关键字段近 ${win} 日覆盖充足`,
    rows,
    window: win,
  };
}

/**
 * 汇总为一份健康报告。
 *
 * @param {object[]} days 已解码的天数组（全档）
 * @param {object} opts
 *   @param {object} [opts.meta]            存档 meta（新鲜度用）
 *   @param {Function} [opts.assessFn]      freshness.assessFreshness（注入，便于复用与单测）
 *   @param {Date} [opts.now]               当前时刻（判新鲜度）
 *   @param {string[]} [opts.holidays]      节假日（判新鲜度）
 *   @param {object} [opts.thresholds]      覆盖默认阈值
 *   @param {number} [opts.recentWindow]    近窗口长度
 *   @returns {{level:string,label:string,items:object[],summary:string,note:string}}
 */
export function healthReport(days, opts = {}) {
  const list = Array.isArray(days) ? days.filter((d) => d && d.trade_date) : [];
  const items = [
    checkFreshness(opts.meta || {}, opts),
    checkImputed(list, opts),
    checkFields(list, opts),
  ];
  // 整档结论取**最差**项：健康报告的价值在于"哪里有问题"，
  // 用均值会把一个问题项稀释掉，那正是这份报告要避免的。
  let level = HEALTH_LEVEL.ok;
  for (const it of items) {
    if (LEVEL_RANK[it.level] > LEVEL_RANK[level]) level = it.level;
  }
  // 全是 unknown 时，整档也应是 unknown 而非 ok——"查不出来"不等于"没问题"
  if (items.every((it) => it.level === HEALTH_LEVEL.unknown)) level = HEALTH_LEVEL.unknown;
  const bad = items.filter((it) => it.level === HEALTH_LEVEL.fail || it.level === HEALTH_LEVEL.warn);
  const summary = level === HEALTH_LEVEL.ok
    ? `近 ${opts.recentWindow || HEALTH_THRESHOLDS.recentWindow} 日数据健康：${items.map((x) => LEVEL_LABEL[x.level]).join(' / ')}`
    : level === HEALTH_LEVEL.unknown
      ? '数据健康：无法判定（缺少评估所需输入），不等于正常'
      : `数据健康：${LEVEL_LABEL[level]}——${bad.map((x) => x.label).join('、')}需关注`;
  return {
    level,
    label: LEVEL_LABEL[level],
    items,
    summary,
    // 口径说明（随数据一起下发，避免前端各自措辞）
    note: '健康面板只看「数据能不能用」，不看「行情好不好」：新鲜度＝存档是否最新收盘会话；补位率＝情绪分里由中性值顶替的因子占比；字段可用率＝关键原始量的覆盖度。三者均不参与打分。缺失一律显示「未知」而非 0。',
    thresholds: opts.thresholds || HEALTH_THRESHOLDS,
  };
}
