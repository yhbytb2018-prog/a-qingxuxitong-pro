// 板块相对强弱（industry_relative）—— 口径唯一出处。
//
// ── 为什么需要它 ──────────────────────────────────────────────────────────────
// emotion 是**绝对**情绪：全市场 90 个行业里有 53% 飘红就是"扩散良好"。
// 但同涨同跌的日子看不出板块之间谁强谁弱——普涨 2% 时，涨 2.1% 的行业是相对弱势，
// 涨 3% 的才是强势。避雷（超额防御）看的正是"谁比基准跌得少"。
//
// ── 为什么是双基准 ────────────────────────────────────────────────────────────
// 两个基准回答的是不同问题，缺一不可：
//
//   ① vs 上证指数（大盘超额）—— 回答"跑赢大盘了吗"
//      体感最贴近持仓账户（多数人对标的就是上证）。但结构性缺陷：
//      上证含大量银行/两油等低波权重股，在题材行情里它经常躺平，
//      于是**几乎所有题材行业都显示正超额**，进攻榜会挤满、防御榜会空掉。
//
//   ② vs 全行业涨幅中位数（板块内超额）—— 回答"在板块里排前还是排后"
//      中位数基准的均值恒等于 ≈0（只差在均值 vs 中位数），攻防榜天然均衡，
//      一定各有强弱。这才能回答"谁跌得比同伴少"。
//
//   实测 2026-09-30：上证 +0.31、行业中位数 +0.07，两基准仅差 0.24 点，
//   但当上证大幅波动（如 −2%）而行业普涨时，两榜会显著分化——这正是要并存的原因。
//   报告与前端必须**显式标注用的是哪个基准**，不得混用（同样的 4.63 在
//   vs 上证是 +4.32、vs 中位数是 +4.56，说成"超额 4.6"而不说基准就是假精确）。
//
// ── 为什么基准必须来自同日同源 ────────────────────────────────────────────────
// 上证涨跌幅取自 `day.indexes['上证指数']`，与行业涨幅同属"当日收盘"口径。
// 若拿昨收、拿隔夜、或用另一指数（沪深300），差值就掺入了口径差，
// 不再是纯粹的"板块 vs 大盘"。故本模块只接受**同一天对象**，不提供跨日入参。

// 保留两位小数（本项目各处均以此局部实现，util.js 未导出；与 sources.js 同式）
const r2 = (v) => Math.round(v * 100) / 100;

/** 相对强度的基准标识（唯一出处，UI/报告只许引用这里的字符串）。 */
export const REL_BASE = {
  INDEX: 'index',     // vs 上证指数（大盘超额）
  MEDIAN: 'median',   // vs 全行业涨幅中位数（板块内超额）
};

export const REL_BASE_LABEL = {
  [REL_BASE.INDEX]: '上证指数',
  [REL_BASE.MEDIAN]: '行业中位数',
};

/** 每个榜单展示的家数（前 N / 后 N）。 */
export const REL_TOP_N = 5;

/** 榜单类型标识。 */
export const REL_SIDE = {
  ATTACK: 'attack',   // 超额进攻：相对基准最强的 N 个行业
  DEFENSE: 'defense', // 超额防御：相对基准最弱的 N 个行业（跌得比基准多的那些）
};

export const REL_SIDE_LABEL = {
  [REL_SIDE.ATTACK]: '超额进攻',
  [REL_SIDE.DEFENSE]: '超额防御',
};

/**
 * 中位数（偶数个取中间两数均值）。
 * 不用均值：一个行业涨 15%（如某日中药板块异动）就能把均值拽偏，
 * 而"在板块里排第几"这件事应当由位次决定，不该被极值绑架。
 */
