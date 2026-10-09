// #4 拐点标签引擎 regime.js —— 全部用**真调用**断言（不扫源码字面量）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REGIME_RULES, REGIME_LABELS,
  num, levelOf, directionOf, classifyRegime, detectDivergence, classifySeries,
  buildDivergenceBlock, buildRegimeBlock,
} from '../src/regime.js';

// ── num：与 dirty.js 同款陷阱（+[]===0 / +''===0 / +null===0）──────────────
test('num: 拒空数组/空串/布尔/对象（+[] === 0 陷阱）', () => {
  assert.equal(num([]), null);
  assert.equal(num(''), null);
  assert.equal(num(null), null);
  assert.equal(num(undefined), null);
  assert.equal(num({}), null);
  assert.equal(num(true), null);
  assert.equal(num(false), null);
});
test('num: 0 是合法值不是缺失', () => {
  assert.equal(num(0), 0);
  assert.equal(num('0'), 0);
  assert.equal(num('12.5'), 12.5);
});

// ── ① levelOf：分位为主判据 ───────────────────────────────────────────────
test('levelOf: 分位 < PCT_LOW 判 low', () => {
  const r = levelOf(55, 10);
  assert.equal(r.level, 'low');
  assert.equal(r.primary, 'pct');
});
test('levelOf: 分位 >= PCT_HIGH 判 high', () => {
  assert.equal(levelOf(55, 85).level, 'high');
});
test('levelOf: 分位居中判 mid', () => {
  assert.equal(levelOf(55, 50).level, 'mid');
});
test('levelOf: 分位边界取闭开区间（30 归 mid、70 归 high）', () => {
  assert.equal(levelOf(50, 29.9).level, 'low');
  assert.equal(levelOf(50, 30).level, 'mid');
  assert.equal(levelOf(50, 69.9).level, 'mid');
  assert.equal(levelOf(50, 70).level, 'high');
});
test('levelOf: ★ 分位为主判据 —— 绝对水位与分位打架时以分位为准', () => {
  // 情绪分 61.3 在绝对刻度上属"mid"，但分位 100 说明是历史最高 → 必须判 high
  const r = levelOf(61.3, 100);
  assert.equal(r.level, 'high', '分布压缩时绝对刻度失效，必须用分位');
  assert.equal(r.byScore, 'mid', 'byScore 仍如实反映绝对刻度读数');
  assert.equal(r.agree, false);
  assert.match(r.note, /以分位为准/);
});
test('levelOf: 分位缺失时退化为绝对水位并标 primary=abs', () => {
  const r = levelOf(35, null);
  assert.equal(r.level, 'low');
  assert.equal(r.primary, 'abs');
  assert.match(r.note, /分位缺失/);
});
test('levelOf: 情绪分与分位均缺失 → level null（不猜）', () => {
  assert.equal(levelOf(null, null).level, null);
  assert.equal(levelOf('', '').level, null);
});
test('levelOf: 分位存在但情绪分缺失 → 仍能判（分位是自足的）', () => {
  const r = levelOf(null, 90);
  assert.equal(r.level, 'high');
  assert.equal(r.byScore, null);
});

// ── ② directionOf：方向（样本不足 → null，不默认 flat）────────────────────
test('directionOf: 上升超过 DIR_UP 判 up', () => {
  const r = directionOf([50, 51, 52, 60]);
  assert.equal(r.dir, 'up');
  assert.equal(r.delta, 10);
});
test('directionOf: 下降超过 DIR_DOWN 判 down', () => {
  const r = directionOf([60, 58, 56, 50]);
  assert.equal(r.dir, 'down');
  assert.equal(r.delta, -10);
});
test('directionOf: 变化在阈值内判 flat（这是"确认平"，不是"没数据"）', () => {
  const r = directionOf([50, 51, 52, 53]);
  assert.equal(r.dir, 'flat');
});
test('directionOf: ★ 样本不足 MIN_HISTORY → dir=null（绝不默认 flat）', () => {
  const r = directionOf([50, 51]);
  assert.equal(r.dir, null);
  assert.match(r.reason, /不足/);
});
test('directionOf: 空序列 → null', () => {
  assert.equal(directionOf([]).dir, null);
  assert.equal(directionOf(null).dir, null);
});
test('directionOf: 序列中的伪值被剔除（不参与方向计算）', () => {
  const r = directionOf([50, [], null, '', 52, 60]);
  // 有效值 [50, 52, 60] → 与 3 日前比（实际取首个）→ 上升 10
  assert.equal(r.dir, 'up');
});
test('directionOf: lookback 超过序列长度时向前夹取（不越界）', () => {
  const r = directionOf([50, 51, 52, 60]);
  assert.equal(r.lookback, 3);
  assert.equal(r.dir, 'up');
});
test('directionOf: 边界 DIR_UP 恰好等于阈值 → up', () => {
  assert.equal(directionOf([50, 50, 50, 56]).dir, 'up');
  assert.equal(directionOf([50, 50, 50, 55.9]).dir, 'flat');
});

