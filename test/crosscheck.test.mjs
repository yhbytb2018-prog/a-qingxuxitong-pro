// 跨源一致性互证单测（src/crosscheck.js）
//
// 本文件守的核心不是"能算出差异"，而是**不撒谎**：
//   · 没拿到第二源 → unknown（绝不放行成 ok）
//   · 样本不足     → skip（绝不下"一致"结论）
//   · 覆盖不了的部分 → 明确披露"未核对"，不混进"已核对"
//   · 阈值只能有一个出处；不自动改数（只标记）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  num, normalizeName, normalizePrimaryName, crossCheck, summarizeCrossCheck,
  DIVERGENCE_RULES, XCHECK_LEVEL, SW2THS_ALIAS,
} from '../src/crosscheck.js';

// ── num：与 dirty.js 同款陷阱（+[] === 0） ──────────────────────────────
test('num：拒 +[] / +{} / +null / +"" 陷阱（不得变 0）', () => {
  assert.equal(num([]), null);
  assert.equal(num({}), null);
  assert.equal(num(null), null);
  assert.equal(num(undefined), null);
  assert.equal(num(''), null);
  assert.equal(num(true), null);
  assert.equal(num('  '), null);
});

test('num：接受 number 与数字字符串，0 是合法值', () => {
  assert.equal(num(0), 0);
  assert.equal(num(-1.5), -1.5);
  assert.equal(num('4.63'), 4.63);
  assert.equal(num(' 2 '), 2);
  assert.equal(num('abc'), null);
  assert.equal(num(NaN), null);
  assert.equal(num(Infinity), null);
});

// ── normalizeName：不猜、不兜底 ─────────────────────────────────────────
test('normalizeName：收录的映射返回同一可比键', () => {
  assert.equal(normalizeName('白酒Ⅱ'), '白酒');
  assert.equal(normalizeName('生物制品'), '生物制品');
  assert.equal(normalizeName('普钢'), '钢铁');
  assert.equal(normalizeName('城商行Ⅱ'), '银行');
});

test('normalizeName：未收录名称返回 null（不得兜底成同名）', () => {
  assert.equal(normalizeName('肿瘤疫苗'), null);   // 概念板块，非行业
  assert.equal(normalizeName('宁夏'), null);       // 地区板块
  assert.equal(normalizeName(''), null);
  assert.equal(normalizeName(null), null);
  assert.equal(normalizeName(undefined), null);
  assert.equal(normalizeName('不存在的行业XYZ'), null);
});

// ★ 本轮实测踩到的设计坑：别名表方向是「申万二级 → 同花顺」，只该用于**第二源**。
//   若拿它查主源，同花顺独有的名字（白酒/银行/钢铁/半导体…）会被判"不可比"，
//   可比数腰斩 → 直接掉进 skip（覆盖率被人为砍半）。故两者必须分开。
test('归一化：主源名即可比键（不得拿第二源的别名表去查主源）', () => {
  // 同花顺独有、不在别名表左键上的名字
  for (const n of ['白酒', '银行', '钢铁', '煤炭开采加工', '半导体', '游戏']) {
    assert.equal(normalizeName(n), null, `${n} 不该被别名表归一（它是主源侧名字）`);
    assert.equal(normalizePrimaryName(n), n, `${n} 作为主源名应原样保留`);
  }
  assert.equal(normalizePrimaryName(' 生物制品 '), '生物制品');
  assert.equal(normalizePrimaryName(''), null);
  assert.equal(normalizePrimaryName(null), null);
});

