// 测试：② 离线模块新鲜度守卫（src/module_freshness.js）+ 三处消费端接线
//
// 背景（2026-10-08 第三批）：宽度/主线/账本三个离线模块只在 CI build 里产出，
// smoke 硬失败 → build 被拦 → 旧值静默顶替当日值。本套锁死守卫语义：
//   · 用户点名的 4 个场景：正常当日通过 / 停摆一日判脏 / 长假同期不误杀 / 字段缺失判脏；
//   · 判据锚定「档案日」而非「今天」——长假期间档案日与模块日天然同停（相等），
//     即使评估时刻在假期中/节后也不得误杀，这一点必须被用例钉死；
//   · CI 门禁（assessModulesFreshness）复用主档三态语义：pending 不误伤 18:30 首抓窗口；
//   · buildInput 锚点反转（第二批 09-30 名 / 10-08 内容事故的回归用例）；
//   · smoke 终态失败企微事件（①）正文契约：硬失败摘要 / ⚠ 提示 / 无 markdown 星号。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import {
  moduleTradeDate, guardModuleFreshness, guardModule,
  MODULE_PROBES, assessModulesFreshness, modulesBehind,
} from '../src/module_freshness.js';
import { smokeFailEvent } from '../src/opsalerts.js';
import { buildInput } from '../src/ai_report.js';

const HOL = config.manualHolidays;
const bj = (s) => new Date(`${s}:00+08:00`); // 北京墙上时间 → Date

// ── 1. moduleTradeDate：三模块字段形态的唯一识别口 ─────────────────────
test('moduleTradeDate：宽度（meta.tradeDate）/ 顶层 date / 账本（day.date）三形态均可提取', () => {
  assert.equal(moduleTradeDate({ meta: { tradeDate: '2026-10-08' } }), '2026-10-08');
  assert.equal(moduleTradeDate({ date: '2026-10-08' }), '2026-10-08');
  assert.equal(moduleTradeDate({ day: { date: '2026-10-08' } }), '2026-10-08');
});

test('moduleTradeDate：脏值不认（null / 数字 / 缺失 / 格式错 → null，按判脏处理）', () => {
  assert.equal(moduleTradeDate(null), null);
  assert.equal(moduleTradeDate(undefined), null);
  assert.equal(moduleTradeDate({}), null);
  assert.equal(moduleTradeDate({ meta: { tradeDate: 20261008 } }), null);
  assert.equal(moduleTradeDate({ meta: { tradeDate: '2026/10/08' } }), null);
  assert.equal(moduleTradeDate({ day: { date: null } }), null);
});

// ── 2. guardModuleFreshness：用户点名的 4 个场景 ───────────────────────
test('场景① 正常当日通过：moduleDate === archiveDate → ok（差 0 日）', () => {
  const g = guardModuleFreshness('2026-10-08', '2026-10-08');
  assert.equal(g.ok, true);
  assert.equal(g.reason, null);
});

test('场景② 停摆一日判脏：moduleDate < archiveDate（严格落后 ≥1 交易日）→ stale', () => {
  const g = guardModuleFreshness('2026-10-07', '2026-10-08');
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'stale');
  assert.equal(g.moduleDate, '2026-10-07');
  assert.equal(g.archiveDate, '2026-10-08');
});

test('场景③ 长假同期不误杀：节前最后交易日（09-30）档案日与模块日同停 → ok——判据锚定档案日而非今天', () => {
  // 国庆 10-01~10-07 休市：档案最后交易日 = 09-30，宽度/账本模块也停在 09-30。
  // 两边同停（相等）→ 通过。纯字符串比较与「今天是不是 10-08」完全无关——
  // 本用例连当前时刻都不引入，从构造上锁死「不锚定今天」。
  const g = guardModuleFreshness('2026-09-30', '2026-09-30');
  assert.equal(g.ok, true);
  assert.equal(g.reason, null);
});

