// 合并方案阶段1 守卫：themeList（去噪题材 + 强度分）与 momentum 对象形态。
//
// 强度算法移植自原系统 template.html topicStrength（宽度30+高度30+资金20+持续20），
// 本测试用可手算的合成数据锁公式，防止后续改动悄悄漂移口径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrich } from '../src/pipeline.js';

// 合成日：hot 强势股（reason = 题材+题材），lhb_daily_aggr 当日榜（净买万元）
const mkDay = (date, hot, lhbDaily = []) => ({
  trade_date: date,
  hot,
  lhb_daily_aggr: lhbDaily,
  summary: {},
  emotion: { value: 50 },
});

// 三日构造：
//   D1: 题材A(业绩线) 2只、题材B(国企改革) 1只 —— A/B 都入去噪（全局≥2 只：A 有 2 只、B 全档 2 只）
//   D2: A 3只、B 1只
//   D3: A 2只、B 2只
// streak: A=3（三连）、B=3（三连）——B 在 D1 只 1 只但「在榜」即可
const H = (code, name, reason, change_pct, huanshou) => ({ code, name, reason, close: 10, change_pct, huanshou });
const days = [
  mkDay('2026-09-01', [
    H('600001', '甲', '业绩线+国企改革', 5, 2),
    H('600002', '乙', '业绩线', 3, 1),
  ], [
    { code: '600001', name: '甲', net_buy_wan: 5000, buy_wan: 0, sell_wan: 0 },
  ]),
  mkDay('2026-09-02', [
    H('600001', '甲', '业绩线+国企改革', 4, 2),
    H('600002', '乙', '业绩线', 6, 3),
    H('600003', '丙', '业绩线', 2, 1),
  ], [
    { code: '600001', name: '甲', net_buy_wan: 2000, buy_wan: 0, sell_wan: 0 },
    { code: '600002', name: '乙', net_buy_wan: -1000, buy_wan: 0, sell_wan: 0 },
  ]),
  mkDay('2026-09-03', [
    H('600001', '甲', '业绩线+国企改革', 8, 4),
    H('600002', '乙', '业绩线', 4, 2),
    H('600004', '丁', '国企改革', 3, 1.5),
  ], [
    { code: '600001', name: '甲', net_buy_wan: 8000, buy_wan: 0, sell_wan: 0 },
    { code: '600004', name: '丁', net_buy_wan: 3000, buy_wan: 0, sell_wan: 0 },
  ]),
];

test('themeList: 结构完整（tag/count/codes/avg_zf/avg_hs/net/streak/score）且按 score 降序', () => {
  const { out } = enrich(JSON.parse(JSON.stringify(days)));
  const d3 = out[out.length - 1];
  assert.ok(Array.isArray(d3.themeList) && d3.themeList.length >= 2, 'themeList 应含 ≥2 个去噪题材');
  for (const t of d3.themeList) {
    for (const k of ['tag', 'count', 'codes', 'avg_zf', 'avg_hs', 'net', 'streak', 'score']) {
      assert.ok(t[k] != null, `themeList 元素缺 ${k}`);
    }
    assert.ok(Array.isArray(t.codes) && t.codes.length >= 1, 'codes 应为非空数组');
  }
  const scores = d3.themeList.map((t) => t.score);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores, '应按 score 降序');
});

test('themeList: 强度公式可手算锁定（宽度30+高度30+资金20+持续20，当日归一化）', () => {
  const { out } = enrich(JSON.parse(JSON.stringify(days)));
  const d3 = out[out.length - 1];
  const A = d3.themeList.find((t) => t.tag === '业绩线');
  const B = d3.themeList.find((t) => t.tag === '国企改革');
  // D3 手算：
  //   A: count=2(甲乙), avg_zf=(8+4)/2=6, net=甲8000(乙不在当日榜), streak=3
  //   B: count=2(甲丁), avg_zf=(8+3)/2=5.5, net=甲8000+丁3000=11000, streak=3
  assert.equal(A.count, 2); assert.equal(A.avg_zf, 6); assert.equal(A.net, 8000); assert.equal(A.streak, 3);
  assert.equal(B.count, 2); assert.equal(B.avg_zf, 5.5); assert.equal(B.net, 11000); assert.equal(B.streak, 3);
  // 归一化基底：maxC=2, maxZ=6(A), maxN=11000(B), maxS=3
  const expA = Math.round(2 / 2 * 30 + 6 / 6 * 30 + 8000 / 11000 * 20 + 3 / 3 * 20);
  const expB = Math.round(2 / 2 * 30 + 5.5 / 6 * 30 + 11000 / 11000 * 20 + 3 / 3 * 20);
  assert.equal(A.score, expA, '业绩线强度分与手算不符');
  assert.equal(B.score, expB, '国企改革强度分与手算不符');
  assert.equal(expB, 98, 'B 仅高度维度让位 A（5.5/6*30=27.5）→ 98 分（手算自校验）');
});

test('themeList: 每一日都有（历史回看可用），且 streak 断档后归零重计', () => {
  const more = JSON.parse(JSON.stringify(days));
  // D4: A 消失一天（只留 B），D5: A 回归 → streak=1
  more.push(mkDay('2026-09-04', [
    H('600001', '甲', '国企改革', 4, 2),
    H('600004', '丁', '国企改革', 2, 1),
  ], []));
  more.push(mkDay('2026-09-05', [
    H('600001', '甲', '业绩线+国企改革', 4, 2),
    H('600002', '乙', '业绩线', 3, 1),
  ], []));
  const { out } = enrich(more);
  assert.ok(out.every((d) => Array.isArray(d.themeList)), '每日都应有 themeList');
  const d4 = out[3];
  assert.equal(d4.themeList.find((t) => t.tag === '业绩线'), undefined, 'D4 无业绩线成分（如实缺）');
  const d5 = out[4];
  assert.equal(d5.themeList.find((t) => t.tag === '业绩线').streak, 1, '断档后 streak 重计为 1');
});

test('momentum: 三态统一 {theme, stocks} 对象形态（UI 信号中心直读）', () => {
  const { momObj } = enrich(JSON.parse(JSON.stringify(days)));
  for (const k of ['fresh', 'continuing', 'fading']) {
    assert.ok(Array.isArray(momObj[k]), `${k} 应为数组`);
    for (const el of momObj[k]) {
      assert.equal(typeof el.theme, 'string', `${k} 元素应有 theme 字符串`);
      assert.ok(Number.isInteger(el.stocks) && el.stocks >= 0, `${k} 元素应有 stocks 非负整数（今日覆盖数）`);
    }
  }
  // 三日构造下：窗口 5+5 > 3 天 → momentum 三个空数组（数据不足如实为空，不编数）
  assert.equal(momObj.fresh.length, 0);
  assert.equal(momObj.continuing.length, 0);
  assert.equal(momObj.fading.length, 0);
});
