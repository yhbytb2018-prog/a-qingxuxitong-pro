// ── src/reports_gap.js 断更判定测试（2026-10-22 cron 丢拍守卫）────────────────
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findReportsGap, beijingYmd, beijingDay, REPORT_LIVE_COLS } from '../src/reports_gap.js';

// 固定基准日：2026-10-16（周五，真实交易日）、2026-10-17（周六）
const FRI = '2026-10-16';
const SAT = '2026-10-17';
const CAL = { coveredFrom: '2025-01-02', coveredTo: '2026-10-16', closed: ['2026-10-07'], days: { '2026-10-07': 'closed' } };

// 全栏目当日文件齐备的 filesByCol
const full = (ymd) => Object.fromEntries(REPORT_LIVE_COLS.map((c) => [c, [`${ymd}.html`, '20261015.html']]));

test('交易日 + 当日文件齐全 → 不告警', () => {
  assert.equal(findReportsGap({ today: FRI, calendar: CAL, filesByCol: full('20261016'), at: 't' }), null);
});

test('交易日 + 缺当日文件 → error 事件（reports-gap，明细列缺档栏目）', () => {
  const files = full('20261016');
  delete files['主板接力'][0]; // 主板接力缺 20261016.html
  const ev = findReportsGap({ today: FRI, calendar: CAL, filesByCol: files, at: 't' });
  assert.ok(ev, '应产出事件');
  assert.equal(ev.severity, 'error');
  assert.equal(ev.kind, 'reports-gap');
  assert.equal(ev.source, 'reports_html');
  assert.match(ev.detail, /2026-10-16/);
  assert.match(ev.detail, /主板接力/);
  assert.doesNotMatch(ev.detail, /情绪扫描/, '其余栏目不在缺档清单');
});

test('休市日（closed 名单）→ 不告警', () => {
  assert.equal(findReportsGap({ today: '2026-10-07', calendar: CAL, filesByCol: {}, at: 't' }), null);
});

test('日历未覆盖当天（coveredTo < today）→ 不告警（不臆测）', () => {
  assert.equal(findReportsGap({ today: SAT, calendar: CAL, filesByCol: {}, at: 't' }), null);
});

test('日历缺席/损坏 → 不告警', () => {
  assert.equal(findReportsGap({ today: FRI, calendar: null, filesByCol: {}, at: 't' }), null);
  assert.equal(findReportsGap({ today: FRI, calendar: {}, filesByCol: {}, at: 't' }), null);
});

test('周度复盘仅周五参检：周五缺它要报，非周五缺它不报', () => {
  // 周五：其余齐全、独缺周度复盘 → 告警
  const filesFri = full('20261016');
  filesFri['周度复盘'] = [];
  assert.ok(findReportsGap({ today: FRI, calendar: CAL, filesByCol: filesFri, at: 't' }), '周五缺周度复盘应告警');
  // 非周五（用同日历里最后一个交易日的次日周四 10-15 构造覆盖内非周五：10-15 是周四）
  const thuD = '2026-10-15';
  const cal2 = { ...CAL, coveredTo: thuD };
  const filesThu = full('20261015');
  filesThu['周度复盘'] = []; // 周四不生成周报（设计），缺了也不该告警
  assert.equal(findReportsGap({ today: thuD, calendar: cal2, filesByCol: filesThu, at: 't' }), null, '非周五缺周度复盘不应告警');
});

test('days 映射旧形态（仅 closed 键）兼容', () => {
  const legacy = { coveredTo: FRI, days: { '2026-10-07': 'closed' } };
  assert.equal(findReportsGap({ today: FRI, calendar: legacy, filesByCol: full('20261016'), at: 't' }), null);
  const files = full('20261016');
  files['套利日报'] = [];
  assert.ok(findReportsGap({ today: FRI, calendar: legacy, filesByCol: files, at: 't' }), '映射形态下缺档仍应告警');
});

test('beijingYmd / beijingDay：UTC+8 换算', () => {
  // 2026-10-16T17:00:00Z = 北京 10-17 01:00（周六）
  assert.equal(beijingYmd(new Date('2026-10-16T17:00:00Z')), '2026-10-17');
  assert.equal(beijingDay(new Date('2026-10-16T17:00:00Z')), 6);
  assert.equal(beijingDay(new Date('2026-10-16T15:00:00Z')), 5); // 北京 23:00 仍是周五
});