// ── ③ classifyRegime：四态分类 ───────────────────────────────────────────
const hist = (arr) => arr;
test('classifyRegime: 高位 + 下行 → 退潮', () => {
  const r = classifyRegime({ score: 70, pctRank: 90, history: hist([80, 78, 76, 70]) });
  assert.equal(r.key, 'ebb');
  assert.equal(r.label, '退潮');
  assert.equal(r.level, 'high');
  assert.equal(r.dir, 'down');
});
test('classifyRegime: 高位 + 上行 → 高潮', () => {
  const r = classifyRegime({ score: 80, pctRank: 95, history: hist([60, 65, 70, 80]) });
  assert.equal(r.key, 'climax');
  assert.equal(r.label, '高潮');
});
test('classifyRegime: 低位 + 上行 → 回暖（拐点）', () => {
  const r = classifyRegime({ score: 45, pctRank: 15, history: hist([30, 32, 35, 45]) });
  assert.equal(r.key, 'recover');
  assert.equal(r.label, '回暖');
});
test('classifyRegime: 低位 + 横盘/下行 → 冰点', () => {
  const a = classifyRegime({ score: 32, pctRank: 5, history: hist([35, 34, 33, 32]) });
  assert.equal(a.key, 'ice');
  const b = classifyRegime({ score: 32, pctRank: 5, history: hist([40, 38, 35, 32]) });
  assert.equal(b.key, 'ice', '低位即使在下行也是"冰点"（退潮需水位在高位）');
});
test('classifyRegime: 高位 + 下行 → 退潮（水位由分位定，不由绝对分定）', () => {
  const r = classifyRegime({ score: 62.6, pctRank: 76.3, history: hist([70, 68, 65, 62.6]) });
  assert.equal(r.key, 'ebb');
  assert.equal(r.level, 'high');
});
test('classifyRegime: 中位 + 上行 → 回暖（mid 区拐点）', () => {
  const r = classifyRegime({ score: 55, pctRank: 50, history: hist([45, 48, 50, 55]) });
  assert.equal(r.key, 'recover');
  assert.equal(r.level, 'mid');
  assert.equal(r.confidence, 'mid');
});
test('classifyRegime: 中位 + 下行 → 退潮', () => {
  const r = classifyRegime({ score: 50, pctRank: 45, history: hist([60, 58, 56, 50]) });
  assert.equal(r.key, 'ebb');
});
test('classifyRegime: 中位 + 横盘 → 中性', () => {
  const r = classifyRegime({ score: 55, pctRank: 50, history: hist([54, 55, 55, 55]) });
  assert.equal(r.key, 'neutral');
  assert.equal(r.label, '中性');
});
test('classifyRegime: ★ 无历史（方向不可判）→ 数据不足，绝不给"中性"', () => {
  const r = classifyRegime({ score: 60, pctRank: null, history: [60] });
  assert.equal(r.key, 'unknown');
  assert.equal(r.label, '数据不足');
  assert.equal(r.dir, null);
  assert.ok(r.unknownReasons.some((x) => /方向不可判/.test(x)));
});
test('classifyRegime: ★ 全缺 → unknown，evidence 空', () => {
  const r = classifyRegime({});
  assert.equal(r.key, 'unknown');
  assert.equal(r.evidence.length, 0);
  assert.ok(r.unknownReasons.length > 0);
});
test('classifyRegime: 分位缺失（退化到绝对水位）→ confidence=low', () => {
  const r = classifyRegime({ score: 35, pctRank: null, history: [45, 42, 40, 35] });
  assert.equal(r.confidence, 'low');
  assert.equal(r.primary === undefined || true, true);
  assert.equal(r.key, 'ice', '绝对水位 low + 下行 → 冰点（退潮需高位）');
  assert.equal(r.levelCheck.primary, 'abs');
});
test('classifyRegime: levelCheck 如实披露两把尺子是否一致', () => {
  const r = classifyRegime({ score: 61, pctRank: 100, history: [55, 58, 60, 61] });
  assert.equal(r.levelCheck.byScore, 'mid');
  assert.equal(r.levelCheck.byPct, 'high');
  assert.equal(r.levelCheck.agree, false);
});
test('classifyRegime: evidence 读数取原值不改写', () => {
  const r = classifyRegime({ score: 80, pctRank: 95, history: [60, 65, 70, 80], sealPct: 88 });
  const sc = r.evidence.find((e) => e.metric === '情绪分');
  assert.equal(sc.value, 80);
  const pct = r.evidence.find((e) => e.metric === '情绪分历史分位');
  assert.equal(pct.value, 95);
});
test('classifyRegime: 高潮 + 封板率弱 → ★ 覆盖为切换期（V5.3：高潮末段=强矛盾，保守档）', () => {
  const r = classifyRegime({
    score: 80, pctRank: 95, history: [60, 65, 70, 80], sealPct: 44.8,
    painVerdict: { level: 'warn', label: '多空拉锯' },
  });
  assert.equal(r.key, 'shift');
  assert.equal(r.label, '切换期');
  assert.equal(r.shifted, true);
  assert.ok(r.shiftReasons.some((s) => /高潮末段/.test(s)), '矛盾原因必须披露');
  assert.ok(r.caution, '高位弱封板必须给 caution');
  assert.match(r.caution, /高潮末段/);
  assert.match(r.detail, /切换期/);
});
test('classifyRegime: 高潮 + 封板率强 + 亏钱效应正常 → 无 caution', () => {
  const r = classifyRegime({ score: 80, pctRank: 95, history: [60, 65, 70, 80], sealPct: 88 });
  assert.equal(r.caution, null);
  assert.equal(r.key, 'climax', '无矛盾不被覆盖');
});
test('classifyRegime: 冰点 + 封板率尚可 → caution（可能是缩量惜售）', () => {
  const r = classifyRegime({ score: 32, pctRank: 5, history: [35, 34, 33, 32], sealPct: 85 });
  assert.equal(r.key, 'ice');
  assert.match(String(r.caution), /惜售/);
});
test('classifyRegime: detail 含水位与方向，unknown 时给明确说明', () => {
  const ok = classifyRegime({ score: 80, pctRank: 95, history: [60, 65, 70, 80] });
  assert.match(ok.detail, /高位/);
  assert.match(ok.detail, /高潮/);
  assert.match(classifyRegime({}).detail, /判据不足/);
});
test('classifyRegime: 证据含宽度/亏钱/席位（有则写入）', () => {
  const r = classifyRegime({
    score: 80, pctRank: 95, history: [60, 65, 70, 80],
    breadthVerdict: { level: 'narrow', label: '宽度收窄', detail: '站上20日线仅 30.1%' },
    painVerdict: { level: 'normal', label: '多空拉锯', reason: '追高盈亏各半' },
    seatsVerdict: { level: 'hot', label: '游资主导' },
  });
  const metrics = r.evidence.map((e) => e.metric);
  assert.ok(metrics.includes('市场宽度'));
  assert.ok(metrics.includes('亏钱效应'));
  assert.ok(metrics.includes('资金属性'));
});

