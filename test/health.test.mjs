// 数据健康面板的口径守卫。
//
// 本文件锁的是**判定语义**而非数值快照：
//   · 某项"查不出来"必须是 unknown，不得退化成 ok（那会把"没检查"说成"没问题"）；
//   · 整档结论取**最差**项（不得被平均值稀释——那正是这份报告要避免的）；
//   · 统计不到的维度返回 null，不得填 0（0 与"没有"在健康语境下含义相反）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEALTH_LEVEL, HEALTH_THRESHOLDS, KEY_FIELDS,
  checkFreshness, checkImputed, checkFields, healthReport,
} from '../src/health.js';

// ── 夹具：构造若干天。默认所有关键字段齐全、补位率 0。 ──
const mkDay = (date, over = {}) => ({
  trade_date: date,
  summary: {
    ind_up: 45, up_count: 2600, amount_yi: 21000, zt_count: 50, zb_count: 12,
    lhb_daily_net: 7.74, ...(over.summary || {}),
  },
  emotion: { imputedRatio: 0, missing: [], ...(over.emotion || {}) },
});
const mkDays = (n, over = {}) =>
  Array.from({ length: n }, (_, i) => mkDay(`2099-01-${String(i + 1).padStart(2, '0')}`, over));

// ── 一、常量与结构 ──

test('健康：等级常量齐备且含 unknown（"查不出来"必须可表达）', () => {
  for (const k of ['fail', 'warn', 'ok', 'unknown']) {
    assert.equal(typeof HEALTH_LEVEL[k], 'string', `缺等级 ${k}`);
  }
});

test('健康：阈值集中在模块内（UI 不得自行硬编码）', () => {
  assert.equal(typeof HEALTH_THRESHOLDS.imputedWarn, 'number');
  assert.equal(typeof HEALTH_THRESHOLDS.imputedFail, 'number');
  assert.equal(typeof HEALTH_THRESHOLDS.fieldWarnRatio, 'number');
  assert.ok(HEALTH_THRESHOLDS.imputedWarn < HEALTH_THRESHOLDS.imputedFail,
    '告警线必须低于失败线，否则 warn 档永远到不了');
});

test('健康：关键字段清单每项都说明"缺失会让什么退化"', () => {
  assert.ok(KEY_FIELDS.length >= 5, `关键字段太少（${KEY_FIELDS.length}）`);
  for (const f of KEY_FIELDS) {
    assert.ok(f.key && f.label, `字段 ${f.key} 缺 key/label`);
    assert.ok(f.affects && f.affects.length > 5, `字段 ${f.key} 未说明缺失影响`);
  }
});

// ── 二、新鲜度 ──

test('新鲜度：未注入评估函数时返回 unknown，不得佯装正常', () => {
  // 这是本模块最重要的一条守卫：佯装"正常"比说"不知道"危险得多，
  // 因为后者会让人去查，前者不会。
  const r = checkFreshness({}, {});
  assert.equal(r.level, HEALTH_LEVEL.unknown);
  assert.equal(r.state, null);
  assert.equal(r.behindSessions, null);
  assert.ok(/未注入/.test(r.detail), r.detail);
});

test('新鲜度：fresh → ok，pending → warn，behind → fail', () => {
  const mk = (state, behind) => (meta, now, hol) => ({ state, behindSessions: behind, tradeDate: '2099-01-05', publishDeadline: '2099-01-06T11:30:00.000Z' });
  assert.equal(checkFreshness({}, { assessFn: mk('fresh') }).level, HEALTH_LEVEL.ok);
  assert.equal(checkFreshness({}, { assessFn: mk('pending', 1) }).level, HEALTH_LEVEL.warn);
  assert.equal(checkFreshness({}, { assessFn: mk('behind', 3) }).level, HEALTH_LEVEL.fail);
});

test('新鲜度：未知状态归 unknown，不得归 ok', () => {
  const r = checkFreshness({}, { assessFn: () => ({ state: 'weird' }) });
  assert.equal(r.level, HEALTH_LEVEL.unknown);
});

// ── 三、补位率 ──

test('补位率：窗口内无任何记录 → unknown（不是 ok）', () => {
  const days = [{ trade_date: '2099-01-01', summary: {}, emotion: {} }];
  const r = checkImputed(days);
  assert.equal(r.level, HEALTH_LEVEL.unknown);
  assert.equal(r.sampled, 0);
  assert.equal(r.meanRatio, null);
  assert.ok(/没有任何一天/.test(r.detail));
});

test('补位率：低补位 → ok，且报出最差一天与均值', () => {
  const days = mkDays(10, { emotion: { imputedRatio: 0.14, missing: ['s_pos20'] } });
  const r = checkImputed(days);
  assert.equal(r.level, HEALTH_LEVEL.ok);
  assert.equal(r.sampled, 10);
  assert.ok(Math.abs(r.meanRatio - 0.14) < 1e-6);
  assert.equal(r.worstDay.ratio, 0.14);
});