test('场景④ 字段缺失判脏：模块无日期 / 档案锚无日期 → 均 ok=false（宁缺勿旧）', () => {
  assert.equal(guardModuleFreshness(null, '2026-10-08').reason, 'module-date-missing');
  assert.equal(guardModuleFreshness(undefined, '2026-10-08').reason, 'module-date-missing');
  assert.equal(guardModuleFreshness('2026-10-08', null).reason, 'anchor-missing');
  assert.equal(guardModuleFreshness('2026-10-08', 'not-a-date').reason, 'anchor-missing');
});

test('guardModule：对象级组合（读档对象 + 锚 → 同一结论）', () => {
  assert.equal(guardModule({ meta: { tradeDate: '2026-10-07' } }, '2026-10-08').reason, 'stale');
  assert.equal(guardModule({ day: { date: '2026-10-08' } }, '2026-10-08').ok, true);
  assert.equal(guardModule({}, '2026-10-08').reason, 'module-date-missing');
});

test('MODULE_PROBES：三模块探测表齐（宽度/主线/账本），file 落 data/ 相对路径', () => {
  const keys = MODULE_PROBES.map((m) => m.key);
  assert.deepEqual(keys, ['breadth', 'mainline', 'dual_track']);
  assert.ok(MODULE_PROBES.every((m) => m.file && m.label && m.field));
});

// ── 3. assessModulesFreshness：CI 门禁相位（复用主档三态，18:30 不误伤）──
test('门禁·fresh：模块日期 = 最近已收盘交易日 → 不红', () => {
  const r = assessModulesFreshness([{ key: 'breadth', label: '宽度扫描', date: '2026-10-08' }],
    { now: bj('2026-10-08T21:00'), holidays: HOL });
  assert.equal(r[0].state, 'fresh');
  assert.deepEqual(modulesBehind(r), []);
});

test('门禁·pending：18:30 首抓窗口模块未更新（昨日）→ pending 不红（预期更新 19:30 未到）', () => {
  const r = assessModulesFreshness([{ key: 'breadth', label: '宽度扫描', date: '2026-10-07' }],
    { now: bj('2026-10-08T15:30'), holidays: HOL });
  assert.equal(r[0].state, 'pending');
  assert.deepEqual(modulesBehind(r), [], '首抓窗口的「还没到点」不得判滞后');
});

test('门禁·behind：21:05 补抓后模块仍是昨日 → behind，进红名单', () => {
  const r = assessModulesFreshness([{ key: 'mainline', label: '主线回测', date: '2026-10-07' }],
    { now: bj('2026-10-08T21:05'), holidays: HOL });
  assert.equal(r[0].state, 'behind');
  assert.equal(r[0].behindSessions, 1);
  assert.deepEqual(modulesBehind(r).map((x) => x.key), ['mainline']);
});

test('门禁·长假：假期中模块停在节前末日（09-30）→ fresh 不误杀（国庆休市同停）', () => {
  for (const when of ['2026-10-01T12:00', '2026-10-05T20:00', '2026-10-07T23:00']) {
    const r = assessModulesFreshness([{ key: 'breadth', label: '宽度扫描', date: '2026-09-30' }],
      { now: bj(when), holidays: HOL });
    assert.equal(r[0].state, 'fresh', `${when} 应判 fresh`);
    assert.deepEqual(modulesBehind(r), []);
  }
});

test('门禁·unknown：日期缺失（档不存在/字段缺失）→ unknown，同样进红名单（无法自证新鲜即判脏）', () => {
  const r = assessModulesFreshness([{ key: 'dual_track', label: '双轨账本', date: null }],
    { now: bj('2026-10-08T21:00'), holidays: HOL });
  assert.equal(r[0].state, 'unknown');
  assert.deepEqual(modulesBehind(r).map((x) => x.key), ['dual_track']);
});

// ── 4. buildInput 接线（ai_report.js）：锚点反转 + stale 置 null ────────
const SIG_1008 = { meta: { tradeDate: '2026-10-08' } };
const DT_0930 = { day: { date: '2026-09-30', score: 58 }, summary: { trackA: { total: 0.02 } } };