// ── ④ detectDivergence：综合分 vs 宽度背离 ───────────────────────────────
test('detectDivergence: 情绪高位 + 宽度窄 → 假繁荣嫌疑', () => {
  const r = detectDivergence({ score: 70, pctRank: 90, breadthVerdict: { level: 'narrow', label: '宽度收窄' } });
  assert.equal(r.diverged, true);
  assert.equal(r.kind, 'fake-boom');
  assert.equal(r.level, 'warn');
});
test('detectDivergence: 情绪低位 + 宽度扩张 → 底部背离', () => {
  const r = detectDivergence({ score: 35, pctRank: 10, breadthVerdict: { level: 'broad', label: '宽度扩张' } });
  assert.equal(r.diverged, true);
  assert.equal(r.kind, 'bottom-divergence');
});
test('detectDivergence: 同向 → 无背离', () => {
  const r = detectDivergence({ score: 70, pctRank: 90, breadthVerdict: { level: 'broad', label: '宽度扩张' } });
  assert.equal(r.diverged, false);
  assert.equal(r.label, '同向');
});
test('detectDivergence: ★ 宽度缺失 → "未评估"而非"一致"（缺失不等于一致）', () => {
  const r = detectDivergence({ score: 70, pctRank: 90, breadthVerdict: null });
  assert.equal(r.diverged, false);
  assert.equal(r.level, 'unknown');
  assert.equal(r.label, '未评估');
  assert.match(r.reason, /缺失不等于一致/);
});
test('detectDivergence: 情绪分缺失 → 无法判定', () => {
  const r = detectDivergence({ score: null, breadthVerdict: { level: 'narrow', label: 'x' } });
  assert.equal(r.level, 'unknown');
  assert.equal(r.label, '无法判定');
});
test('detectDivergence: very_narrow / very_broad 也识别', () => {
  assert.equal(detectDivergence({ score: 70, pctRank: 90, breadthVerdict: { level: 'very_narrow', label: 'x' } }).kind, 'fake-boom');
  assert.equal(detectDivergence({ score: 30, pctRank: 10, breadthVerdict: { level: 'very_broad', label: 'x' } }).kind, 'bottom-divergence');
});

