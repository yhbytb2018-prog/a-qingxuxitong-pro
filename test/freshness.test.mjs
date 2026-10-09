// 测试：数据新鲜度三态判定（src/freshness.js）
//
// 背景：旧口径把 meta.stale 当作「上一次尝试是否失败」的标记——只在回退路径置 true，
// 成功路径重建 meta 时才会清掉；若某次回退之后运行一直走「跳过」（龙虎榜未公布 → 不写存档），
// stale 就永远粘着 → 页面长期误报「数据滞后」，而数据其实已是最新收盘会话；
// 同时「正常等待发布」与「真滞后」被混成同一句话，用户无从判断。
// 本测试按交易日历锁定三态，并覆盖中秋/国庆休市日不误报。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import config from '../src/config.js';
import {
  assessFreshness, staleReasonText, applyFreshnessMeta, applyPhaseMeta, freshnessKey,
  marketPhase, PHASE_NOTE, MARKET_OPEN, MARKET_CLOSE,
  prevSession, nextSession, countSessions, publishDeadline, lastClosedSession,
} from '../src/freshness.js';

const HOL = config.manualHolidays;
const bj = (s) => new Date(`${s}:00+08:00`); // 北京墙上时间 → Date
const at = (tradeDate, when) => assessFreshness({ tradeDate }, bj(when), HOL);
const iso = (s) => new Date(`${s}:00+08:00`).toISOString();

test('盘中（09-30 13:00）存档 09-29 → fresh：那正是最近已收盘交易日，不该告警', () => {
  const f = at('2026-09-29', '2026-09-30T13:00');
  assert.equal(f.state, 'fresh');
  assert.equal(f.stale, false);
  assert.equal(f.latestClosed, '2026-09-29');
  assert.equal(f.behindSessions, 0);
  assert.equal(f.publishDeadline, iso('2026-09-30T19:30')); // 预期更新=次交易日 19:30
  assert.equal(staleReasonText(f), null);
});

test('盘后但未到预期更新时刻（09-30 15:30）→ pending：正常等待，不告警', () => {
  const f = at('2026-09-29', '2026-09-30T15:30');
  assert.equal(f.state, 'pending');
  assert.equal(f.stale, false, 'pending 不是滞后，不能报警');
  assert.equal(f.latestClosed, '2026-09-30'); // 当日已收盘（盘中判定会退回上一交易日）
  assert.equal(f.behindSessions, 1);
});

test('已过预期更新时刻仍落后（09-30 19:31）→ behind：真滞后并给出原因', () => {
  const f = at('2026-09-29', '2026-09-30T19:31');
  assert.equal(f.state, 'behind');
  assert.equal(f.stale, true);
  assert.match(staleReasonText(f), /落后 1 个交易日/);
  assert.match(staleReasonText(f), /2026-09-30/);
});

test('节后首日抓取成功（tradeDate=09-30）→ fresh，且预期更新时刻跨过国庆落在 10-08', () => {
  const f = at('2026-09-30', '2026-09-30T21:00');
  assert.equal(f.state, 'fresh');
  assert.equal(f.publishDeadline, iso('2026-10-08T19:30'));
});

test('国庆休市日（10-05 周一 20:00）存档 09-30 → fresh：休市不误报', () => {
  for (const when of ['2026-10-01T12:00', '2026-10-05T20:00', '2026-10-07T23:00']) {
    const f = at('2026-09-30', when);
    assert.equal(f.state, 'fresh', `${when} 应判 fresh`);
    assert.equal(f.latestClosed, '2026-09-30');
    assert.equal(f.behindSessions, 0);
  }
});

test('中秋休市（09-25 周五 20:00）存档 09-24 → fresh', () => {
  const f = at('2026-09-24', '2026-09-25T20:00');
  assert.equal(f.state, 'fresh');
  assert.equal(f.latestClosed, '2026-09-24');
});

test('周末：存档周五数据 → fresh；缺周五数据（周六）→ behind', () => {
  // 10-09 周五收盘数据，周日来看 → 仍是最新
  const ok = at('2026-10-09', '2026-10-11T12:00');
  assert.equal(ok.state, 'fresh');
  assert.equal(ok.publishDeadline, iso('2026-10-12T19:30')); // 周一 19:30
  // 周六（10-10）看时只有周四数据 → 周五那次已过预期更新时刻，算真滞后
  const bad = at('2026-10-08', '2026-10-10T12:00');
  assert.equal(bad.state, 'behind');
  assert.equal(bad.behindSessions, 1);
});

