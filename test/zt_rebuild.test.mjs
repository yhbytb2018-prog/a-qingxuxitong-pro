// 涨停/炸板/跌停/涨跌家数重建规则锁（合成 K 线，零网络）
// 背景：历史六因子回填用不复权 K 线重建东财池口径，本测试锁定交易所规则的逐位判定。
import test from 'node:test';
import assert from 'node:assert';
import { limitPctOf, classifyBar, consecutiveZt, poolsOf } from '../src/zt_rebuild.js';

// 合成 K 线：[date, open, close, high, low, vol]
// 前面垫 10 根平盘（满足 i>=5 的上市初期门槛），尾部接 closes 序列
const mkBars = (closes, { highs = null, code = 'sh600000', name = '普通股' } = {}) => {
  const bars = [];
  for (let i = 0; i < 10; i++) {
    const d = `2025-12-${String(10 + i).padStart(2, '0')}`;
    bars.push([d, 10, 10, 10, 10, 1000]);
  }
  let prev = 10;
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    const h = Array.isArray(highs) ? highs[i] : Math.max(c, prev);
    bars.push([`2026-01-${String(i + 1).padStart(2, '0')}`, prev, c, h, Math.min(c, prev) * 0.99, 1000]);
    prev = c;
  }
  return { bars, code, name };
};

test('幅度判定：北交所30 / 创业板科创20 / 主板ST5 / 主板10', () => {
  assert.equal(limitPctOf('bj920002', '万泰永磁'), 0.30);
  assert.equal(limitPctOf('sz300750', '宁德时代'), 0.20);
  assert.equal(limitPctOf('sh688137', '近岸蛋白'), 0.20);
  assert.equal(limitPctOf('sh600000', '浦发银行'), 0.10);
  assert.equal(limitPctOf('sz000001', 'ST平安'), 0.05);
  assert.equal(limitPctOf('sz000001', '*ST 某某'), 0.05);
});

test('主板涨停：收盘=round(前收×1.1,2) 精确相等', () => {
  // 10.00 → 涨停价 11.00
  const b1 = mkBars([10, 11]);
  assert.equal(classifyBar(b1.bars, b1.bars.length - 1, b1.code, b1.name).zt, true);
  // 9.99 → 10.99（round(10.989,2)）
  const b2 = mkBars([9.99, 10.99]);
  assert.equal(classifyBar(b2.bars, b2.bars.length - 1, b2.code, b2.name).zt, true);
  // 差一分钱不算
  const b3 = mkBars([10, 10.99]);
  assert.equal(classifyBar(b3.bars, b3.bars.length - 1, b3.code, b3.name).zt, false);
});

test('炸板：最高触涨停但收盘未封', () => {
  // 前收 10，最高 11（触板），收盘 10.5（未封）
  const b = mkBars([10.5], { highs: [11] });
  const c = classifyBar(b.bars, b.bars.length - 1, b.code, b.name);
  assert.equal(c.zb, true);
  assert.equal(c.zt, false);
});

test('跌停：收盘=round(前收×0.9,2)', () => {
  const b = mkBars([9]);
  const c = classifyBar(b.bars, b.bars.length - 1, b.code, b.name);
  assert.equal(c.dt, true);
  assert.equal(c.zt, false);
});

test('创业板20%：10%涨幅不是涨停', () => {
  const b1 = mkBars([11], { code: 'sz300001' });
  assert.equal(classifyBar(b1.bars, b1.bars.length - 1, b1.code, b1.name).zt, false);
  const b2 = mkBars([12], { code: 'sz300001' });
  assert.equal(classifyBar(b2.bars, b2.bars.length - 1, b2.code, b2.name).zt, true);
});

test('ST主板5%：10.5是涨停', () => {
  const b = mkBars([10.5], { name: 'ST某' });
  assert.equal(classifyBar(b.bars, b.bars.length - 1, b.code, b.name).zt, true);
});

test('上市初期（前5根）不判定', () => {
  const bars = [
    ['2026-01-01', 10, 11, 11, 10, 100],
    ['2026-01-02', 11, 12.1, 12.1, 11, 100],
    ['2026-01-03', 12.1, 13.31, 13.31, 12, 100],
    ['2026-01-04', 13.31, 14.64, 14.64, 13, 100],
    ['2026-01-05', 14.64, 16.1, 16.1, 14.6, 100],
    ['2026-01-06', 16.1, 17.71, 17.71, 16, 100],
  ];
  // i<5 → null（含 i=4：第 5 根仍属无限制期）
  assert.equal(classifyBar(bars, 3, 'sh600000', '普通股'), null);
  assert.equal(classifyBar(bars, 4, 'sh600000', '普通股'), null);
  // i=5：前收 16.1 → 涨停 17.71，精确相等
  const c5 = classifyBar(bars, 5, 'sh600000', '普通股');
  assert.equal(c5.zt, true);
});

test('连板数：连续收盘涨停逐日累计', () => {
  // 10→11→12.1→13.31→14.64 四连板后断板 14.0
  const b1 = mkBars([11, 12.1, 13.31, 14.64, 14.0]);
  assert.equal(consecutiveZt(b1.bars, b1.bars.length - 1, b1.code, b1.name), 0); // 末根断板
  assert.equal(consecutiveZt(b1.bars, b1.bars.length - 2, b1.code, b1.name), 4); // 14.64 是四连板顶点
});

test('poolsOf：东财池同形态（含 max_lb/lb2/zt_codes/zt_lb）', () => {
  const p = poolsOf({ zt: [{ code: '600000', lbc: 2 }, { code: '000001', lbc: 5 }], zb: ['300750'], dt: ['688137'], up: 3000, down: 2000, flat: 100 });
  assert.deepEqual(p, {
    zt: 2, zb: 1, dt: 1, max_lb: 5, lb2: 2,
    zt_codes: ['600000', '000001'], zt_lb: { 600000: 2, '000001': 5 },
  });
});

test('字符串价格（腾讯 raw 返回 "9.220" 形态）同样精确判定', () => {
  const bars = [
    ['2026-01-01', '10.000', '10.000', '10.000', '10.000', '100'],
    ['2026-01-02', '10.000', '11.000', '11.000', '10.500', '200'],
  ];
  // 补足前5根门槛
  for (let i = 0; i < 5; i++) bars.unshift(['2025-12-' + (30 - i), '10.000', '10.000', '10.000', '10.000', '1']);
  const c = classifyBar(bars, bars.length - 1, 'sh600000', '普通股');
  assert.equal(c.zt, true);
});