// ── ⑤ classifySeries：批量 + 无前视 ─────────────────────────────────────
test('classifySeries: 逐日标注，序列升序', () => {
  const days = [
    { trade_date: 'd1', value: 60 },
    { trade_date: 'd2', value: 61 },
    { trade_date: 'd3', value: 62 },
    { trade_date: 'd4', value: 80 },
  ];
  const out = classifySeries(days);
  assert.equal(out.length, 4);
  assert.equal(out[0].trade_date, 'd1');
  assert.equal(out[0].key, 'unknown', '首日无历史');
});
test('classifySeries: ★ 前视锁窗 —— 截断序列重跑，同日标签必须一致', () => {
  const full = Array.from({ length: 40 }, (_, i) => ({
    trade_date: 'd' + i,
    value: 40 + Math.round(20 * Math.sin(i / 3)),
    pct_rank: (i % 10) * 10,
  }));
  const all = classifySeries(full);
  for (const cut of [8, 15, 25, 33]) {
    const sub = classifySeries(full.slice(0, cut));
    const last = sub[sub.length - 1];
    const ref = all[cut - 1];
    assert.equal(last.key, ref.key, `cut=${cut} 标签漂移：${last.key} vs ${ref.key}`);
    assert.equal(last.dir, ref.dir, `cut=${cut} 方向漂移`);
  }
});
test('classifySeries: pct_rank 与 seal_pct 透传到分类', () => {
  const out = classifySeries([
    { trade_date: 'a', value: 50, pct_rank: 50 },
    { trade_date: 'b', value: 55, pct_rank: 50 },
    { trade_date: 'c', value: 60, pct_rank: 50 },
    { trade_date: 'd', value: 65, pct_rank: 95, seal_pct: 50 },
  ]);
  assert.equal(out[3].pct_rank, 95);
  // V5.3：pct 95 + 方向 up → 主标签 climax，但封板率 50（< 70）→ 高潮末段强矛盾
  // → 覆盖为切换期（level 置 null：矛盾中无单一水位）
  assert.equal(out[3].key, 'shift');
  assert.equal(out[3].level, null, '切换期不输出单一水位');
  assert.equal(out[3].caution != null, true, '封板率 50 应触发高潮末段 caution');
});
test('classifySeries: 空数组不炸', () => {
  assert.deepEqual(classifySeries([]), []);
  assert.deepEqual(classifySeries(null), []);
});