test('无 tradeDate → unknown，不告警', () => {
  const f = at(null, '2026-09-30T13:00');
  assert.equal(f.state, 'unknown');
  assert.equal(f.stale, false);
  assert.equal(f.publishDeadline, null);
});

test('时钟异常（存档交易日晚于评估时刻）→ 不误判为滞后', () => {
  const f = at('2026-10-08', '2026-09-30T13:00');
  assert.equal(f.behindSessions, 0);
  assert.equal(f.state, 'fresh');
});

test('applyFreshnessMeta 只改判定字段：note/generatedAt 等原样保留，数据字段不被触碰', () => {
  const meta = {
    tradeDate: '2026-09-29', note: 'breadth 手工回填', generatedAt: '2026-09-29T15:13:48.079Z', stale: true,
  };
  const days = [{ trade_date: '2026-09-29' }];
  applyFreshnessMeta(meta, '2026-09-29', bj('2026-09-30T13:00'), HOL, { outcome: 'skipped', reason: '等待龙虎榜' });
  assert.equal(meta.note, 'breadth 手工回填');
  assert.equal(meta.generatedAt, '2026-09-29T15:13:48.079Z');
  assert.equal(meta.stale, false);
  assert.equal(meta.staleReason, null);
  assert.equal(meta.lastAttempt.outcome, 'skipped');
  assert.equal(days[0].trade_date, '2026-09-29', '数据字段不应被改动');
});

test('freshnessKey 忽略评估时刻，避免仅因时间戳变化产生无意义提交；状态真变时才变', () => {
  const meta = { tradeDate: '2026-09-29' };
  applyFreshnessMeta(meta, '2026-09-29', bj('2026-09-30T13:00'), HOL, { outcome: 'ok' });
  const k1 = freshnessKey(meta);
  applyFreshnessMeta(meta, '2026-09-29', bj('2026-09-30T13:05'), HOL, { outcome: 'ok' });
  assert.equal(freshnessKey(meta), k1);
  applyFreshnessMeta(meta, '2026-09-29', bj('2026-09-30T13:06'), HOL, { outcome: 'skipped', reason: '龙虎榜未公布' });
  assert.notEqual(freshnessKey(meta), k1, '尝试结果发生变化（ok→skipped）应落盘，页面才能看到「最近一次没抓成」');
  const k2 = freshnessKey(meta);
  applyFreshnessMeta(meta, '2026-09-29', bj('2026-09-30T13:08'), HOL, { outcome: 'skipped', reason: '龙虎榜未公布' });
  assert.equal(freshnessKey(meta), k2, '同类结果重复出现不应产生重复提交');
  applyFreshnessMeta(meta, '2026-09-29', bj('2026-09-30T19:31'), HOL, { outcome: 'skipped' });
  assert.notEqual(freshnessKey(meta), k2, '跨过预期更新时刻后状态由 pending 变 behind，应触发落盘');
});

test('交易日历：跨中秋/国庆的前后交易日与区间计数', () => {
  assert.equal(nextSession('2026-09-24', HOL), '2026-09-28'); // 中秋 9-25~9-27 休市
  assert.equal(nextSession('2026-09-30', HOL), '2026-10-08'); // 国庆 10-1~10-7 休市
  assert.equal(prevSession('2026-10-08', HOL), '2026-09-30');
  assert.equal(prevSession('2026-09-28', HOL), '2026-09-24');
  assert.equal(countSessions('2026-09-24', '2026-09-30', HOL), 3); // 9-28 / 9-29 / 9-30
  assert.equal(countSessions('2026-09-24', '2026-09-24', HOL), 0);
  assert.equal(publishDeadline('2026-09-24', HOL), Date.parse('2026-09-28T19:30:00+08:00'));
});

test('lastClosedSession：盘中退回上一交易日、收盘后取当日、休市日退回节前', () => {
  assert.equal(lastClosedSession(bj('2026-09-30T14:59'), HOL), '2026-09-29');
  assert.equal(lastClosedSession(bj('2026-09-30T15:00'), HOL), '2026-09-30');
  assert.equal(lastClosedSession(bj('2026-10-05T20:00'), HOL), '2026-09-30');
  assert.equal(lastClosedSession(bj('2026-10-11T12:00'), HOL), '2026-10-09');
});