test('归一化：主源不查表 → 同花顺独有行业仍进入可比集', () => {
  const primary = [
    { name: '白酒', change_pct: -0.8 }, { name: '银行', change_pct: 0.31 },
    { name: '钢铁', change_pct: -0.42 }, { name: '煤炭开采加工', change_pct: 0.95 },
    { name: '半导体', change_pct: -1.8 }, { name: '游戏', change_pct: 1.2 },
    ...FILLER_POOL.slice(0, 4).map((n) => ({ name: n, change_pct: 0.5 })),
  ];
  const secondary = [
    { name: '白酒Ⅱ', change_pct: -0.85 }, { name: '国有大型银行Ⅱ', change_pct: 0.28 },
    { name: '普钢', change_pct: -0.40 }, { name: '煤炭开采', change_pct: 0.92 },
    // ⚠ 申万二级里**没有**「半导体」这个板块（是 电子化学品/元件 等），故它天然不可比
    { name: '游戏Ⅱ', change_pct: 1.15 },
    ...FILLER_POOL.slice(0, 4).map((n) => ({ name: n, change_pct: 0.5 })),
  ];
  const r = crossCheck(primary, secondary);
  // 主源 6 个独有里 5 个可比（半导体在申万侧不存在）+ 填充 4 个 = 9
  assert.equal(r.comparable, 9, '主源独有名字应可比（旧实现拿第二源字典查主源 → 只算得出 4）');
  assert.equal(r.status, XCHECK_LEVEL.OK);
  // 关键回归：可比集里必须出现同花顺独有名字（证明没有因为"不在别名表左键"而被剔除）
  const keys = r.rows.map((x) => x.industry);
  for (const n of ['白酒', '银行', '钢铁', '煤炭开采加工', '游戏']) {
    assert.ok(keys.includes(n), `${n} 应在可比集内`);
  }
});

test('别名表：左右键均为非空字符串，且右值集合可复现（无空串/无 undefined）', () => {
  const rightValues = new Set();
  for (const [k, v] of Object.entries(SW2THS_ALIAS)) {
    assert.ok(typeof k === 'string' && k.length > 0, `左键非法: ${k}`);
    assert.ok(typeof v === 'string' && v.length > 0, `右键非法: ${k} → ${v}`);
    rightValues.add(v);
  }
  // 右值集合必须非空，且映射确实存在一对多（否则地别名表无意义）
  assert.ok(rightValues.size > 0, '别名表不得为空');
  assert.ok(rightValues.size < Object.keys(SW2THS_ALIAS).length, '必须存在一对多映射（否则表是多余的）');
});

// ── 断言辅助：构造足够多**不同名**可比行业（prim 是 Map，重名会被折叠） ──
// 用别名表里的一对多关系（普钢/特钢Ⅱ/冶钢原料 → 钢铁）补齐到 MIN_COMPARABLE 之上。
// ⚠ 填充项必须**避开 target 的名字**，否则 target 会与填充项同名 → Map 折叠/桶混合，
//   表现为"冲突莫名变 0"或"中位数被污染"（本轮实测踩到）。
const FILLER_POOL = ['医疗服务', '化学制药', '农产品加工', '小家电', '贵金属',
  '工程机械', '医药商业', '电池', '造纸', '风电设备', '光伏设备', '医疗器械'];
function padPairs(target, targetSecondary, need = 8) {
  const p = [], s = [];
  const pool = FILLER_POOL.filter((n) => n !== target.name);
  for (let i = 0; i < need; i++) {
    const n = pool[i];
    p.push({ name: n, change_pct: 0.5 });
    s.push({ name: n, change_pct: 0.5 });   // 同名映射（池内名字在表里都是自映射）
  }
  p.push(target);
  s.push(targetSecondary);
  return [p, s];
}

// ── 未取到第二源 → unknown（绝不 ok） ─────────────────────────────────
test('互证：第二源缺失 → unknown，且明确是"没检查"', () => {
  const r = crossCheck([{ name: '生物制品', change_pct: 4.63 }], null);
  assert.equal(r.status, XCHECK_LEVEL.UNKNOWN);
  assert.equal(r.comparable, 0);
  assert.equal(r.coverage, null);
  assert.match(r.note, /没检查/);
  assert.match(r.note, /不等于/);
});

