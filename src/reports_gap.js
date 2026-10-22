// ── 盘后 14 栏目日报断更判定（纯函数层 · 2026-10-22 cron 丢拍守卫）────────────
//
// 背景（2026-10-22 实录）：GitHub 平台连续三天未触发盘后 '30 10'/'0 13' 两个 cron，
// smoke/build 全 skipped 且 workflow 显示 success（跳过不报警）——reports_html 14 栏目
// 日报静默停在 20261019。备份拍（'15 11'/'15 14'）自愈重跑之外，本模块是最后一道
// 断更告警：23:50 终检，当日为交易日而栏目页缺当日文件 → error 事件。
//
// 纪律（承 guard_notify）：判定与载荷构造全在本纯函数层，scripts/check_reports_gap.mjs
// 只做 IO 编排；观察者不是门禁——调用方任何情形都不得让 CI 变红。
//
// ⚠ REPORT_LIVE_COLS 与 scripts/build_reports_html.mjs 的 COLS label（= 目录名）同源，
//   增删栏目须两处同步（该脚本不可被 import——文件顶层即执行生成逻辑）。

export const REPORT_LIVE_COLS = [
  '早盘快报', '情绪扫描', '短线选股', '盘前备忘', '盘中预判', '竞价复盘',
  '涨停双视角', '主板接力', '二波扫描', '套利日报', '题材导图', '次日预测',
  '热点新闻', '周度复盘',
];

/** 北京时区的当天日期（YYYY-MM-DD）。 */
export function beijingYmd(d = new Date()) {
  const b = new Date(d.getTime() + 8 * 3600 * 1000);
  return b.toISOString().slice(0, 10);
}

/** 北京时区当天是周几（0=周日 … 5=周五）。 */
export function beijingDay(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600 * 1000).getUTCDay();
}

/**
 * 断更判定（纯函数）。
 * @param {object} p
 * @param {string} p.today 北京日期 YYYY-MM-DD
 * @param {object|null} p.calendar data/calendar.json（closed: 休市日期数组；days: 以日期为键、
 *                                值 'closed' 的映射——兼容两种形态；coveredTo: 覆盖上界）
 * @param {Record<string, string[]>} p.filesByCol 栏目目录名 → 已有 YYYYMMDD.html 文件名列表
 * @param {string} [p.at] 事件时间戳
 * @returns {{at,severity,kind,source,detail}|null null = 不告警（非交易日 / 日历不可判 / 无缺口）
 */
export function findReportsGap({ today, calendar, filesByCol, at = new Date().toISOString() }) {
  // 交易日判定（calendar.json 实际形态：closed=休市日数组，days 仅收录 closed 键；
  // trading 数组恒空不可用）：交易日 = 日历覆盖到当天 且 当天不在休市名单。
  // 日历缺席 / 未覆盖当天（coveredTo < today，管道当日未更新时会发生）→ 无法判定 →
  // 不告警（守卫绝不臆测，漏报交给次日守卫与数据新鲜度门禁兜底）。
  const closed = Array.isArray(calendar?.closed)
    ? calendar.closed
    : calendar?.days && typeof calendar.days === 'object' && !Array.isArray(calendar.days)
      ? Object.keys(calendar.days).filter((k) => calendar.days[k] === 'closed')
      : null;
  if (!Array.isArray(closed) || typeof calendar?.coveredTo !== 'string' || today > calendar.coveredTo) return null;
  if (closed.includes(today)) return null;

  // 周度复盘仅周五生成（与 build_reports_html.mjs 周五门禁同语义），其余日不参检
  const cols = REPORT_LIVE_COLS.filter((c) => c !== '周度复盘' || beijingDay(new Date(`${today}T00:00:00Z`)) === 5);
  const ymd = today.replaceAll('-', '');
  const missing = cols.filter((c) => !(Array.isArray(filesByCol?.[c]) && filesByCol[c].includes(`${ymd}.html`)));
  if (missing.length === 0) return null;

  const detail = [
    `盘后 14 栏目日报缺 ${today} 当日文件：${missing.join('、')}`,
    '盘后主拍（18:30/21:00）与备拍（19:15/22:15）的 smoke→build 全部未产出。',
    '处置：Actions → daily-sentiment → Run workflow 手动补跑（补今天；缺的历史日数据未抓过，不补 0）。',
  ].join('\n');
  return { at, severity: 'error', kind: 'reports-gap', source: 'reports_html', detail };
}