test('补位率：判级看**最差一天**而非均值（一天烂不能被平均掉）', () => {
  // 构造：19 天补位 0、1 天补位 1.0（全缺）。均值 0.05 看起来很好，
  // 但那一天的分数是虚构的，必须报出来。
  const days = mkDays(20).map((d, i) => (i === 7
    ? mkDay(d.trade_date, { emotion: { imputedRatio: 1.0, missing: ['s_net20', 's_pos10', 's_brd20', 's_hot10', 's_zdt15', 's_zbl10', 's_amt15'] } })
    : d));
  const r = checkImputed(days);
  assert.equal(r.meanRatio, 0.05, '均值应为 0.05');
  assert.equal(r.level, HEALTH_LEVEL.fail, '最差一天 1.0 应判 fail（≥ imputedFail）');
  assert.equal(r.worstDay.date, days[7].trade_date);
  assert.equal(r.worstDay.missing, 7);
});

test('补位率：warn 与 fail 的边界由阈值常量决定（不硬编码）', () => {
  const at = (x) => checkImputed(mkDays(5, { emotion: { imputedRatio: x } }), {
    thresholds: { ...HEALTH_THRESHOLDS, imputedWarn: 0.4, imputedFail: 0.8 },
  });
  assert.equal(at(0.39).level, HEALTH_LEVEL.ok);
  assert.equal(at(0.4).level, HEALTH_LEVEL.warn, '恰在告警线应进 warn');
  assert.equal(at(0.79).level, HEALTH_LEVEL.warn);
  assert.equal(at(0.8).level, HEALTH_LEVEL.fail, '恰在失败线应进 fail');
});

test('补位率：只统计窗口内最后 N 天（更早的烂数据不影响当下判定）', () => {
  const old = mkDays(20, { emotion: { imputedRatio: 1.0 } });
  const fresh = mkDays(20, { emotion: { imputedRatio: 0.0 } });
  // 前 20 天全缺、后 20 天全好；窗口取 20 → 只看后 20 天
  const r = checkImputed([...old, ...fresh], { recentWindow: 20 });
  assert.equal(r.sampled, 20);
  assert.equal(r.level, HEALTH_LEVEL.ok, '窗口内应全好');
  assert.equal(r.worstDay.ratio, 0);
});

// ── 四、字段可用率 ──

test('字段可用率：全档与近窗口双尺度都要报（只看一个会误导）', () => {
  // 构造：前 30 天缺 up_count、后 20 天齐全 → 全档 20/50=40%，近窗口 100%
  const bad = mkDays(30).map((d) => mkDay(d.trade_date, { summary: { up_count: null } }));
  const good = mkDays(20);
  const r = checkFields([...bad, ...good], { recentWindow: 20 });
  const row = r.rows.find((x) => x.key === 'up_count');
  assert.equal(row.totalAll, 50);
  assert.equal(row.hasAll, 20);
  assert.equal(row.ratioAll, 0.4, '全档覆盖率应反映历史缺口');
  assert.equal(row.hasRecent, 20);
  assert.equal(row.ratioRecent, 1, '近窗口覆盖率应为 100%');
  assert.equal(row.level, HEALTH_LEVEL.ok, '判级只看近窗口——历史缺口是既成事实');
});

test('字段可用率：近窗口覆盖不足 → warn，并列出字段名与影响', () => {
  const days = mkDays(20).map((d) => mkDay(d.trade_date, { summary: { up_count: null, zb_count: null } }));
  const r = checkFields(days, { recentWindow: 20 });
  assert.equal(r.level, HEALTH_LEVEL.warn);
  assert.ok(/全市场涨跌家数/.test(r.detail), r.detail);
  const upRow = r.rows.find((x) => x.key === 'up_count');
  assert.equal(upRow.ratioRecent, 0);
  assert.ok(/涨跌家数因子/.test(upRow.affects), '必须说明缺失影响');
});

test('字段可用率：空数组 → 全部 unknown（不得报成 ok）', () => {
  const r = checkFields([], { recentWindow: 20 });
  assert.equal(r.level, HEALTH_LEVEL.unknown);
  for (const row of r.rows) {
    assert.equal(row.level, HEALTH_LEVEL.unknown);
    assert.equal(row.ratioRecent, null, '空样本的覆盖率必须是 null 而非 0');
  }
});

test('字段可用率：summary 缺失（backfill 天）计为不可用，不抛错', () => {
  const days = [{ trade_date: '2099-01-01' }, { trade_date: '2099-01-02', summary: null }];
  assert.doesNotThrow(() => checkFields(days));
  const r = checkFields(days, { recentWindow: 20 });
  assert.equal(r.rows.find((x) => x.key === 'ind_up').hasRecent, 0);
});

// ── 五、汇总 ──

test('汇总：整档取最差项（问题项不得被平均值稀释）', () => {
  // 新鲜度 fresh（ok）+ 补位 0（ok）+ 字段近窗口全缺（warn） → 整档应为 warn
  const days = mkDays(20).map((d) => mkDay(d.trade_date, { summary: { ind_up: null } }));
  const r = healthReport(days, { assessFn: () => ({ state: 'fresh' }), recentWindow: 20 });
  assert.equal(r.level, HEALTH_LEVEL.warn);
  assert.ok(/注意/.test(r.label), r.label);
});

