// 多维市场宽度（#3）单测
// 纪律：绝不手抄期望值——所有断言都基于**真引擎现生成**的结果，或对纯函数行为的
// 结构性断言（如"null 不得被当成 0"）。凡涉及具体数值，都由输入解析计算得出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  num, mean, stockBreadth, computeBreadth, breadthVerdict,
  buildBreadthSeries, breadthSeriesSummary, BREADTH_THRESHOLDS, MIN_BARS,
} from '../src/breadth.js';

/** 造一根 K 线序列：[日期前缀, 收盘]，日期用递增序号即可（宽度只看收盘与顺序）。 */
const bars = (closes, startDay = 1) => closes.map((c, i) => ({ d: `2026-01-${String(startDay + i).padStart(2, '0')}`, c }));

/** 造一段"平稳上涨"的收盘序列（递增），用于让 MA/新高判定有确定方向。 */
const ramp = (n, from = 10, step = 0.1) => Array.from({ length: n }, (_, i) => +(from + i * step).toFixed(3));

// ── ① num() —— 本项目最反复的坑：null 不得变 0 ──────────────────────────────
test('num：null/undefined/空串 → null（不得变 0）', () => {
  assert.equal(num(null), null);
  assert.equal(num(undefined), null);
  assert.equal(num(''), null);
  // 这三条是重点：+null===0、+''===0、Number.isFinite(0)===true
  assert.notEqual(num(null), 0);
  assert.notEqual(num(''), 0);
});

test('num：合法数字与数字字符串都能取到', () => {
  assert.equal(num(0), 0);          // 真 0 要保留（0 是有效值）
  assert.equal(num('1.23'), 1.23);
  assert.equal(num(-5), -5);
});

test('num：非数字串 / NaN / 对象 → null', () => {
  assert.equal(num('abc'), null);
  assert.equal(num(NaN), null);
  assert.equal(num({}), null);
  assert.equal(num([]), null, '空数组 +[]===0 也是坑，必须判空');
});

test('mean：空数组 → null（不返回 0）', () => {
  assert.equal(mean([]), null);
  assert.equal(mean(null), null);
  assert.equal(mean([null, undefined]), null);
});

test('mean：正常求平均，null 项被剔除', () => {
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(mean([1, null, 3]), 2);
});

// ── ② stockBreadth —— 单只票的宽度贡献 ────────────────────────────────────
test('stockBreadth：K 线不足 MA 窗口 → aboveMa 为 null（判不出，不是 false）', () => {
  const b = stockBreadth({ close: 10, closes: [10, 11, 12], pb: null });
  assert.equal(b.aboveMa, null, '不足 20 根不得硬算均线');
  assert.equal(b.ma, null);
  assert.equal(b.barsUsed, 3);
});

test('stockBreadth：正好 20 根可以算均线，收盘大于均线 → true', () => {
  const closes = ramp(20);           // 递增
  const b = stockBreadth({ close: closes[closes.length - 1], closes });
  assert.equal(b.aboveMa, true);
  assert.ok(b.ma != null);
});

test('stockBreadth：收盘低于均线 → false（真实判断，不是缺数据）', () => {
  const closes = [...ramp(19), ramp(19)[18] - 5]; // 最后一天大跌
  const b = stockBreadth({ close: closes[closes.length - 1], closes });
  assert.equal(b.aboveMa, false);
  assert.notEqual(b.aboveMa, null);  // false ≠ null
});

test('stockBreadth：回看窗口不足 → 新高/新低为 null（不得用"有史以来"伪造新高）', () => {
  const closes = ramp(100);          // 100 根 < 250+1
  const b = stockBreadth({ close: closes[99], closes });
  assert.equal(b.isNewHigh, null, '窗口不足时早期数据会天然全是新高，必须判不出');
  assert.equal(b.isNewLow, null);
});

