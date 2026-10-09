// 亏钱效应 / 接力情绪模块测试（#2）
//
// 这一组测试的重点不是"算术对不对"，而是三条**语义纪律**：
//   ① 缺数据必须是 null，不能退化成 0 —— "翻绿 0%" 与 "不知道" 含义相反；
//   ② 昨涨停表现必须来自真实行情，hot 反查会得出恒 +10% 的假繁荣（用两种口径对拍证明）；
//   ③ 分级边界要自洽 —— 49% 翻绿不能判成"赚钱效应占优"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAIN_THRESHOLDS, ZT_THRESHOLD_PCT,
  median, mean,
  prevZtPerformance, advanceFailure, bigLossStocks, painVerdict, painReport,
} from '../src/pain.js';

// ────────────────────────── 基础统计 ──────────────────────────

test('median/mean：空数组返回 null（不是 0）', () => {
  assert.equal(median([]), null);
  assert.equal(mean([]), null);
  assert.equal(median(null), null);
  assert.equal(mean(undefined), null);
});

test('median：奇数取中位、偶数取中间两数均值', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('median/mean：忽略非有限值（null/NaN/字符串不被当 0）', () => {
  assert.equal(mean([2, null, 4, NaN, 'x']), 3);
  assert.equal(median([1, null, 3]), 2);
  assert.equal(mean([null, null]), null);
});

// ────────────────────────── 昨涨停今日表现 ──────────────────────────

test('prevZtPerformance：无行情时全部 null 且 reliable=false（不得填 0）', () => {
  const r = prevZtPerformance({}, ['600000', '000001']);
  assert.equal(r.n, 0);
  assert.equal(r.universe, 2);
  assert.equal(r.missing, 2);
  assert.equal(r.reliable, false);
  assert.equal(r.avg, null);
  assert.equal(r.median, null);
  // 关键：翻绿比例必须 null，不能是 0。0 会被读成"全部上涨"（极强）。
  assert.equal(r.lossRatio, null);
  assert.match(r.note, /无法计算/);
});

test('prevZtPerformance：翻绿比例 = 收跌只数/样本数', () => {
  const q = {
    A: { changePct: 10 }, B: { changePct: -3 }, C: { changePct: 0 },
    D: { changePct: -8 }, E: { changePct: 5 }, F: { changePct: -1 },
  };
  const r = prevZtPerformance(q, ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.equal(r.n, 6);
  assert.equal(r.lossRatio, Math.round(3 / 6 * 100) / 100);
  assert.equal(r.worst, -8);
  assert.equal(r.best, 10);
  // 0 涨幅不算翻绿（既非赚也非亏）
  assert.equal(r.lossRatio, 0.5);
});

test('prevZtPerformance：再涨停/跌停/大面 三分口径互不混淆', () => {
  const q = {
    A: { changePct: 10 },    // 再涨停
    B: { changePct: 9.9 },   // ≥ZT 阈值也算再涨停
    C: { changePct: -10 },   // 跌停 + 大面
    D: { changePct: -7 },    // 大面（等于阈值）
    E: { changePct: -6.9 },  // 不算大面
  };
  const r = prevZtPerformance(q, ['A', 'B', 'C', 'D', 'E']);
  assert.equal(r.limitUpAgain, 2);
  assert.equal(r.limitDown, 1);
  assert.equal(r.bigLoss, 2);
});

test('prevZtPerformance：样本过少时 reliable=false 且给出提示（不硬给结论）', () => {
  const q = { A: { changePct: -9 } };
  const r = prevZtPerformance(q, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  assert.equal(r.n, 1);
  assert.equal(r.reliable, false);
  assert.match(r.note, /偏少/);
});

test('prevZtPerformance：非有限 changePct 记为 missing 而非 0', () => {
  const q = { A: { changePct: 5 }, B: { changePct: null }, C: {}, D: { changePct: NaN } };
  const r = prevZtPerformance(q, ['A', 'B', 'C', 'D']);
  assert.equal(r.n, 1);
  assert.equal(r.missing, 3);
});

// ⚠ 本模块存在的**核心原因**：hot 反查 vs 真实行情的对拍。
//   这是把"为什么要新写一个模块"固化成测试，防止将来有人图省事改回 hot。
test('★ 关键：hot 反查会得出恒 +10% 的假繁荣（证明必须用真实行情）', () => {
  // 场景：昨涨停 10 只，今日 5 只继续涨（进 hot）、5 只翻绿（不在 hot）
  const realQuotes = {};
  for (let i = 0; i < 10; i++) realQuotes['S' + i] = { changePct: i < 5 ? 10 : -6 };
  const codes = Object.keys(realQuotes);
  // 真实行情口径：看得见那 5 只翻绿的
  const real = prevZtPerformance(realQuotes, codes);
  assert.equal(real.lossRatio, 0.5);
  assert.equal(real.avg, 2);   // (5*10 + 5*(-6))/10 = 2

  // hot 反查口径：只拿到"继续涨"的 5 只（下跌的根本不在 hot 里）
  const hotOnly = {};
  for (const c of codes.slice(0, 5)) hotOnly[c] = realQuotes[c]; // 只有涨的进来
  const viaHot = prevZtPerformance(hotOnly, codes);
  assert.equal(viaHot.avg, 10, 'hot 口径必然得到 +10% —— 这正是"假繁荣"');
  assert.equal(viaHot.lossRatio, 0, 'hot 口径看不到任何翻绿 —— 亏钱效应被整块抹掉');
  // 两种口径结论相差 8 个百分点、翻绿比例相差 50 个百分点
  assert.ok(real.avg < viaHot.avg - 5);
});

// ────────────────────────── 连板晋级失败率 ──────────────────────────

test('advanceFailure：只看 N≥2 的高位板（首板不算接力）', () => {
  const q = { A: { changePct: 10 }, B: { changePct: -3 }, C: { changePct: 10 } };
  const lb = { A: 1, B: 1, C: 2 };
  // A/B 是首板（lb=1）→ 应被排除；只有 C（2 板）进入统计
  const r = advanceFailure(q, lb);
  assert.equal(r.n, 1, '首板不得进入接力分母');
  assert.equal(r.kept, 1);
  assert.equal(r.failRate, 0);
  assert.equal(r.maxLb, 2);
});

test('★ num 纪律：changePct 为 null 不得被当成 0（+null===0 陷阱）', () => {
  // Number.isFinite(+null) === true，若不做 `v == null` 前置判断，
  // 一只"没有价格数据"的票会被算成"平盘"，静默稀释翻绿比例。
  const q = { A: { changePct: null }, B: { changePct: 10 }, C: { changePct: -10 } };
  const r = prevZtPerformance(q, ['A', 'B', 'C']);
  assert.equal(r.n, 2, 'null 不得计入样本');
  assert.equal(r.missing, 1);
  assert.equal(r.lossRatio, 0.5, '分母只能是 2，不能是 3');
});

test('advanceFailure：缺行情的票不计入分母（不把"没数据"当"失败"）', () => {
  const q = { A: { changePct: 10 } };  // 只有 A 有行情
  const lb = { A: 2, B: 2, C: 2 };     // B/C 昨日也是 2 板，但今日无行情
  const r = advanceFailure(q, lb);
  assert.equal(r.n, 1, '分母应为 1（只算取到行情的），而非 3');
  assert.equal(r.failed, 0);
  assert.equal(r.failRate, 0);
});

test('advanceFailure：晋级失败 = 今日未再封板（哪怕只涨 2%）', () => {
  const q = { A: { changePct: 10 }, B: { changePct: 2 }, C: { changePct: -5 } };
  const lb = { A: 2, B: 2, C: 3 };
  const r = advanceFailure(q, lb);
  assert.equal(r.n, 3);
  assert.equal(r.kept, 1);
  assert.equal(r.failed, 2);
  assert.equal(r.failRate, Math.round(2 / 3 * 100) / 100);
  assert.equal(r.maxLb, 3);
});

test('advanceFailure：按连板高度分层（2/3/4+）', () => {
  const q = { A: { changePct: 10 }, B: { changePct: 10 }, C: { changePct: -2 }, D: { changePct: 10 } };
  const lb = { A: 2, B: 2, C: 3, D: 5 };
  const r = advanceFailure(q, lb);
  assert.equal(r.byTier['2'].n, 2);
  assert.equal(r.byTier['2'].kept, 2);
  assert.equal(r.byTier['3'].n, 1);
  assert.equal(r.byTier['3'].failRate, 1);
  assert.equal(r.byTier['4+'].n, 1, '5 连板应归入 4+ 桶');
  assert.equal(r.byTier['4+'].kept, 1);
});

test('advanceFailure：空输入时各率为 null 并给出原因', () => {
  const r = advanceFailure({}, {});
  assert.equal(r.n, 0);
  assert.equal(r.failRate, null);
  assert.equal(r.maxLb, null);
  assert.ok(r.note);
});

// ────────────────────────── 大面股 / 天地板 ──────────────────────────

test('bigLossStocks：大面股按跌幅排序取最惨', () => {
  const q = {
    A: { name: 'A', changePct: -10 }, B: { name: 'B', changePct: -8 },
    C: { name: 'C', changePct: -6 }, D: { name: 'D', changePct: 3 },
  };
  const r = bigLossStocks(q);
  assert.equal(r.bigLoss.n, 2);           // -10、-8 两个（-6 未达 -7 阈值）
  assert.equal(r.bigLoss.list[0].chg, -10);
  assert.equal(r.scanned, 4);
});

test('bigLossStocks：天地板需振幅≥15% 且收绿', () => {
  const q = {
    A: { name: 'A', changePct: -3, high: 11, low: 9, prevClose: 10 },   // 振幅 20%、收绿 → 天地板
    B: { name: 'B', changePct: 5, high: 11, low: 9, prevClose: 10 },    // 振幅 20% 但收红 → 不算
    C: { name: 'C', changePct: -2, high: 10.3, low: 9.9, prevClose: 10 }, // 振幅 4% → 不算
  };
  const r = bigLossStocks(q);
  assert.equal(r.skyFloor.n, 1);
  assert.equal(r.skyFloor.list[0].name, 'A');
  assert.equal(r.skyFloor.list[0].amplitude, 20);
});

test('bigLossStocks：缺 high/low/prevClose 不误判天地板（不抛错）', () => {
  const r = bigLossStocks({ A: { changePct: -3 } });
  assert.equal(r.skyFloor.n, 0);
  assert.equal(r.bigLoss.n, 0);
});

// ────────────────────────── 分级（中性带）──────────────────────────

test('★ 分级：49% 翻绿必须判"多空拉锯"，不得判"接力顺畅"', () => {
  // 这是实盘 2026-09-30 的真实值。若用 `lr <= 0.5 → 顺畅`，会把"近一半在亏"
  // 说成"赚钱效应占优"，与直觉完全相反。
  const v = painVerdict({ lossRatio: 0.49, reliable: true }, { failRate: 0.4, reliable: true });
  assert.equal(v.level, 'normal');
  assert.equal(v.label, '多空拉锯');
});

test('分级：中性带 [0.4,0.6] 两端行为对称', () => {
  const at = (lr, fr) => painVerdict({ lossRatio: lr, reliable: true }, { failRate: fr, reliable: true }).level;
  assert.equal(at(0.39, 0.2), 'strong');
  assert.equal(at(0.4, 0.2), 'normal');   // 边界含在内
  assert.equal(at(0.6, 0.2), 'normal');
  assert.equal(at(0.61, 0.2), 'weak');
});

test('分级：亏钱效应显著需"翻绿>60% 且 高位板失败率≥50%"', () => {
  const at = (lr, fr) => painVerdict({ lossRatio: lr, reliable: true }, { failRate: fr, reliable: true }).level;
  assert.equal(at(0.7, 0.5), 'severe');
  assert.equal(at(0.7, 0.49), 'weak');   // 翻绿够高但高位板还行 → 只算转弱
  assert.equal(at(0.7, null), 'weak');   // 无晋级数据时不升级为 severe（证据不足）
});

test('分级：数据不足一律 unknown（不猜方向）', () => {
  assert.equal(painVerdict(null, null).level, 'unknown');
  assert.equal(painVerdict({ lossRatio: null }, {}).level, 'unknown');
  // reliable=false 也不给方向
  assert.equal(painVerdict({ lossRatio: 0.9, reliable: false }, {}).level, 'unknown');
});

test('分级：reason 里带上晋级失败率作为加重/减轻证据', () => {
  const v = painVerdict({ lossRatio: 0.7, reliable: true }, { failRate: 0.6, reliable: true });
  assert.match(v.reason, /翻绿 70%/);
  assert.match(v.reason, /晋级失败 60%/);
});

// ────────────────────────── 端到端 ──────────────────────────

test('painReport：组装完整面板且阈值随包下发（前端不重写）', () => {
  const prevDay = {
    trade_date: '2026-09-29',
    summary: { zt_codes: ['A', 'B', 'C', 'D', 'E', 'F'], zt_lb: { A: 2, B: 2, C: 3 } },
  };
  const q = {
    A: { changePct: 10, high: 11, low: 10, prevClose: 10 },
    B: { changePct: -9, high: 10, low: 9, prevClose: 10 },
    C: { changePct: -4 },
    D: { changePct: 3 }, E: { changePct: -1 }, F: { changePct: 0 },
  };
  const r = painReport(prevDay, q);
  assert.equal(r.date, '2026-09-29');
  assert.equal(r.prevZtCount, 6);
  assert.equal(r.perf.n, 6);
  assert.equal(r.advance.n, 3);
  assert.equal(r.verdict.level, 'normal'); // 3/6 = 50% 翻绿 → 拉锯
  assert.deepEqual(r.thresholds, PAIN_THRESHOLDS);
  assert.equal(r.scanned, 6);
});

test('painReport：昨日名单为空时不抛错且结论 unknown', () => {
  const r = painReport({ trade_date: 'x', summary: {} }, { A: { changePct: 1 } });
  assert.equal(r.prevZtCount, 0);
  assert.equal(r.perf.n, 0);
  assert.equal(r.verdict.level, 'unknown');
});

test('常量：阈值语义正确（大面线为负、晋级阈值与涨停口径一致）', () => {
  assert.ok(PAIN_THRESHOLDS.BIG_LOSS_PCT < 0);
  assert.ok(PAIN_THRESHOLDS.NEUTRAL_BAND > 0 && PAIN_THRESHOLDS.NEUTRAL_BAND < 0.5);
  assert.equal(PAIN_THRESHOLDS.LOSS_WARN_RATIO, 0.5);
  assert.ok(ZT_THRESHOLD_PCT > 0 && ZT_THRESHOLD_PCT <= 10);
});

test('纯函数：相同输入多次调用结果一致（可重现）', () => {
  const q = { A: { changePct: 5 }, B: { changePct: -5 } };
  const a = prevZtPerformance(q, ['A', 'B']);
  const b = prevZtPerformance(q, ['A', 'B']);
  assert.deepEqual(a, b);
});

test('纯函数：不修改入参', () => {
  const q = { A: { changePct: 5 } };
  const codes = ['A'];
  const qCopy = JSON.stringify(q);
  prevZtPerformance(q, codes);
  advanceFailure(q, { A: 2 });
  bigLossStocks(q);
  assert.equal(JSON.stringify(q), qCopy);
  assert.deepEqual(codes, ['A']);
});