test('互证：主源为空数组同样 → unknown（空 ≠ 一致）', () => {
  const r = crossCheck([], [{ name: '生物制品', change_pct: 4.18 }]);
  assert.equal(r.status, XCHECK_LEVEL.UNKNOWN);
});

test('互证：两源都为空 → unknown，不得因为"都没数据"判 ok', () => {
  const r = crossCheck([], []);
  assert.equal(r.status, XCHECK_LEVEL.UNKNOWN);
});

// ── 样本不足 → skip ────────────────────────────────────────────────────
test('互证：可比样本低于下限 → skip，不得下"一致"结论', () => {
  const primary = Array.from({ length: 90 }, (_, i) => ({ name: '行业' + i, change_pct: 1 }));
  const secondary = [{ name: '生物制品', change_pct: 4.18 }];   // 只 1 个可比
  const r = crossCheck(primary, secondary);
  assert.equal(r.status, XCHECK_LEVEL.SKIP);
  assert.ok(r.comparable < DIVERGENCE_RULES.MIN_COMPARABLE);
  assert.match(r.note, /样本不足/);
});

// ── 一致 → ok，但覆盖率必须如实披露 ─────────────────────────────────────
test('互证：两源一致 → ok，且覆盖率如实披露（未覆盖部分不算已核对）', () => {
  const primary = [
    { name: '生物制品', change_pct: 4.63 }, { name: '医疗服务', change_pct: 2.10 },
    { name: '化学制药', change_pct: 1.55 }, { name: '白酒', change_pct: -0.80 },
    { name: '银行', change_pct: 0.31 }, { name: '钢铁', change_pct: -0.42 },
    { name: '煤炭开采加工', change_pct: 0.95 }, { name: '电池', change_pct: -1.20 },
    { name: '光伏设备', change_pct: -2.05 }, { name: '半导体', change_pct: -1.80 },
  ];
  const secondary = [
    { name: '生物制品', change_pct: 4.18 }, { name: '医疗服务', change_pct: 2.05 },
    { name: '化学制药', change_pct: 1.50 }, { name: '白酒Ⅱ', change_pct: -0.85 },
    { name: '国有大型银行Ⅱ', change_pct: 0.28 }, { name: '普钢', change_pct: -0.40 },
    { name: '煤炭开采', change_pct: 0.92 }, { name: '电池', change_pct: -1.18 },
    { name: '光伏设备', change_pct: -2.00 }, { name: '半导体', change_pct: -1.75 },
  ];
  const r = crossCheck(primary, secondary);
  assert.equal(r.status, XCHECK_LEVEL.OK);
  assert.equal(r.conflictCount, 0);
  assert.equal(r.divergeCount, 0);
  assert.equal(r.comparable, 9, '半导体不在别名表 → 不可比；其余 9 个可比');
  assert.ok(r.coverage > 0 && r.coverage < 1);
  assert.ok(r.maxAbsDiff <= DIVERGENCE_RULES.ABS_DIVERGE);
  assert.match(r.note, /一致/);
  assert.match(r.note, /未核对/);        // 覆盖率披露措辞
});

test('互证：覆盖率 <1 时必须披露覆盖率数值（不得让人以为全查过）', () => {
  const primary = [
    ...Array.from({ length: 30 }, (_, i) => ({ name: '未收录行业' + i, change_pct: 1 })),
    ...Array.from({ length: 10 }, (_, i) => ({ name: '生物制品', change_pct: 4.18 })),
  ];
  const secondary = [{ name: '生物制品', change_pct: 4.18 }];
  const r = crossCheck(primary, secondary);
  assert.equal(r.comparable, 1);
  assert.ok(r.coverage < 0.5);
});

