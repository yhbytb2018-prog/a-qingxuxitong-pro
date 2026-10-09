// 东财 push2his 连通性探测（2026-10-08 第三件）· 纯函数层单测
//
// 锁死三件事：
//   ① probeEastmoney 判定口径——HTTP 2xx 且 klines 非空才算 OK（200+空 klines 是
//     限流/改版征兆不算连通，10-08 实测形态）；任何异常不抛、原因进 result.error；
//   ② probeEvent 双态——OK=info 心跳 / FAIL=error（文案含备源影响提示）；
//   ③ buildIssuePayload 参数化（titlePrefix/labels 覆盖）不破坏守卫默认口径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EM_PROBE_URL, probeEastmoney, probeEvent } from '../src/eastmoney_probe.js';
import { buildIssuePayload } from '../src/guard_notify.js';

const klineRes = (klines) => ({ ok: true, status: 200, json: async () => ({ data: { klines } }) });

test('probeEastmoney：2xx + klines 非空 → OK（带耗时与根数）', async () => {
  const r = await probeEastmoney({ fetchImpl: async () => klineRes(['2026-10-08,1', '2026-10-09,2']) });
  assert.equal(r.ok, true);
  assert.equal(r.klines, 2);
  assert.equal(r.error, null);
  assert.ok(r.latencyMs >= 0);
});

test('probeEastmoney：探测端点是上证日K（secid=1.000001，量能备源同款接口族）', () => {
  assert.match(EM_PROBE_URL, /secid=1\.000001/, '探测对象必须与 s6 备源同族，探测才代表备源可用性');
  assert.match(EM_PROBE_URL, /push2his\.eastmoney\.com/);
});

test('probeEastmoney：HTTP 200 但 klines 空 → FAIL（限流/改版征兆不算连通）', async () => {
  const r = await probeEastmoney({ fetchImpl: async () => klineRes([]) });
  assert.equal(r.ok, false);
  assert.equal(r.klines, 0);
  assert.match(r.error, /klines 为空/);
});

test('probeEastmoney：非 2xx → FAIL（HTTP 状态进原因）', async () => {
  const r = await probeEastmoney({ fetchImpl: async () => ({ ok: false, status: 403, json: async () => null }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 403/);
});

test('probeEastmoney：网络炸 → FAIL 不抛（观察者绝不被网络故障炸死）', async () => {
  const r = await probeEastmoney({ fetchImpl: async () => { throw new Error('UND_ERR_SOCKET'); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /UND_ERR_SOCKET/);
});

test('probeEvent：OK=info 心跳 / FAIL=error（含备源兜底提示）', () => {
  const ok = probeEvent({ ok: true, latencyMs: 320, klines: 5, error: null });
  assert.equal(ok.severity, 'info');
  assert.equal(ok.kind, 'eastmoney-probe');
  assert.match(ok.detail, /5 根K线/);
  const fail = probeEvent({ ok: false, latencyMs: null, klines: 0, error: 'TLS 被断' });
  assert.equal(fail.severity, 'error');
  assert.match(fail.detail, /TLS 被断/);
  assert.match(fail.detail, /同花顺\/腾讯兜底/, 'FAIL 文案必须点明备源影响');
});

test('buildIssuePayload：titlePrefix/labels 可覆盖（探测用），守卫默认口径不破坏', () => {
  const ev = { at: '2026-10-08T20:30:00Z', severity: 'error', kind: 'eastmoney-probe', source: 'eastmoney', detail: 'x' };
  const p = buildIssuePayload(
    { status: 'FAIL', reason: 'push2his 不可达', event: ev },
    { titlePrefix: '东财探测', labels: ['guard', 'eastmoney'] },
  );
  assert.match(p.title, /^🛡️ 东财探测 FAIL: /);
  assert.deepEqual(p.labels, ['guard', 'eastmoney']);
  const g = buildIssuePayload({ status: 'BLOCK', reason: 'r', event: ev }, {});
  assert.match(g.title, /^🛡️ 守卫 BLOCK: /, '不传覆盖项 → 守卫默认口径原样');
  assert.deepEqual(g.labels, ['guard']);
});