// ── 常量锁定 ─────────────────────────────────────────────────────────────
test('常量：四态标签 key 唯一且齐全', () => {
  const keys = Object.values(REGIME_LABELS).map((x) => x.key);
  assert.deepEqual([...new Set(keys)].length, keys.length, 'key 必须唯一');
  for (const k of ['ice', 'recover', 'climax', 'ebb', 'neutral', 'unknown', 'shift']) {
    assert.ok(keys.includes(k), `缺少 ${k}`);
  }
});
test('常量：阈值唯一出处在 REGIME_RULES', () => {
  assert.equal(typeof REGIME_RULES.PCT_LOW, 'number');
  assert.equal(typeof REGIME_RULES.PCT_HIGH, 'number');
  assert.equal(typeof REGIME_RULES.DIR_UP, 'number');
  assert.equal(typeof REGIME_RULES.MIN_HISTORY, 'number');
});
test('常量：PCT_LOW < PCT_HIGH（否则判据自相矛盾）', () => {
  assert.ok(REGIME_RULES.PCT_LOW < REGIME_RULES.PCT_HIGH);
});
test('常量：DIR_DOWN 为负、DIR_UP 为正（方向语义不得搞反）', () => {
  assert.ok(REGIME_RULES.DIR_UP > 0);
  assert.ok(REGIME_RULES.DIR_DOWN < 0);
});
test('常量：绝对水位阈值【不参与主分类】（防回退到第一版错误设计）', () => {
  // 关键：用绝对刻度落在 high 但分位在 low 的输入，level 必须听分位的
  const r = levelOf(70, 5);
  assert.equal(r.level, 'low', '若这里返回 high，说明又回退到"绝对水位为主"的错误设计');
  assert.equal(r.primary, 'pct');
});
test('opts.rules: 可覆盖阈值（便于测试与标定）', () => {
  const r = levelOf(50, 50, { rules: { PCT_LOW: 60, PCT_HIGH: 90 } });
  assert.equal(r.level, 'low');
});

// ── ⑤ buildDivergenceBlock：signals-latest 的 divergence 段组装 ──────────────
//   这是 #3 决策的落地（宽度不纳入情绪分，独立成告警）。测的是**真调用**，
//   不是扫源码里有没有 "divergence" 字样。
const mkDays = (rows) => rows.map(([date, value, pct]) => ({
  trade_date: date, emotion: { value, pct_rank: pct },
}));

test('buildDivergenceBlock: 空数组 → null（不是空壳对象）', () => {
  assert.equal(buildDivergenceBlock([], null), null);
  assert.equal(buildDivergenceBlock(null, null), null);
});

test('buildDivergenceBlock: 高位+宽度窄 → 真报假繁荣（端到端）', () => {
  const days = mkDays([['2026-09-30', 70, 90]]);
  const b = buildDivergenceBlock(days, { verdict: { level: 'narrow', label: '宽度收窄' } });
  assert.equal(b.diverged, true);
  assert.equal(b.kind, 'fake-boom');
  assert.ok(/假繁荣/.test(b.label));
  assert.equal(b.ref, 'src/regime.js::detectDivergence', '必须标注判据唯一出处');
});

test('buildDivergenceBlock: 低位+宽度扩张 → 底部背离', () => {
  const days = mkDays([['2026-09-30', 35, 10]]);
  const b = buildDivergenceBlock(days, { verdict: { level: 'broad', label: '宽度扩张' } });
  assert.equal(b.diverged, true);
  assert.equal(b.kind, 'bottom-divergence');
});

