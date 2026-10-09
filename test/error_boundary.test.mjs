// 错误边界 + 数据新鲜度横幅单测
//
// 本文件要守住的四件事：
//   ① 只有**首屏必需档**失败才算致命 —— 写反了会让一次外围行情抖动把整页打成白屏
//   ② 陈旧（behind）必须挂横幅，且横幅里必须出现"这是哪一天"与"不再自动更新"
//   ③ 未知（没评估/没互证）决不算 ok —— 没检查 ≠ 没问题
//   ④ 致命错误必须给出"没有数据 ≠ 今天没什么可说的"这句话，且带重试入口
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEVEL, LEVEL_LABEL, needsBanner,
  classifyLoadError, classifyLoadResults, nowFrame,
  staleBannerModel, runtimeErrorModel, renderBannerHtml, renderFatalHtml,
  REQUIRED_ON_BOOT,
} from '../src/error_boundary.js';

const FIXED = new Date('2026-10-02T01:30:00Z');
const frame = (opts = {}) => nowFrame(FIXED, opts);

const metaFresh = () => ({
  tradeDate: '2026-09-30', stale: false, staleReason: null, phase: 'closed',
  freshness: { state: 'fresh', tradeDate: '2026-09-30', latestClosed: '2026-09-30', behindSessions: 0 },
});
const metaStale = () => ({
  tradeDate: '2026-09-20', stale: true,
  staleReason: '落后 5 个交易日（最近已收盘交易日 2026-09-30）',
  phase: 'closed',
  freshness: {
    state: 'behind', tradeDate: '2026-09-20', latestClosed: '2026-09-30',
    behindSessions: 5, publishDeadline: '2026-09-22T11:30:00.000Z',
  },
});

// ════════════════════════════════════════════════════════════════════════════
// ① 分级
// ════════════════════════════════════════════════════════════════════════════
test('REQUIRED_ON_BOOT: 只有 archive-index（首屏必需档唯一定义处）', () => {
  assert.deepEqual([...REQUIRED_ON_BOOT], ['archive-index']);
});

test('★ 首屏必需档失败 → fatal；其它档失败 → degraded（写反＝一次抖动就白屏）', () => {
  assert.equal(classifyLoadError('archive-index', new Error('HTTP 404')).level, LEVEL.FATAL);
  for (const what of ['backtest', 'global', 'signals-latest', 'version-regression', 'runtime']) {
    assert.equal(classifyLoadError(what, new Error('x')).level, LEVEL.DEGRADED, `${what} 不该是 fatal`);
  }
});

test('classifyLoadError: 缺失 message 也能给出可读结果（不是 undefined）', () => {
  const a = classifyLoadError('backtest', null);
  assert.equal(a.message, '未知错误');
  assert.ok(a.hint.length > 0, '每条都要有具体自查路径，"请重试"不是指引');
  const b = classifyLoadError('archive-index', 'just-a-string');
  assert.equal(b.message, 'just-a-string');
  assert.ok(b.required);
});

test('classifyLoadResults: 全成功 → ok；取最严重的一档', () => {
  const ok = classifyLoadResults([{ what: 'archive-index', ok: true }, { what: 'global', ok: true }]);
  assert.equal(ok.level, LEVEL.OK);
  assert.equal(ok.failed.length, 0);

  const mixed = classifyLoadResults([
    { what: 'global', ok: false, error: new Error('a') },
    { what: 'archive-index', ok: true },
    { what: 'backtest', ok: false, error: new Error('b') },
  ]);
  assert.equal(mixed.level, LEVEL.DEGRADED);
  assert.deepEqual(mixed.failed.sort(), ['backtest', 'global']);

  const fatal = classifyLoadResults([
    { what: 'global', ok: false, error: new Error('a') },
    { what: 'archive-index', ok: false, error: new Error('boom') },
  ]);
  assert.equal(fatal.level, LEVEL.FATAL, 'fatal 必须压过 degraded');
});

test('classifyLoadResults: 空输入 → ok（不是 unknown；没有失败就是没有失败）', () => {
  assert.equal(classifyLoadResults([]).level, LEVEL.OK);
  assert.equal(classifyLoadResults(null).level, LEVEL.OK);
});

// ════════════════════════════════════════════════════════════════════════════
// ② 横幅模型
// ════════════════════════════════════════════════════════════════════════════
test('★ 全 ok / fresh → 不占屏幕（常驻横幅会训练人忽略它）', () => {
  const m = staleBannerModel(metaFresh(), { level: 'ok' }, frame(), classifyLoadResults([]));
  assert.equal(m.show, false);
  assert.equal(m.level, LEVEL.OK);
  assert.equal(renderBannerHtml(m), '');
});