export function median(nums) {
  const a = (nums || []).filter((v) => Number.isFinite(v)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * 计算某一天的板块相对强弱。
 *
 * @param {object} day 档案中的单日对象（需含 industry[] 与 indexes['上证指数']）
 * @returns {object|null}
 *   null —— 该日**没有行业明细**（历史回填天常见，208/241 天如此）。
 *   调用方必须把 null 显示为「未计算」，**绝不能显示 0**：
 *   0 的语义是"与基准完全同步"，是个**确定的结论**；null 是"不知道"。
 *   二者含义相反，混同就是编造数据。
 */
export function computeRelative(day) {
  const ind = (day && day.industry) || [];
  // 至少要有一半的行业才算可信：残缺列表的中位数没有代表性，
  // 与其给一个可疑的榜，不如如实说"这天没有行业明细"。
  const valid = ind.filter((x) => x && Number.isFinite(x.change_pct));
  if (valid.length < 30) return null;

  const idxPct = day.indexes && Number.isFinite(day.indexes['上证指数'])
    ? day.indexes['上证指数'] : null;
  const medPct = median(valid.map((x) => x.change_pct));

  // 两种基准各自排序取前后 N。
  // 注意排序键是**超额**而非绝对涨幅：普跌日里"涨得最少"的才是最强，
  // 按绝对涨幅排会让普跌日的进攻榜全是负数、含义混乱。
  const build = (baseKey, baseVal) => {
    if (baseVal == null) return null;
    const rows = valid
      .map((x) => ({ name: x.name, change_pct: r2(x.change_pct), excess: r2(x.change_pct - baseVal) }))
      .sort((a, b) => b.excess - a.excess);
    return {
      base: baseKey,
      baseLabel: REL_BASE_LABEL[baseKey],
      basePct: r2(baseVal),
      attack: rows.slice(0, REL_TOP_N),
      defense: rows.slice(-REL_TOP_N).reverse(), // 最弱的排最前，便于"避雷"直接读
    };
  };

  const vsIndex = build(REL_BASE.INDEX, idxPct);
  const vsMedian = build(REL_BASE.MEDIAN, medPct);
  if (!vsIndex && !vsMedian) return null;

  const positives = valid.filter((x) => x.change_pct > 0).length;
  return {
    // 哪个基准是"主榜"：有上证就用上证（与用户体感/持仓对标一致），
    // 缺上证（源5 抓取失败）时降级用中位数，并在 degraded 里留痕——
    // 否则读者会以为"今天板块和大盘完全同步"（其实是没抓到大盘）。
    primary: vsIndex ? REL_BASE.INDEX : REL_BASE.MEDIAN,
    degraded: !vsIndex,
    degradedReason: vsIndex ? null : '上证指数缺失，主榜降级为行业中位数',
    vsIndex,
    vsMedian,
    // 板块扩散度：行业中位数本身（绝对口径），供与 emotion.ind_up 互证
    medianPct: medPct == null ? null : r2(medPct),
    upCount: positives,
    total: valid.length,
    topN: REL_TOP_N,
  };
}

/**
 * 取指定基准下的榜单（UI/报告统一入口，避免各处自己挑 vsIndex/vsMedian）。
 * @param {object|null} rel computeRelative 的返回值
 * @param {string} [base] REL_BASE.*，默认取 primary
 */
export function pickBoard(rel, base) {
  if (!rel) return null;
  const key = base || rel.primary;
  return key === REL_BASE.MEDIAN ? rel.vsMedian : rel.vsIndex;
}

/** 一行式摘要（供报告头部/日志使用，避免各处拼字符串导致口径措辞漂移）。 */
export function relativeLine(rel) {
  if (!rel) return '板块相对强弱：未计算（该日无行业明细）';
  const b = pickBoard(rel);
  if (!b) return '板块相对强弱：未计算（基准缺失）';
  const a = b.attack[0], d = b.defense[0];
  const head = `板块相对强弱（基准 ${b.baseLabel} ${b.basePct >= 0 ? '+' : ''}${b.basePct.toFixed(2)}%）：`;
  const at = a ? `${REL_SIDE_LABEL[REL_SIDE.ATTACK]} ${a.name} ${a.excess >= 0 ? '+' : ''}${a.excess.toFixed(2)}` : '—';
  const df = d ? `${REL_SIDE_LABEL[REL_SIDE.DEFENSE]} ${d.name} ${d.excess >= 0 ? '+' : ''}${d.excess.toFixed(2)}` : '—';
  return head + at + '；' + df + (rel.degraded ? `（⚠ ${rel.degradedReason}）` : '');
}