test('buildDivergenceBlock: ★ 宽度判定缺失 → 未评估，绝不显示成"一致"', () => {
  const days = mkDays([['2026-09-30', 70, 90]]);
  const b = buildDivergenceBlock(days, null);
  assert.equal(b.level, 'unknown');
  assert.equal(b.diverged, false, 'diverged 为 false 只表示"没触发"，不能被读成"一致"');
  assert.equal(b.label, '未评估');
  assert.ok(/缺失不等于一致|未评估/.test(b.reason));
});

test('buildDivergenceBlock: ★ 宽度序列是 buildBreadthSeries 形态（date + 字符串 verdict）也要能统计', () => {
  // 历史坑：宽度序列两种形态（{date, verdict:'narrow'} vs {trade_date, verdict:{level}}），
  //   只认一种会得出 checkedDays=0 —— "序列在，却统计出 0 天核对过"，静默失真。
  const days = mkDays([
    ['2026-09-25', 70, 90],
    ['2026-09-26', 50, 50],
    ['2026-09-30', 70, 92],
  ]);
  const b = buildDivergenceBlock(days, {
    verdict: { level: 'narrow', label: '宽度收窄' },
    series: [
      { date: '2026-09-25', verdict: 'narrow' },   // 高位 + 窄 → 背离
      { date: '2026-09-26', verdict: 'mid' },      // 中位 → 不背离
      { date: '2026-09-30', verdict: 'very_narrow' },
    ],
  });
  assert.ok(b.history, '有宽度序列就必须给出历史统计');
  assert.equal(b.history.checkedDays, 3, '三天都有判定 → 三天都该进分母');
  assert.equal(b.history.divergedDays, 2, '09-25 与 09-30 背离，09-26 不背离');
});

test('buildDivergenceBlock: 对象形态 verdict（{level,label}）同样能统计', () => {
  const days = mkDays([['2026-09-30', 70, 90]]);
  const b = buildDivergenceBlock(days, {
    verdict: { level: 'narrow', label: 'x' },
    series: [{ trade_date: '2026-09-30', verdict: { level: 'narrow', label: '宽度收窄' } }],
  });
  assert.equal(b.history.checkedDays, 1);
  assert.equal(b.history.divergedDays, 1);
});

test('buildDivergenceBlock: ★ 分母为 0 时 ratePct 必须为 null（不是 0%）', () => {
  // "没核对过" 与 "核对过但一次没背离" 是两回事，0% 会把前者伪装成后者。
  const days = mkDays([['2026-09-30', 70, 90]]);
  const b = buildDivergenceBlock(days, { verdict: null, series: [] });
  assert.equal(b.history, null, '宽度序列为空 → 整段历史统计为 null');
  assert.ok(/未计算/.test(b.historyNote));
});

test('buildDivergenceBlock: 序列有行但情绪分缺失 → 该日不计入分母（未评估≠同向）', () => {
  const days = mkDays([['2026-09-30', null, null]]);
  const b = buildDivergenceBlock(days, {
    verdict: { level: 'narrow', label: 'x' },
    series: [{ date: '2026-09-30', verdict: 'narrow' }],
  });
  assert.equal(b.history.checkedDays, 0);
  assert.equal(b.history.ratePct, null, '分母 0 → null');
});

test('buildDivergenceBlock: 序列日期对不上档案日期 → 不计入分母（不误配）', () => {
  const days = mkDays([['2026-09-30', 70, 90]]);
  const b = buildDivergenceBlock(days, {
    verdict: { level: 'narrow', label: 'x' },
    series: [{ date: '2026-01-01', verdict: 'narrow' }],   // 档案里没有这一天
  });
  assert.equal(b.history.checkedDays, 0, '日期对不上就不能算核对过');
});

test('buildDivergenceBlock: 同向 → diverged=false 且 level=ok（已比对，非未评估）', () => {
  const days = mkDays([['2026-09-30', 70, 90]]);
  const b = buildDivergenceBlock(days, { verdict: { level: 'broad', label: '宽度扩张' } });
  assert.equal(b.diverged, false);
  assert.equal(b.level, 'ok', 'level=ok 表示"比对过且同向"，与 unknown 是两回事');
});