// ── 超阈值 → diverge ───────────────────────────────────────────────────
test('互证：绝对差超阈值（正常带之外）→ diverge', () => {
  const [p, s] = padPairs({ name: '生物制品', change_pct: 9.0 }, { name: '生物制品', change_pct: 4.0 });
  const r = crossCheck(p, s);
  assert.equal(r.status, XCHECK_LEVEL.DIVERGE);
  assert.equal(r.divergeCount, 1);
  assert.equal(r.conflictCount, 0);
  assert.ok(r.flagged.length >= 1);
  assert.equal(r.flagged[0].industry, '生物制品');
});

test('互证：相对阈值只在"两边都有量级"时生效（近持平不报警）', () => {
  // 主源 5.0%，第二源 1.2% → 两边都有量级，相对差 3.2 倍 → 应报
  const [p, s] = padPairs({ name: '生物制品', change_pct: 5.0 }, { name: '生物制品', change_pct: 1.2 });
  const r = crossCheck(p, s);
  assert.equal(r.divergeCount, 1, '两边有量级时相对阈值应生效');

  // ★ 近持平对（0.29% vs 1.84%）**不得**因小分母被误报——这正是本轮实测踩到的误报类。
  //   两边都是"基本不动"，比值虚高无信息量。
  const [p2, s2] = padPairs({ name: '小家电', change_pct: 0.29 }, { name: '小家电', change_pct: 1.84 });
  const r2 = crossCheck(p2, s2, { debias: false });
  const row = r2.rows.find((x) => x.industry === '小家电');
  assert.equal(row.relMeasurable, false, '较小一边 <1% → 相对判据不可用');
  assert.equal(row.level, XCHECK_LEVEL.OK, '两侧近持平不得报警（小分母放大＝噪声）');
});

test('互证：相对判据的可测性下限是 min(|a|,|b|) 而不是 max（防小分母误报）', () => {
  const [p, s] = padPairs({ name: '小家电', change_pct: 0.29 }, { name: '小家电', change_pct: 1.84 });
  const r = crossCheck(p, s, { debias: false });
  const row = r.rows.find((x) => x.industry === '小家电');
  assert.ok(row.rel > 1, `比值确实虚高（${row.rel}）`);
  assert.equal(row.relMeasurable, false);
});

// ── 去偏（系统性偏移）：本轮实测定标的核心 ─────────────────────────────
test('互证：两源存在**恒定偏置**时，去偏后判 ok（不得把方法论差异当源抽风）', () => {
  // 构造：第二源恒比主源高 0.5pp（两套指数构造不同，实测 ~0.3pp），无个别离群
  const names = ['白酒', '银行', '钢铁', '煤炭开采加工', '游戏', '医疗服务', '化学制药', '农产品加工'];
  const aliasOf = { 白酒: '白酒Ⅱ', 银行: '国有大型银行Ⅱ', 钢铁: '普钢', 煤炭开采加工: '煤炭开采', 游戏: '游戏Ⅱ' };
  const primary = names.map((n) => ({ name: n, change_pct: 1.0 }));
  const secondary = names.map((n) => ({ name: aliasOf[n] || n, change_pct: 1.5 }));  // 恒 +0.5
  const r = crossCheck(primary, secondary);
  assert.equal(r.offset, -0.5, '应识别出 −0.5pp 的系统性偏移');
  assert.equal(r.status, XCHECK_LEVEL.OK, '恒定偏置属于方法论差异，去偏后应判一致');
  assert.equal(r.divergeCount, 0);
});

test('互证：去偏后**仍能**抓到个别离群（去偏不等于把差异抹平）', () => {
  const names = ['白酒', '银行', '钢铁', '煤炭开采加工', '游戏', '医疗服务', '化学制药', '农产品加工'];
  const aliasOf = { 白酒: '白酒Ⅱ', 银行: '国有大型银行Ⅱ', 钢铁: '普钢', 煤炭开采加工: '煤炭开采', 游戏: '游戏Ⅱ' };
  const primary = names.map((n) => ({ name: n, change_pct: 1.0 }));
  const secondary = names.map((n) => ({ name: aliasOf[n] || n, change_pct: 1.5 }));
  // 只把「白酒」打成离群（主源 12% vs 第二源 ~1.5% 常态）
  primary[0] = { name: '白酒', change_pct: 12.0 };
  const r = crossCheck(primary, secondary);
  assert.equal(r.status, XCHECK_LEVEL.DIVERGE);
  assert.ok(r.flagged.some((x) => x.industry === '白酒'));
  // 原始值与偏离度都必须保留（可追溯）
  const row = r.rows.find((x) => x.industry === '白酒');
  assert.equal(row.primary, 12.0);
  assert.equal(row.secondary, 1.5);
  assert.ok(Math.abs(row.dev) > 5, `偏离度应很大（dev=${row.dev}）`);
});