test('★ 陈旧 → 挂横幅，且必须说清"哪一天"与预期更新时刻', () => {
  const m = staleBannerModel(metaStale(), null, frame(), classifyLoadResults([]));
  assert.equal(m.show, true);
  assert.equal(m.level, LEVEL.STALE);
  const text = m.lines.join(' ');
  assert.ok(/落后 5 个交易日/.test(text));
  assert.ok(/2026-09-30/.test(text), '必须写出最近已收盘交易日');
  assert.ok(/2026-09-22/.test(text), '必须写出预期更新时刻');
  assert.ok(m.chips.some((c) => c.kind === 'stale'));
  assert.ok(needsBanner(LEVEL.STALE));
});

test('★ 陈旧判定优先于降级（陈旧不会自己好，降级可能只是少一块）', () => {
  const m = staleBannerModel(metaStale(), null, frame(),
    classifyLoadResults([{ what: 'global', ok: false, error: new Error('x') }]));
  assert.equal(m.level, LEVEL.STALE);
  // 但降级信息也不能丢（两个 chip 都要在）
  assert.ok(m.chips.some((c) => c.kind === 'stale'));
  assert.ok(m.chips.some((c) => c.kind === 'degraded'));
});

test('★ 新鲜度未知（无 meta.tradeDate / 无 freshness）→ unknown，绝不放行成 ok', () => {
  const a = staleBannerModel({}, null, frame(), classifyLoadResults([]));
  assert.equal(a.level, LEVEL.UNKNOWN);
  assert.ok(a.chips.some((c) => c.kind === 'unknown'));
  assert.ok(/不等于/.test(a.lines.join(' ')), '必须说"没检查 ≠ 数据是最新的"');

  const b = staleBannerModel({ tradeDate: '2026-09-30' }, null, frame(), classifyLoadResults([]));
  assert.equal(b.level, LEVEL.UNKNOWN);
});

test('pending（正常等待）不算故障，但仍要说清', () => {
  const m = staleBannerModel({
    tradeDate: '2026-09-29', stale: false,
    freshness: { state: 'pending', latestClosed: '2026-09-30', behindSessions: 1 },
  }, null, frame(), classifyLoadResults([]));
  assert.equal(m.level, LEVEL.OK);
  assert.ok(m.chips.some((c) => c.kind === 'pending'));
  assert.ok(/正常等待/.test(m.lines.join(' ')));
  // 不能出现"数据陈旧/加载失败"这类**定性为故障**的 chip；
  // 文案里出现"（非故障）"是刻意的澄清，不算违规。
  assert.ok(!m.chips.some((c) => ['stale', 'fatal', 'degraded'].includes(c.kind)),
    '正常等待不该挂故障 chip');
});

test('致命 → 横幅讲清"没有可用结论"，并给重试', () => {
  const m = staleBannerModel({}, null, frame(),
    classifyLoadResults([{ what: 'archive-index', ok: false, error: new Error('HTTP 404') }]));
  assert.equal(m.show, true);
  assert.equal(m.level, LEVEL.FATAL);
  const text = m.lines.join(' ');
  assert.ok(/HTTP 404/.test(text));
  assert.ok(/没有.*可用结论/.test(text));
  assert.ok(/空白不等于/.test(text), '必须写明"空白 ≠ 今天没什么可说的"');
  assert.ok(m.actions.includes('重试'));
});

test('离线帧 → 出现离线 chip，且明确"不会再自动更新、勿据此下单"', () => {
  const m = staleBannerModel(metaFresh(), null, frame({ offline: true, offlineSince: '2026-10-02T00:00:00Z' }),
    classifyLoadResults([]));
  assert.equal(m.show, true, '离线必须显示（哪怕数据本身是 fresh）');
  assert.ok(m.chips.some((c) => c.kind === 'offline'));
  const text = m.lines.join(' ');
  assert.ok(/离线/.test(text));
  assert.ok(/不会自动更新/.test(text));
  assert.ok(/勿据此下单/.test(text));
});

test('相位（盘中/开盘前）与新鲜度正交：两者可同时出现', () => {
  const m = staleBannerModel({ ...metaFresh(), phase: 'live' }, null, frame(), classifyLoadResults([]));
  assert.ok(m.chips.some((c) => c.kind === 'phase-live'));
  const m2 = staleBannerModel({ ...metaStale(), phase: 'pre' }, null, frame(), classifyLoadResults([]));
  assert.equal(m2.level, LEVEL.STALE);
  assert.ok(m2.chips.some((c) => c.kind === 'phase-pre'), '相位与陈旧必须同时可见');
});

