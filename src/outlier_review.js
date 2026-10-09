// 行业离群「复核台账」纯函数层（销案机制）——与 src/dirty.js 同纪律：零 fs、零业务依赖，
// 可被管线（Node）、审计脚本、前端（只读展示）共用。
//
// ── 为什么需要「销案」──────────────────────────────────────────────────────
// OUTLIER_INDUSTRY（src/dirty.js）是 **WARN**：只标记、不剔除、不污染情绪分——因为
// 「数值孤立」与「主题集中」在数值形态上无法可靠区分（详见 dirty.js 内规则演进注释）。
// 代价：真实行情的离群会**每天重复报**，复核疲劳后就会被人忽略，等于没有防线。
//
// 销案机制：把「已跨源核验为真实」的 (日期, 行业) 记入 data/industry_outlier_review.json，
// 扫描时命中即**不再重复报 warn**，转为可审计的 suppressed 记录（诚实披露：不是"没发现"，
// 是"已核验销案"）。销案只影响是否重复报警，**不动任何数值、不改 dirty/干净判定**。
//
// ── 纪律 ────────────────────────────────────────────────────────────────────
//   · 台账条目必须带**证据**（复核方式 + 复算值 + 来源），无证据不得销案——否则销案
//     就成了「不想看的警告就关掉」的后门，比不报更危险；
//   · verdict 只认两个值：confirmed-real（销案）/ data-error（报警，须修数据源）；
//   · 台账结构由 validateLedger 守卫，测试锁定（结构坏了必须红，不许静默失效）。

export const VERDICTS = {
  REAL: 'confirmed-real',   // 真实行情 → 销案
  ERROR: 'data-error',      // 采集异常 → 报警，须修数据源
};

/** 台账主键：(日期, 行业名)。两处（写入方/消费方）必须用同一实现，否则销案静默失效。 */
export function reviewKey(date, industry) {
  return `${String(date == null ? '' : date).trim()}|${String(industry == null ? '' : industry).trim()}`;
}

/** 台账结构守卫：返回 { ok, errors[] }。用于测试与核验脚本自检（结构坏 → 拒绝使用）。 */
export function validateLedger(ledger) {
  const errors = [];
  if (!ledger || typeof ledger !== 'object') return { ok: false, errors: ['台账不是对象'] };
  if (ledger.kind !== 'industry-outlier-review') errors.push(`kind 非法: ${ledger.kind}`);
  if (!Array.isArray(ledger.entries)) {
    errors.push('entries 必须为数组');
    return { ok: false, errors };
  }
  const seen = new Set();
  ledger.entries.forEach((e, i) => {
    const tag = `entries[${i}]`;
    if (!e || typeof e !== 'object') { errors.push(`${tag} 不是对象`); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) errors.push(`${tag}.date 非法: ${e.date}`);
    if (!e.industry || typeof e.industry !== 'string') errors.push(`${tag}.industry 缺失`);
    if (![VERDICTS.REAL, VERDICTS.ERROR].includes(e.verdict)) errors.push(`${tag}.verdict 非法: ${e.verdict}`);
    // 证据纪律：销案（confirmed-real）必须有复核方式与证据对象——无证据不得销案
    if (e.verdict === VERDICTS.REAL) {
      if (!e.method) errors.push(`${tag} 销案缺 method（复核方式）`);
      if (!e.evidence || typeof e.evidence !== 'object') errors.push(`${tag} 销案缺 evidence（证据）`);
      else if (!e.evidence.source) errors.push(`${tag}.evidence.source 缺失（须写明复核来源）`);
    }
    const k = reviewKey(e.date, e.industry);
    if (seen.has(k)) errors.push(`${tag} 主键重复: ${k}`);
    seen.add(k);
  });
  return { ok: errors.length === 0, errors };
}

/** 台账 → Map<key, entry>（重复主键取后者，validateLedger 已保证不重复）。 */
export function buildReviewMap(ledger) {
  const map = new Map();
  const entries = ledger && Array.isArray(ledger.entries) ? ledger.entries : [];
  for (const e of entries) {
    if (!e || !e.date || !e.industry) continue;
    map.set(reviewKey(e.date, e.industry), e);
  }
  return map;
}

/**
 * 销案集合：只收 confirmed-real 的 key（data-error 不销案——那是必须继续报警的）。
 * dirty.js 的 validateDay/validateAll 通过 opts.reviewedOutliers 接收本集合。
 */
export function confirmedSet(ledger) {
  const set = new Set();
  for (const [k, e] of buildReviewMap(ledger)) {
    if (e.verdict === VERDICTS.REAL) set.add(k);
  }
  return set;
}

/** 自动化核验写入：按主键幂等合并（同键以新条目为准，保留其余）。返回新台账（不就地改）。 */
export function mergeEntries(ledger, newEntries) {
  const map = buildReviewMap(ledger);
  for (const e of newEntries || []) {
    if (e && e.date && e.industry) map.set(reviewKey(e.date, e.industry), e);
  }
  // 排序保证落盘 diff 稳定（同日期按行业名次级排序）
  const entries = [...map.values()].sort((a, b) => (
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : (a.industry < b.industry ? -1 : a.industry > b.industry ? 1 : 0)
  ));
  return { ...ledger, entries };
}