test('互证：offsetRaw 字段如实披露原始偏移（即使 debias=false 也保留）', () => {
  const p = [{ name: '生物制品', change_pct: 1.0 }];
  const s = [{ name: '生物制品', change_pct: 1.5 }];
  const r = crossCheck(p, s, { debias: false });
  assert.equal(r.debiased, false);
  assert.equal(r.offset, 0);
  assert.equal(r.offsetRaw, -0.5, 'raw 偏移必须保留，便于审计');
});

// ── 方向相反 → conflict ────────────────────────────────────────────────
test('互证：方向相反且两边都超幅度下限 → conflict', () => {
  const [p1, s1] = padPairs({ name: '生物制品', change_pct: 3.0 }, { name: '生物制品', change_pct: -2.0 });
  const r1 = crossCheck(p1, s1);
  assert.equal(r1.conflictCount, 1);
  assert.equal(r1.flagged[0].level, XCHECK_LEVEL.CONFLICT);

  // 一正一负但幅度极小（+0.1 vs -0.1）→ 不算 conflict（噪声，不是"源失真"）
  const [p2, s2] = padPairs({ name: '生物制品', change_pct: 0.1 }, { name: '生物制品', change_pct: -0.1 });
  const r2 = crossCheck(p2, s2);
  assert.equal(r2.conflictCount, 0);
});

test('互证：冲突条数达到阈值 → 整体判 conflict 并写 staleReason', () => {
  const targets = [['生物制品', '生物制品'], ['医疗服务', '医疗服务'],
    ['化学制药', '化学制药'], ['白酒', '白酒Ⅱ']];
  const p = [], s = [];
  for (const [pn, sn] of targets) { p.push({ name: pn, change_pct: 5 }); s.push({ name: sn, change_pct: -5 }); }
  const fillers = ['农产品加工', '小家电', '贵金属', '工程机械', '医药商业', '电池'];
  for (const n of fillers) {
    p.push({ name: n, change_pct: 0.3 });
    s.push({ name: n, change_pct: 0.3 });
  }
  const r = crossCheck(p, s);
  assert.equal(r.status, XCHECK_LEVEL.CONFLICT);
  assert.ok(r.conflictCount >= DIVERGENCE_RULES.CONFLICT_ALARM_COUNT);
  assert.ok(r.staleReason && /cross-source/.test(r.staleReason));
});

test('互证：ok 时不写 staleReason（不得凭空产生告警）', () => {
  const p = [], s = [];
  for (const n of FILLER_POOL.slice(0,8)) {
    p.push({ name: n, change_pct: 4.2 });
    s.push({ name: n, change_pct: 4.18 });
  }
  const r = crossCheck(p, s);
  assert.equal(r.status, XCHECK_LEVEL.OK);
  assert.equal(r.staleReason, null);
});

