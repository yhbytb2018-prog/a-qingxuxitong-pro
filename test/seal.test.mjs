// 封板率口径回归测试（seal_pct / zb_pct / seal_den）
// 背景：历史 bug——字段 zbl_pct 存的是封板率 zt/(zt+zb)，报告却按炸板率渲染并取补，
// 2026-09-30 把 81.3% 的封板率显示成「炸板率 18.8%」。本文件锁死口径，防回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 复刻 src/sources.js 的口径（唯一出处口径变更时本测试会失败，提示同步）
const sealOf = (zt, zb) => (zt != null && zb != null && zt + zb > 0)
  ? Math.round((zt / (zt + zb)) * 1000) / 10 : null;
const zbOf = (seal) => seal != null ? Math.round((100 - seal) * 10) / 10 : null;

test('封板率口径：分母是「盘中触板个股」= 涨停 + 炸板（市场通用算法）', () => {
  // 2026-09-30 真实数据：涨停 52、炸板 12 → 触板 64
  assert.equal(sealOf(52, 12), 81.3);          // 用户报告里的 81%（≈81.3%）就是这个
  assert.equal(zbOf(81.3), 18.7);
  assert.notEqual(sealOf(52, 12), 18.8);       // 绝不等于旧的 zbl_pct=18.8（那是补数被错标）
});

test('封板率与炸板率互余为 100（同一分母，不各自现算）', () => {
  for (const [zt, zb] of [[52, 12], [93, 19], [39, 48], [32, 24], [103, 25], [1, 0], [0, 5]]) {
    const seal = sealOf(zt, zb), zb2 = zbOf(seal);
    assert.equal(Math.round((seal + zb2) * 10) / 10, 100, `${zt}/${zb} 互补失败`);
  }
});

test('封板率边界：无触板个股 -> null（不编造 0 或 100）', () => {
  assert.equal(sealOf(0, 0), null);
  assert.equal(sealOf(null, 12), null);
  assert.equal(sealOf(52, null), null);
});

test('封板率极端：全部封板 100 / 全部炸板 0', () => {
  assert.equal(sealOf(50, 0), 100);
  assert.equal(sealOf(0, 50), 0);
});

test('封板率不等于涨停占跌停比（不能拿 limitUp/(limitUp+limitDown) 冒充）', () => {
  // 2026-09-30：涨停52/跌停9 → 85.2，与封板率 81.3 不同，二者不可混用
  assert.notEqual(sealOf(52, 12), Math.round((52 / (52 + 9)) * 1000) / 10);
});

test('存档回填：18 天有涨停池数据的日子 seal_pct 自洽且与 zt/(zt+zb) 一致', () => {
  const a = JSON.parse(readFileSync(new URL('../data/archive.json', import.meta.url), 'utf8'));
  let checked = 0;
  for (const d of a.all_days) {
    const s = d.summary || {};
    if (s.zt_count == null || s.zb_count == null || s.zt_count + s.zb_count <= 0) continue;
    assert.equal(s.seal_den, s.zt_count + s.zb_count, `${d.trade_date} seal_den 错`);
    assert.equal(s.seal_pct, sealOf(s.zt_count, s.zb_count), `${d.trade_date} seal_pct 错`);
    assert.equal(s.zb_pct, zbOf(s.seal_pct), `${d.trade_date} zb_pct 错`);
    assert.equal(Math.round((s.seal_pct + s.zb_pct) * 10) / 10, 100, `${d.trade_date} 不互补`);
    checked++;
  }
  assert.ok(checked >= 18, `应至少有 18 天可校验，实际 ${checked}`);
});

test('存档 2026-09-30 具体核对：封板率 81.3%（不是被错标的 18.8%）', () => {
  const a = JSON.parse(readFileSync(new URL('../data/archive.json', import.meta.url), 'utf8'));
  const d = a.all_days.find((x) => x.trade_date === '2026-09-30');
  assert.ok(d, '找不到 2026-09-30');
  const s = d.summary;
  assert.equal(s.zt_count, 52);
  assert.equal(s.zb_count, 12);
  assert.equal(s.seal_den, 64);
  assert.equal(s.seal_pct, 81.3);
  assert.equal(s.zb_pct, 18.7);
  // 旧字段名 zbl_pct 保留为「历史原值」（由 100×zb/(zb+zt) 独立舍入得到，可能与 100−seal_pct 差 0.1）
  // 保留原值而不覆盖，是为了让老存档可与历史报告逐位复核；新代码一律读 seal_pct。
  assert.equal(s.zbl_pct, 18.8);
  // 差异只可能是舍入（两条舍入路径不同），必须 ≤0.1
  assert.ok(Math.abs(s.zbl_pct - s.zb_pct) < 0.11, `旧值与新值差 ${Math.abs(s.zbl_pct - s.zb_pct)} ≥ 0.11`);
});

test('源码守卫：sources.js 中 seal_pct 用涨停做分子（禁止退回 zb/(zb+zt)）', () => {
  const src = readFileSync(new URL('../src/sources.js', import.meta.url), 'utf8');
  assert.ok(/const seal_pct = [^;]*\(zt \/ \(zb \+ zt\)\)/.test(src),
    'seal_pct 必须 = zt/(zb+zt)*100（封板率），不得为 zb/(zb+zt)');
});

test('源码守卫：报告端不得再把封板率当炸板率渲染', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  // 旧 bug 形态：`炸板率 ${zbl}%（…封板率 ${100 - zbl}%`
  assert.ok(!/炸板率\s*\$\{[^}]*zbl[^}]*\}[\s\S]{0,120}?100\s*-\s*zbl/.test(app),
    'app.js 仍存在把 zbl_pct 当炸板率并取补的渲染');
  // 新形态必须存在
  assert.ok(/封板率 \$\{sealPct\}%/.test(app), 'app.js 应改为渲染「封板率 ${sealPct}%」');
});

test('源码守卫：scorePnl 按封板率阈值判分（不得用炸板率阈值判封板率）', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.ok(/function scorePnl\(zt, dt, sealPct, mlb, lb2n\)/.test(app),
    'scorePnl 第 3 参应命名为 sealPct');
  assert.ok(/sealPct >= 90 \? 6 : sealPct >= 80 \? 0 : -8/.test(app),
    'scorePnl 应按封板率阈值（≥90 优秀 / ≥80 中等 / <80 弱）判分');
});