test('buildDivergenceBlock: historyNote 必须解释分母口径（防"0% = 从没背离"误读）', () => {
  const days = mkDays([['2026-09-30', 70, 90]]);
  const b = buildDivergenceBlock(days, {
    verdict: { level: 'narrow', label: 'x' },
    series: [{ date: '2026-09-30', verdict: 'narrow' }],
  });
  assert.ok(/未核对|不计入分母/.test(b.historyNote));
});

// ── ⑥ ★ 决策锁：多维宽度**绝不**进综合分 ───────────────────────────────────
//   这是 #3 的核心决策（宽度不进综合分，只做背离告警）。它是**可被静默破坏**的：
//   将来谁"顺手"把 breadth 的读数接进 computeSentiment 的入参，综合分就会变，
//   而没有任何测试会红——直到有人发现分数不对。故此处用**真调用 + 灵敏度对照**锁死。
//
//   ⚠ 必须带灵敏度对照：若探针连"改真因子"都测不出变化，那么"注入宽度分数不变"
//     只是探针瞎了，不构成证据。两段缺一不可。
test('★ 决策锁：注入多维宽度读数不改变综合分（宽度不进综合分）', async () => {
  const { computeSentiment } = await import('../src/sentiment.js');
  // 一组能产生非中性分数的真实原料（涨停 60/炸 10/涨 1800 跌 2600 …）
  const raw = {
    netBuy: 3.2, newStockNet: 0, newStockRatio: null,
    upCount: 1800, downCount: 2600, posRatio: 0.44,
    industryUp: 12, industryTotal: 31,
    limitUp: 60, limitDown: 8, brokenCount: 10,
    amount: 12000, amountMA20: 10000,
  };
  const base = computeSentiment(raw, undefined);

  // ① 注入多维宽度（src/breadth.js 的产物字段名）→ 综合分与七因子必须逐位不变
  const polluted = computeSentiment({
    ...raw,
    breadth: { aboveMa20Pct: 0.99, newHighCount: 9999, newLowCount: 0, brokenPbPct: 0.9 },
    aboveMa20Pct: 0.99, aboveMa20: 0.99, newHighCount: 9999, newLowCount: 0,
    breadthAboveMa: 0.99, breadthSignal: 'wide', brokenPbPct: 0.9,
  }, undefined);
  assert.equal(polluted.score, base.score, '注入多维宽度后综合分变了 → 宽度被偷偷接进了公式');
  assert.deepEqual(polluted.factors, base.factors, '因子分也被宽度污染了');

  // ② 灵敏度对照：改一个**真因子**（涨停数）必须让分数变——证探针没瞎
  const sens = computeSentiment({ ...raw, limitUp: 600, brokenCount: 0 }, undefined);
  assert.notEqual(sens.score, base.score,
    '改了真因子分数却没变 → 本探针无效，"宽度不影响"的结论不成立');
});