test('buildInput·锚点反转（第二批事故回归）：账本 09-30 + signals 10-08 → 锚必须取 10-08，绝不生成 09-30 名的报告', () => {
  const input = buildInput({ dualTrack: DT_0930, signals: SIG_1008 });
  assert.equal(input.tradeDate, '2026-10-08', '锚以 signals.meta.tradeDate 为准，账本只作滞后披露项');
});

test('buildInput·账本滞后：dualTrack 置 null（旧值不进叙事）+ sources.dual_track 标 stale', () => {
  const input = buildInput({ dualTrack: DT_0930, signals: SIG_1008 });
  assert.equal(input.dualTrack, null, '账本旧快照不得顶替当日值');
  assert.equal(input.sources.dual_track, 'stale');
});

test('buildInput·主线滞后：backtest 置 null + sources.backtest 标 stale', () => {
  const input = buildInput({ dualTrack: DT_0930, signals: SIG_1008, backtest: { meta: { tradeDate: '2026-10-07' }, v52: { total: 0.01 } } });
  assert.equal(input.backtest, null);
  assert.equal(input.sources.backtest, 'stale');
});

test('buildInput·同期通过：账本/主线与锚同日 → 原样保留，不误杀', () => {
  const dt = { day: { date: '2026-10-08' } };
  const bt = { meta: { tradeDate: '2026-10-08' } };
  const input = buildInput({ dualTrack: dt, backtest: bt, signals: SIG_1008 });
  assert.equal(input.dualTrack, dt);
  assert.equal(input.backtest, bt);
  assert.equal(input.sources.dual_track, 'fresh');
  assert.equal(input.sources.backtest, 'fresh');
});

test('buildInput·长假同期（09-30 账本 + 09-30 signals）→ 保留不误杀', () => {
  const input = buildInput({ dualTrack: { day: { date: '2026-09-30' } }, signals: { meta: { tradeDate: '2026-09-30' } } });
  assert.equal(input.tradeDate, '2026-09-30');
  assert.notEqual(input.dualTrack, null);
});

// ── 5. smokeFailEvent（① 企微告警正文契约）────────────────────────────
test('smokeFailEvent：正文含 档案日 / run / 硬失败摘要 / 通过率 / ⚠ 提示，且无 markdown 星号', () => {
  const ev = smokeFailEvent(
    {
      tradeDateAnchored: '2026-10-08', allOk: false,
      hardFail: ['同花顺大盘日K：样本窗口最新 20260930 ≠ 锚定日'],
      sources: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: false }],
    },
    { runId: '12345', runUrl: 'https://github.com/x/y/actions/runs/12345', at: '2026-10-08T13:00:00.000Z' },
  );
  assert.equal(ev.kind, 'smoke-fail');
  assert.equal(ev.severity, 'error');
  assert.equal(ev.source, 'smoke');
  assert.match(ev.detail, /2026-10-08/);
  assert.match(ev.detail, /run 12345/);
  assert.match(ev.detail, /同花顺大盘日K/);
  assert.match(ev.detail, /5\/6/);
  assert.match(ev.detail, /⚠ 宽度\/主线档今日未刷新（build 被拦）/);
  assert.match(ev.detail, /actions\/runs\/12345/);
  assert.equal(ev.detail.includes('*'), false, '企微 muted 披露不渲染 markdown，正文不得含星号');
});

test('smokeFailEvent：smoke 档读不到（null）→ 正文自动降级为「明细不可读」，结构不塌', () => {
  const ev = smokeFailEvent(null, { runId: '7' });
  assert.equal(ev.kind, 'smoke-fail');
  assert.match(ev.detail, /档案日 未知/);
  assert.match(ev.detail, /硬失败明细不可读/);
  assert.match(ev.detail, /宽度\/主线档今日未刷新/);
});

test('smokeFailEvent：读到成功态档（allOk 非 false，如被后续 run 覆盖）→ 正文如实披露，不谎称硬失败', () => {
  const ev = smokeFailEvent({ tradeDateAnchored: '2026-10-08', allOk: true, hardFail: [], sources: [{ ok: true }] }, { runId: '9' });
  assert.match(ev.detail, /落盘冒烟档为成功态/);
  assert.doesNotMatch(ev.detail, /硬失败明细不可读/);
});