test('汇总：有 fail 项时整档 fail（fail 优先级最高）', () => {
  const days = mkDays(20).map((d) => mkDay(d.trade_date, { emotion: { imputedRatio: 1.0 } }));
  const r = healthReport(days, { assessFn: () => ({ state: 'behind', behindSessions: 3 }), recentWindow: 20 });
  assert.equal(r.level, HEALTH_LEVEL.fail);
});

test('汇总：全部 unknown 时整档也是 unknown（"查不出来"不等于"没问题"）', () => {
  const r = healthReport([], { recentWindow: 20 });
  assert.equal(r.level, HEALTH_LEVEL.unknown);
  assert.ok(/无法判定/.test(r.summary), r.summary);
  assert.ok(/不等于正常/.test(r.summary), '必须显式说明 unknown≠正常');
});

test('汇总：全好时整档 ok', () => {
  const r = healthReport(mkDays(20), { assessFn: () => ({ state: 'fresh' }), recentWindow: 20 });
  assert.equal(r.level, HEALTH_LEVEL.ok);
  assert.equal(r.items.length, 3, '三项检查都应产出');
});

test('汇总：必带口径说明（不参与打分、缺失显示未知）', () => {
  const r = healthReport(mkDays(5));
  assert.ok(/不参与打分/.test(r.note), r.note);
  assert.ok(/未知/.test(r.note), '必须声明缺失一律显示未知');
});

test('汇总：items 的 item 键唯一且顺序稳定（前端据此渲染，不得随数据变化）', () => {
  const a = healthReport(mkDays(20), { assessFn: () => ({ state: 'fresh' }) });
  const b = healthReport([], {});
  assert.deepEqual(a.items.map((x) => x.item), ['freshness', 'imputed', 'fields']);
  assert.deepEqual(b.items.map((x) => x.item), ['freshness', 'imputed', 'fields']);
});

test('汇总：不读盘、不抛错（纯函数契约）', () => {
  assert.doesNotThrow(() => healthReport(null));
  assert.doesNotThrow(() => healthReport(undefined, {}));
  assert.doesNotThrow(() => healthReport([null, undefined, {}], {}));
  const r = healthReport(null);
  assert.equal(r.level, HEALTH_LEVEL.unknown);
});

// ── 六、真实档案端到端 ──

test('端到端：真实档案上健康报告自洽（等级合法、字段非负）', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const p = join(ROOT, 'data', 'archive.json');
  if (!existsSync(p)) return; // 数据缺失时跳过（CI 首次 clone 可能没有）
  const { decodeArchive } = await import('../src/lhb_codec.js');
  const arc = decodeArchive(JSON.parse(readFileSync(p, 'utf8')));
  const days = arc.all_days || [];
  const r = healthReport(days, { meta: arc.meta, assessFn: () => ({ state: 'fresh' }) });
  assert.ok(Object.values(HEALTH_LEVEL).includes(r.level), r.level);
  assert.equal(r.items.length, 3);
  const fld = r.items.find((x) => x.item === 'fields');
  for (const row of fld.rows) {
    assert.ok(row.hasAll >= 0 && row.hasAll <= row.totalAll, `${row.key} 计数越界`);
    assert.ok(row.ratioAll == null || (row.ratioAll >= 0 && row.ratioAll <= 1), `${row.key} 覆盖率越界`);
  }
  // 实测档案的关键特征（六因子回填 2026-10-02 后）：ind_up/up_count 已 241/241 全覆盖
  // （行业年线回填 + K 线重建涨跌家数）。守卫方向随世界更新：
  //   · 全覆盖时面板必须如实给出满覆盖（不再断言「必须不足」——那是回填前世界的锁）；
  //   · 若未来覆盖率下降（数据源退化/新缺口天），面板必须暴露出来而非吞掉。
  const byKey = Object.fromEntries(fld.rows.map((x) => [x.key, x]));
  assert.ok(byKey.ind_up, '健康面板必须包含 ind_up 行');
  assert.ok(byKey.up_count, '健康面板必须包含 up_count 行');
  if (byKey.ind_up.hasAll === days.length) {
    assert.equal(byKey.ind_up.ratioAll, 1, 'ind_up 满覆盖时 ratioAll 必须为 1');
  } else {
    assert.ok(byKey.ind_up.hasAll < days.length, 'ind_up 覆盖不足全档时必须如实反映');
  }
});

test('端到端：可重现性（同输入两次调用结果一致）', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const p = join(ROOT, 'data', 'archive.json');
  if (!existsSync(p)) return;
  const { decodeArchive } = await import('../src/lhb_codec.js');
  const arc = decodeArchive(JSON.parse(readFileSync(p, 'utf8')));
  const a = healthReport(arc.all_days, { assessFn: () => ({ state: 'fresh' }) });
  const b = healthReport(arc.all_days, { assessFn: () => ({ state: 'fresh' }) });
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});