test('stockBreadth：回看窗口充足时能判新高', () => {
  const closes = ramp(251);          // 递增 → 当日必为新高
  const b = stockBreadth({ close: closes[250], closes });
  assert.equal(b.isNewHigh, true);
  assert.equal(b.isNewLow, false);
});

test('stockBreadth：破净判定 PB<1；无 PB → null（不是 false）', () => {
  const closes = ramp(25);
  assert.equal(stockBreadth({ close: closes[24], closes, pb: 0.8 }).broken, true);
  assert.equal(stockBreadth({ close: closes[24], closes, pb: 1.5 }).broken, false);
  assert.equal(stockBreadth({ close: closes[24], closes, pb: null }).broken, null, '无 PB 是"判不出"，不是"没破净"');
});

// ── ③ computeBreadth —— 汇总，重点是分母纪律 ──────────────────────────────
test('computeBreadth：样本不足 MIN_SAMPLE → 比例为 null 且 reliable=false', () => {
  const stocks = Array.from({ length: 10 }, (_, i) => {
    const closes = ramp(30);
    return { code: `00000${i}`, close: closes[29], closes, pb: null };
  });
  const b = computeBreadth(stocks);
  assert.equal(b.reliable, false);
  assert.equal(b.aboveMa.ratio, null, '样本不足不得给出比例（哪怕算得出来）');
  assert.ok(b.note, '必须给出解释性 note');
});

test('computeBreadth：样本充足 → 比例可算，分母是有效样本数', () => {
  const mk = (above) => {
    const closes = above ? ramp(30) : [...ramp(29), ramp(29)[28] - 5];
    return { close: closes[closes.length - 1], closes, pb: null };
  };
  const stocks = [
    ...Array.from({ length: 150 }, (_, i) => ({ code: `A${i}`, ...mk(true) })),
    ...Array.from({ length: 50 }, (_, i) => ({ code: `B${i}`, ...mk(false) })),
  ];
  const b = computeBreadth(stocks);
  assert.equal(b.reliable, true);
  assert.equal(b.aboveMa.den, 200);
  assert.equal(b.aboveMa.n, 150);
  assert.equal(b.aboveMa.ratio, 0.75);
});

test('computeBreadth：样本不足的票被排除在分母外（不算 false）', () => {
  const full = Array.from({ length: 120 }, (_, i) => {
    const closes = ramp(30);
    return { code: `F${i}`, close: closes[29], closes, pb: null };
  });
  const short = Array.from({ length: 50 }, (_, i) => ({ code: `S${i}`, close: 10, closes: [10, 11], pb: null }));
  const b = computeBreadth([...full, ...short]);
  assert.equal(b.aboveMa.den, 120, 'K 线不足的票不得进分母（否则等于把它们算成"没站上"）');
  assert.equal(b.scanned, 120);
  assert.equal(b.requested, 170);
});

test('computeBreadth：破净率 PB 源不可用 → den=0、ratio=null（绝不填 0）', () => {
  const stocks = Array.from({ length: 120 }, (_, i) => {
    const closes = ramp(30);
    return { code: `P${i}`, close: closes[29], closes, pb: null };
  });
  const b = computeBreadth(stocks);
  assert.equal(b.brokenPb.den, 0);
  assert.equal(b.brokenPb.ratio, null, '0% 破净 = 极强信号，与"没抓到"含义相反，必须用 null 区分');
});

test('computeBreadth：给了外部涨跌家数就不再自算（口径唯一）', () => {
  const stocks = Array.from({ length: 120 }, (_, i) => {
    const closes = ramp(30);
    return { code: `U${i}`, close: closes[29], closes, pb: null };
  });
  const b = computeBreadth(stocks, { updown: { up: 3000, down: 1500, flat: 100 } });
  assert.equal(b.updown.src, 'external');
  assert.equal(b.updown.up, 3000);
});