test('健康面板告警并入横幅，但不重复刷屏', () => {
  const health = { level: 'warn', items: [{ label: '因子补位率', level: 'warn' }, { label: '新鲜度', level: 'ok' }] };
  const m = staleBannerModel(metaFresh(), health, frame(), classifyLoadResults([]));
  assert.ok(/因子补位率/.test(m.lines.join(' ')));
  assert.ok(!/新鲜度/.test(m.lines.join(' ')), 'ok 项不该出现在告警摘要里');
  // health 全 ok 时不产生任何额外行
  const m2 = staleBannerModel(metaFresh(), { level: 'ok', items: [{ label: 'x', level: 'ok' }] }, frame(), classifyLoadResults([]));
  assert.equal(m2.show, false);
});

// ════════════════════════════════════════════════════════════════════════════
// ③ 渲染
// ════════════════════════════════════════════════════════════════════════════
test('renderBannerHtml: 输出 chip / 行 / 合规声明，且转义动态文本', () => {
  const m = staleBannerModel({
    tradeDate: '2026-09-20', stale: true, staleReason: '<script>alert(1)</script> 落后 3 个交易日',
    freshness: { state: 'behind', latestClosed: '2026-09-30', behindSessions: 3 },
  }, null, frame(), classifyLoadResults([]));
  const html = renderBannerHtml(m, (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])));
  assert.ok(html.includes('ob-stale'));
  assert.ok(html.includes('数据陈旧'));
  assert.ok(!html.includes('<script>'), '动态文本必须转义');
  assert.ok(html.includes('不构成投资建议'));
});

test('renderBannerHtml: 不显示时返回空串（不是空 div）', () => {
  assert.equal(renderBannerHtml({ show: false, chips: [], lines: [] }), '');
  assert.equal(renderBannerHtml(null), '');
});

test('★ renderFatalHtml: 必须含"没有数据 ≠ 今天没什么可说的" + 重试按钮', () => {
  const html = renderFatalHtml({ message: 'HTTP 404', hint: '重跑 split_archive' }, (s) => String(s));
  assert.ok(html.includes('首屏数据加载失败'));
  assert.ok(html.includes('HTTP 404'));
  assert.ok(html.includes('重跑 split_archive'));
  assert.ok(/没有.*任何结论/.test(html), '不写这句，白屏会被当成"今天没什么可说的"');
  assert.ok(html.includes('data-act="retry-boot"'), '必须有重试入口');
});

test('runtimeErrorModel: 降级而非致命（已渲染内容仍有效，不该清空页面）', () => {
  const e = new Error('boom');
  e.stack = 'Error: boom\n  at a\n  at b\n  at c\n  at d\n  at e';
  const m = runtimeErrorModel(e, frame());
  assert.equal(m.level, LEVEL.DEGRADED);
  assert.equal(m.message, 'boom');
  assert.ok(m.stack.split('\n').length <= 4, '堆栈只留前 4 行（多余的行对定位无益，只会淹没报错）');
  assert.ok(/仍然可用/.test(m.lines.join(' ')));
  assert.ok(/口径/.test(m.lines.join(' ')), '必须声明"不改变任何已展示数值的口径"');
});

test('runtimeErrorModel: 非 Error 输入也能给出可读文案', () => {
  assert.equal(runtimeErrorModel('oops').message, 'oops');
  assert.equal(runtimeErrorModel(null).message, '未知运行期错误');
  assert.equal(runtimeErrorModel(undefined).message, '未知运行期错误');
});

// ════════════════════════════════════════════════════════════════════════════
// ④ nowFrame
// ════════════════════════════════════════════════════════════════════════════
test('nowFrame: 给出 iso+local，透传离线标记', () => {
  const f = nowFrame(FIXED, { offline: true, offlineSince: '2026-10-02T00:00:00Z' });
  assert.equal(f.iso, '2026-10-02T01:30:00.000Z');
  assert.equal(f.local, '2026-10-02 01:30');
  assert.equal(f.offline, true);
  assert.equal(f.offlineSince, '2026-10-02T00:00:00Z');
});

test('nowFrame: 非法时间不炸（iso/local 为 null，由调用方显示「未知」）', () => {
  const f = nowFrame('not-a-date');
  assert.equal(f.iso, null);
  assert.equal(f.local, null);
  assert.equal(f.offline, false);
});

test('LEVEL_LABEL: 每一档都有中文标签（缺一个就会在 UI 里显示英文 key）', () => {
  for (const k of Object.values(LEVEL)) {
    assert.ok(LEVEL_LABEL[k], `${k} 缺标签`);
  }
});

test('needsBanner: 只有 fatal 与 stale 常驻顶部', () => {
  assert.equal(needsBanner(LEVEL.FATAL), true);
  assert.equal(needsBanner(LEVEL.STALE), true);
  assert.equal(needsBanner(LEVEL.DEGRADED), false);
  assert.equal(needsBanner(LEVEL.UNKNOWN), false);
  assert.equal(needsBanner(LEVEL.OK), false);
});