// ── 一对多：申万多二级 → 同一个同花顺行业，取中位数 ──────────────────────
test('互证：申万侧一对多用中位数（不引入权重假设）', () => {
  const p = [{ name: '钢铁', change_pct: 1.0 }];
  const s = [
    { name: '普钢', change_pct: 0.5 }, { name: '特钢Ⅱ', change_pct: 1.0 }, { name: '冶钢原料', change_pct: 2.0 },
  ];
  for (let i = 0; i < 8; i++) {
    p.push({ name: FILLER_POOL[i], change_pct: 0.2 });
    s.push({ name: FILLER_POOL[i], change_pct: 0.2 });
  }
  const r = crossCheck(p, s);
  const steel = r.rows.find((x) => x.industry === '钢铁');
  assert.ok(steel, '钢铁应可比');
  assert.equal(steel.secondary, 1.0, '中位数应为 1.0（0.5/1.0/2.0 的中位）');
  assert.equal(steel.secondarySamples, 3);
});

// ── 不自动改数 ─────────────────────────────────────────────────────────
test('互证：结果只做标记，绝不回写/修改原始值', () => {
  const primary = [{ name: '生物制品', change_pct: 9.0 }];
  const secondary = [{ name: '生物制品', change_pct: 1.0 }];
  const p0 = JSON.parse(JSON.stringify(primary));
  const s0 = JSON.parse(JSON.stringify(secondary));
  crossCheck(primary, secondary);
  assert.deepEqual(primary, p0, '主源输入不得被修改');
  assert.deepEqual(secondary, s0, '第二源输入不得被修改');
});

test('互证：行里同时保留两源原始值（可追溯，不合并成单一数）', () => {
  const [p, s] = padPairs({ name: '生物制品', change_pct: 4.63 }, { name: '生物制品', change_pct: 4.18 });
  const r = crossCheck(p, s);
  const row = r.rows.find((x) => x.industry === '生物制品');
  assert.equal(row.primary, 4.63);
  assert.equal(row.secondary, 4.18);
  assert.equal(row.diff, 0.45);
  assert.ok(row.primaryRaw);
});

// ── 阈值唯一出处 ───────────────────────────────────────────────────────
test('阈值：DIVERGENCE_RULES 冻结且含全部判据', () => {
  for (const k of ['ABS_DIVERGE', 'REL_DIVERGE', 'OPPOSITE_MIN_ABS', 'MIN_COMPARABLE', 'CONFLICT_ALARM_COUNT']) {
    assert.ok(typeof DIVERGENCE_RULES[k] === 'number', `缺阈值 ${k}`);
  }
  assert.ok(Object.isFrozen(DIVERGENCE_RULES), 'DIVERGENCE_RULES 必须冻结');
});

test('分级常量：unknown 必须是独立一级（不得与 ok 合并）', () => {
  assert.equal(XCHECK_LEVEL.UNKNOWN, 'unknown');
  assert.notEqual(XCHECK_LEVEL.UNKNOWN, XCHECK_LEVEL.OK);
  assert.equal(Object.isFrozen(XCHECK_LEVEL), true);
});

// ── 全档汇总 ───────────────────────────────────────────────────────────
test('汇总：按状态计数 + 冲突日/未知日可定位', () => {
  const perDay = [
    { date: 'd1', status: 'ok', comparable: 40, conflictCount: 0, divergeCount: 0, coverage: 0.44 },
    { date: 'd2', status: 'conflict', comparable: 40, conflictCount: 4, divergeCount: 0, coverage: 0.44 },
    { date: 'd3', status: 'unknown', comparable: 0, conflictCount: 0, divergeCount: 0, coverage: null },
  ];
  const s = summarizeCrossCheck(perDay);
  assert.equal(s.days, 3);
  assert.equal(s.byStatus.ok, 1);
  assert.equal(s.byStatus.conflict, 1);
  assert.equal(s.byStatus.unknown, 1);
  assert.deepEqual(s.conflictDates, ['d2']);
  assert.deepEqual(s.unknownDates, ['d3']);
  assert.equal(s.conflictTotal, 4);
});

test('汇总：空输入不崩，返回零值而非 null 冒充', () => {
  const s = summarizeCrossCheck([]);
  assert.equal(s.days, 0);
  assert.equal(s.conflictTotal, 0);
  assert.equal(s.avgCoverage, null);
});