test('computeBreadth：无外部家数时由 K 线自算涨跌家数', () => {
  const up = Array.from({ length: 60 }, (_, i) => { const c = ramp(30); return { code: `u${i}`, close: c[29], closes: c, pb: null }; });
  const down = Array.from({ length: 60 }, (_, i) => { const c = [...ramp(29), ramp(29)[28] - 1]; return { code: `d${i}`, close: c[c.length - 1], closes: c, pb: null }; });
  const b = computeBreadth([...up, ...down]);
  assert.equal(b.updown.src, 'kline');
  assert.equal(b.updown.up, 60);
  assert.equal(b.updown.down, 60);
});

// ── ④ breadthVerdict —— 结论归并 ───────────────────────────────────────────
test('breadthVerdict：不可信 → unknown（不得猜）', () => {
  assert.equal(breadthVerdict(null).level, 'unknown');
  assert.equal(breadthVerdict({ reliable: false, note: 'x' }).level, 'unknown');
});

test('breadthVerdict：高占比 → broad；低占比 → narrow；中间 → mixed', () => {
  const mk = (ratio) => ({ reliable: true, aboveMa: { ratio }, newHigh: { ratio: 0 }, newLow: { ratio: 0 } });
  assert.equal(breadthVerdict(mk(0.8)).level, 'broad');
  assert.equal(breadthVerdict(mk(0.2)).level, 'narrow');
  assert.equal(breadthVerdict(mk(0.5)).level, 'mixed');
});

test('breadthVerdict：新高新低同时高企 → 结构分化', () => {
  const b = { reliable: true, aboveMa: { ratio: 0.5 }, newHigh: { ratio: 0.15 }, newLow: { ratio: 0.12 } };
  assert.equal(breadthVerdict(b).level, 'diverged');
});

// ── ⑤ 序列与摘要 —— 覆盖率分母纪律（seats_daily 踩过的坑）───────────────────
test('buildBreadthSeries：滤掉不可信的天（不产生空行）', () => {
  const rows = [
    { date: '2026-09-29', breadth: { reliable: false } },
    { date: '2026-09-30', breadth: { reliable: true, scanned: 400, aboveMa: { ratio: 0.3 }, newHigh: { ratio: 0.01 }, newLow: { ratio: 0.02 }, brokenPb: { ratio: null }, updown: { up: 1, down: 2 } } },
  ];
  const s = buildBreadthSeries(rows);
  assert.equal(s.length, 1);
  assert.equal(s[0].date, '2026-09-30');
});

test('buildBreadthSeries：alignDates 保留完整轴，无数据的天标记 unknown', () => {
  const rows = [{ date: '2026-09-30', breadth: { reliable: true, scanned: 400, aboveMa: { ratio: 0.3 }, newHigh: { ratio: 0 }, newLow: { ratio: 0 }, brokenPb: { ratio: null }, updown: null } }];
  const s = buildBreadthSeries(rows, { alignDates: ['2026-09-29', '2026-09-30'] });
  assert.equal(s.length, 2);
  assert.equal(s[0].verdict, 'unknown');
  assert.equal(s[0].maRatio, null);
});

test('breadthSeriesSummary：无 totalDays 时覆盖率为 null（不得虚报 100%）', () => {
  const series = [{ date: 'a', scanned: 400, maRatio: 0.3 }];
  assert.equal(breadthSeriesSummary(series).coverage, null);
  assert.equal(breadthSeriesSummary(series, { totalDays: 100 }).coverage, 0.01);
});

// ── ⑥ 常量自洽性 ───────────────────────────────────────────────────────────
test('MIN_BARS 覆盖 MA 窗口（至少能算出均线）', () => {
  assert.equal(MIN_BARS, BREADTH_THRESHOLDS.MA_WINDOW + 1);
  assert.ok(MIN_BARS >= BREADTH_THRESHOLDS.MA_WINDOW);
});

test('阈值单调：MA_BEAR < MA_BULL（否则中性带为空）', () => {
  assert.ok(BREADTH_THRESHOLDS.MA_BEAR < BREADTH_THRESHOLDS.MA_BULL);
});
