// 两市成交额跨源对账（2026-10-08 对账任务）· 纯函数层单测
//
// 锁死四件事：
//   ① fetchEastmoneyTwoMarketAmount——上证+深证两 secid 相加才叫两市（半市绝不
//     顶两市）；f57 元→亿换算；两市日期错位不采信；任一 secid 挂 → 整体不可用；
//   ② crossCheckVolume 三态——差 2% PASS（静默）/ 差 10% WARN（超阈告警）/ 备源
//     不可用或交易日错位 UNAVAILABLE（不硬算差值）；
//   ③ 交易日锚定——主备日期不同是假对账，必须拦截；
//   ④ 告警载荷——labels ['guard','cross-check']、titlePrefix「跨源对账」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { emKlineUrl, fetchEastmoneyTwoMarketAmount, crossCheckVolume, crossCheckEvent } from '../src/cross_check_volume.js';
import { buildIssuePayload } from '../src/guard_notify.js';

const klineRes = (date, amountYuan) => ({
  ok: true, status: 200,
  json: async () => ({ data: { klines: [`${date},${amountYuan}`] } }),
});

// ── ① 备源抓取 ────────────────────────────────────────────────────────
test('fetchEastmoneyTwoMarketAmount：上证+深证相加（f57 元→亿），缺一不可', async () => {
  const urls = [];
  const r = await fetchEastmoneyTwoMarketAmount({ fetchImpl: async (u) => {
    urls.push(u);
    return u.includes('1.000001') ? klineRes('2026-10-08', 8111.8e8) : klineRes('2026-10-08', 8709.4e8);
  } });
  assert.equal(r.ok, true);
  assert.equal(r.amountYi, 16821.2, '8111.8 + 8709.4 = 16821.2 亿（10-08 实测口径）');
  assert.equal(r.date, '2026-10-08');
  assert.equal(urls.length, 2, '必须两个 secid 各拉一次');
  assert.match(urls[0], /secid=1\.000001/, '上证日K');
  assert.match(urls[1], /secid=0\.399001/, '深证成指日K');
  assert.match(urls[0], /f51,f57/, '只请求日期+成交额，f57（元）非 f56（成交量）');
});

test('fetchEastmoneyTwoMarketAmount：单 secid 挂 → 整体不可用（半市绝不顶两市）', async () => {
  const r = await fetchEastmoneyTwoMarketAmount({ fetchImpl: async (u) =>
    u.includes('1.000001') ? klineRes('2026-10-08', 8111.8e8) : { ok: false, status: 403 } });
  assert.equal(r.ok, false);
  assert.match(r.error, /403/);
});

test('fetchEastmoneyTwoMarketAmount：两市日期错位 → 不采信（跨日界窗口）', async () => {
  const r = await fetchEastmoneyTwoMarketAmount({ fetchImpl: async (u) =>
    u.includes('1.000001') ? klineRes('2026-10-08', 8111.8e8) : klineRes('2026-10-07', 8709.4e8) });
  assert.equal(r.ok, false);
  assert.match(r.error, /日期错位/);
});

test('fetchEastmoneyTwoMarketAmount：网络炸 → 不抛，原因进 error', async () => {
  const r = await fetchEastmoneyTwoMarketAmount({ fetchImpl: async () => { throw new Error('fetch failed'); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /fetch failed/);
});

test('emKlineUrl：lmt=1 只取最新一根（klt=101 日K）', () => {
  assert.match(emKlineUrl('1.000001'), /klt=101&fqt=0&lmt=1/);
});

// ── ② 对账三态（backup 注入，离线可测）─────────────────────────────────
const bk = (amountYi, date = '2026-10-08') => ({ ok: true, amountYi, date, error: null });

test('crossCheckVolume：主备差 2% → PASS 静默（ok=true 零通知）', async () => {
  const r = await crossCheckVolume(16821.3, { mainDate: '20261008', backup: bk(16500) });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.reason, null);
  assert.ok(r.diffPct <= 5);
});

test('crossCheckVolume：主备差 10% → WARN（超阈告警，理由带双源数值）', async () => {
  const r = await crossCheckVolume(16821.3, { mainDate: '20261008', backup: bk(15100) });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'WARN');
  assert.match(r.reason, /差值 10\.\d+%/);
  assert.match(r.reason, /主 16821\.3 亿 vs 备 15100 亿/);
});

test('crossCheckVolume：备源超时/挂 → UNAVAILABLE 报「备用源不可用」', async () => {
  const r = await crossCheckVolume(16821.3, { mainDate: '20261008', backup: { ok: false, amountYi: null, date: null, error: 'fetch failed' } });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'UNAVAILABLE');
  assert.match(r.reason, /备用源不可用：fetch failed/);
});

test('crossCheckVolume：主备交易日错位 → UNAVAILABLE（拿不同交易日比对是假对账）', async () => {
  const r = await crossCheckVolume(16821.3, { mainDate: '20261008', backup: bk(16821.3, '2026-10-07') });
  assert.equal(r.verdict, 'UNAVAILABLE');
  assert.match(r.reason, /交易日错位/);
});

test('crossCheckVolume：主源值不可用 → UNAVAILABLE（对账无从谈起）', async () => {
  const r = await crossCheckVolume(null, { backup: bk(16821.3) });
  assert.equal(r.verdict, 'UNAVAILABLE');
  assert.match(r.reason, /主源锚点值不可用/);
  const zero = await crossCheckVolume(0, { backup: bk(16821.3) });
  assert.equal(zero.verdict, 'UNAVAILABLE', '0 是无效锚点不是真值');
});

// ── ③ 告警事件与 issue 载荷 ────────────────────────────────────────────
test('crossCheckEvent + buildIssuePayload：对账告警 labels 含 cross-check，title 前缀「跨源对账」，正文带主/备/差值明细', async () => {
  const r = await crossCheckVolume(16821.3, { mainDate: '20261008', backup: bk(15100) });
  const ev = crossCheckEvent(r, { mainDate: '20261008' });
  assert.equal(ev.severity, 'error');
  assert.equal(ev.kind, 'cross-check');
  assert.match(ev.detail, /差值 10\.\d+%/);
  assert.match(ev.detail, /主源｜16821\.3 亿（20261008）/, '定稿明细格式：主源分行带交易日');
  assert.match(ev.detail, /备源｜15100 亿/);
  assert.match(ev.detail, /差值｜10\.\d+%/, '定稿明细格式：差值分行');
  const p = buildIssuePayload(
    { status: r.verdict, reason: r.reason, event: ev },
    { titlePrefix: '跨源对账', labels: ['guard', 'cross-check'] },
  );
  assert.match(p.title, /^🛡️ 跨源对账 WARN: /);
  assert.deepEqual(p.labels, ['guard', 'cross-check'], '验收：labels 含 cross-check');
  assert.match(p.body, /状态: WARN/);
});

test('crossCheckEvent：UNAVAILABLE 场景 null 段省略（备源不可用不显示空备源行）', async () => {
  const r = await crossCheckVolume(16821.3, { mainDate: '20261008', backup: { ok: false, amountYi: null, date: null, error: 'fetch failed' } });
  const ev = crossCheckEvent(r, { mainDate: '20261008' });
  assert.match(ev.detail, /备用源不可用：fetch failed/);
  assert.match(ev.detail, /主源｜16821\.3 亿/);
  assert.doesNotMatch(ev.detail, /备源｜/, '无备源值不渲染备源行');
  assert.doesNotMatch(ev.detail, /差值｜/, '无差值不渲染差值行');
});