test('回归：真实存档 meta 结构自洽（stale 必须等价于 state===behind）', () => {
  const arc = JSON.parse(readFileSync(new URL('../data/archive.json', import.meta.url), 'utf8'));
  assert.ok(arc.meta && arc.meta.tradeDate, '存档应有 meta.tradeDate');
  if (arc.meta.freshness) {
    assert.ok(['fresh', 'pending', 'behind', 'unknown'].includes(arc.meta.freshness.state));
    assert.equal(arc.meta.stale, arc.meta.freshness.state === 'behind',
      'stale 必须由 state 推导，不能是独立粘滞的标记');
    assert.equal(arc.meta.freshness.tradeDate, arc.meta.tradeDate);
  }
});

// ── 市场相位（pre / live / closed）──────────────────────────────────────────
// 相位与新鲜度正交：state 说「存档是不是最新已收盘会话」，phase 说「现在市场在什么阶段」。
// 盘中两者必然不同（行情实时可得，但分位/因子按上一收盘日算），混读会得出「情绪分突然跳变」的假信号。

test('相位：交易日开盘前 09:29 → pre；09:30 起 → live；15:00 起 → closed', () => {
  assert.equal(marketPhase(bj('2026-09-30T09:29'), HOL).phase, 'pre');
  assert.equal(marketPhase(bj('2026-09-30T09:30'), HOL).phase, 'live');
  assert.equal(marketPhase(bj('2026-09-30T14:59'), HOL).phase, 'live');
  assert.equal(marketPhase(bj('2026-09-30T15:00'), HOL).phase, 'closed');
  assert.equal(marketPhase(bj('2026-09-30T23:59'), HOL).phase, 'closed');
  assert.equal(marketPhase(bj('2026-09-30T00:01'), HOL).phase, 'pre');
});

test('相位：非交易日恒为 closed（无盘中概念），且标注 isTradingDay=false', () => {
  // 2026-10-01 为国庆休市（在 config.manualHolidays 内）
  for (const t of ['09:00', '10:30', '14:30', '20:00']) {
    const p = marketPhase(bj(`2026-10-01T${t}`), HOL);
    assert.equal(p.phase, 'closed', `非交易日 ${t} 应为 closed`);
    assert.equal(p.isTradingDay, false);
  }
  // 周末同理
  assert.equal(marketPhase(bj('2026-10-03T10:30'), HOL).phase, 'closed'); // 周六
});

test('相位：applyPhaseMeta 写入 meta，且不触碰 freshness/数据字段', () => {
  const meta = { tradeDate: '2026-09-29', stale: true, staleReason: 'x', note: '别动我' };
  applyPhaseMeta(meta, bj('2026-09-30T10:30'), HOL);
  assert.equal(meta.phase, 'live');
  assert.equal(meta.phaseTradingDay, true);
  assert.equal(meta.phaseNote, PHASE_NOTE.live);
  assert.ok(meta.phaseCheckedAt);
  // 正交性：相位写入不得改写新鲜度或业务说明
  assert.equal(meta.tradeDate, '2026-09-29');
  assert.equal(meta.stale, true);
  assert.equal(meta.staleReason, 'x');
  assert.equal(meta.note, '别动我');
});

test('相位：三个相位各有口径说明文案（不得为空白——前端直接展示它）', () => {
  for (const k of ['pre', 'live', 'closed']) {
    assert.ok(typeof PHASE_NOTE[k] === 'string' && PHASE_NOTE[k].length > 10, `${k} 缺口径说明`);
  }
  // live 的说明必须点出「分位/因子未重算」——这是最容易被误读的一点
  assert.ok(/未重算|上一收盘/.test(PHASE_NOTE.live), 'live 说明未点明分位/因子口径');
});

test('相位参与 freshnessKey：相位切换必须触发落盘，否则页面永远停在旧相位', () => {
  const base = { tradeDate: '2026-09-30', stale: false, freshness: { state: 'fresh' } };
  const a = { ...base, phase: 'live' };
  const b = { ...base, phase: 'closed' };
  assert.notEqual(freshnessKey(a), freshnessKey(b), '相位变化必须改变 key');
  // 但仅时间戳变化（同相位）不得触发落盘，避免提交噪音
  assert.equal(freshnessKey({ ...a, phaseCheckedAt: '2026-09-30T10:30:00Z' }),
    freshnessKey({ ...a, phaseCheckedAt: '2026-09-30T10:31:00Z' }));
});

test('相位常量：MARKET_OPEN=09:30 / MARKET_CLOSE=15:00（与 fresh 判定共用同一组边界）', () => {
  assert.equal(MARKET_OPEN, '09:30');
  assert.equal(MARKET_CLOSE, '15:00');
});