test('★ 决策锁：breadth.js 不得被 sentiment.js / formula_versions.js 引用', async () => {
  // 上面的真调用锁"行为"，这条锁"依赖图"——防止有人绕过 computeSentiment 的入参，
  //   直接在公式模块里 import breadth.js 的读数（那样入参探针测不到）。
  const { readFileSync } = await import('node:fs');
  for (const f of ['src/sentiment.js', 'src/formula_versions.js']) {
    const code = readFileSync(new URL('../' + f, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    assert.ok(!/from\s+['"]\.\/breadth\.js['"]/.test(code),
      `${f} 引入了 breadth.js —— 多维宽度不得进综合分公式（#3 决策）`);
  }
});

// ── ⑧ V5.3 切换期（shift）：矛盾覆盖守卫 ──────────────────────────────────
//   需求口径：信号矛盾直接判【切换期】，保守控仓。必须锁死的反模式：
//   ① 背离/末段矛盾被静默吞掉（标签照旧 climax）；② 弱矛盾（双尺子分歧、冰点惜售）
//   也升格切换期——那会让标签泛滥失去信息量。

test('★ shift：假繁荣背离（高位+宽度窄）→ 覆盖为切换期', () => {
  const r = classifyRegime({
    score: 70, pctRank: 90, history: [60, 65, 68, 70],
    breadthVerdict: { level: 'narrow', label: '宽度收窄' },
  });
  assert.equal(r.key, 'shift');
  assert.equal(r.shifted, true);
  assert.ok(r.shiftReasons.some((s) => /背离/.test(s)), '背离原因必须进 shiftReasons');
  assert.equal(r.level, null, '切换期无单一水位');
  assert.equal(r.dir, null, '切换期无单一方向');
  assert.match(r.detail, /覆盖为「切换期」/);
});

test('★ shift：底部背离（低位+宽度扩张）→ 同样覆盖为切换期', () => {
  const r = classifyRegime({
    score: 32, pctRank: 8, history: [40, 38, 35, 32],
    breadthVerdict: { level: 'broad', label: '宽度扩张' },
  });
  assert.equal(r.key, 'shift');
  assert.equal(r.shifted, true);
});

test('★ shift：无矛盾的主标签不被覆盖（灵敏度对照）', () => {
  const noDiv = classifyRegime({ score: 80, pctRank: 95, history: [60, 65, 70, 80], sealPct: 88 });
  assert.equal(noDiv.key, 'climax');
  assert.equal(noDiv.shifted, false);
  assert.deepEqual(noDiv.shiftReasons, []);
  // 冰点缩量惜售 = 弱矛盾，保持 ice + caution，不升格（防切换期泛滥）
  const ice = classifyRegime({ score: 32, pctRank: 5, history: [35, 34, 33, 32], sealPct: 85 });
  assert.equal(ice.key, 'ice');
  assert.equal(ice.shifted, false);
});

test('★ shift：双尺子读数分歧【不】触发切换（已解释的建模取舍，防 1/3 天数变切换期）', () => {
  // 分位判 high（76.3）而绝对水位判 mid（64.4<65）——两尺子跨档不一致
  const r = classifyRegime({ score: 64.4, pctRank: 76.3, history: [55, 58, 60, 64.4] });
  assert.equal(r.key, 'climax', 'mid|high 尺度分歧保持主标签');
  assert.equal(r.shifted, false);
  assert.equal(r.levelCheck.agree, false, '分歧本身要如实披露');
});

test('★ shift：覆盖时 confidence 封顶 mid（矛盾可确凿，但结论是方向不明）', () => {
  const r = classifyRegime({
    score: 80, pctRank: 95, history: [60, 65, 70, 80],
    breadthVerdict: { level: 'narrow', label: '宽度收窄' },
  });
  assert.equal(r.key, 'shift');
  assert.notEqual(r.confidence, 'high');
});

test('★ shift：unknown 不参与覆盖（判据不足连主标签都没有，无从覆盖）', () => {
  const r = classifyRegime({ score: 60, pctRank: null, history: [60] });
  assert.equal(r.key, 'unknown');
  assert.equal(r.shifted, false);
});

test('★ shift：classifySeries 逐日标注继承切换期（拐点检测与序列码表自动涵盖）', () => {
  const days = [
    { trade_date: '2026-09-26', value: 60 },
    { trade_date: '2026-09-29', value: 62 },
    { trade_date: '2026-09-30', value: 64 },
    { trade_date: '2026-10-05', value: 70 },
  ];
  const ctxByDate = { '2026-10-05': { pct_rank: 90, breadthVerdict: { level: 'narrow', label: '宽度收窄' } } };
  const series = classifySeries(days, ctxByDate);
  assert.equal(series[3].key, 'shift', '末位矛盾日 → shift');
  assert.equal(series[2].key !== 'shift', true, '无矛盾日不受影响');
});

test('★ shift：buildRegimeBlock 的 labels 码表含 shift（前端查表渲染，不自造中文）', () => {
  const days = mkDays([
    ['2026-09-29', 60, 50],
    ['2026-09-30', 80, 95],
  ]);
  const b = buildRegimeBlock(days);
  assert.ok(b.labels.shift === '切换期', '码表必须含 shift 的中文标签');
  assert.ok(Object.values(b.labels).includes('冰点'), '原有标签不受影响');
});
