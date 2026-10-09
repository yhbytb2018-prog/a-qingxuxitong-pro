// ══ Cloudflare Worker 推送代理（worker/push_proxy.js + worker/index.js）════
//
// 覆盖：① 路由（healthz/404/OPTIONS 预检）；② 无 webhook 静默跳过；
//   ③ 成功推送记 KV（指纹 + 日计数）；④ 同内容 30 天去重；⑤ urgent（决议 3）
//   免指纹直达；⑥ 来源闸（ALLOWED_ORIGIN）；⑦ 请求体校验（方法/JSON/类型/超限）；
//   ⑧ 每日上限；⑨ webhook 失败不记指纹（自愈语义）。
// 全部用 Node 18+ 原生 Request/Response（与 Workers 同构），Mock KV/fetch——
//   零网络零磁盘，CI 与本地 node --test 直跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { handlePush, handleHealth, proxyFingerprint, PROXY_CONSTS } from '../worker/push_proxy.js';
import { renderPushText, PUSH_CONSTS } from '../src/push_text.js';

// ── 夹具 ─────────────────────────────────────────────────────────────
const NOW = new Date('2026-10-07T12:00:00.000Z');
const mkReport = (over = {}) => ({
  report_type: 'intraday', trigger: 'schedule', urgent: false, date: '2026-10-08',
  generated_at: '2026-10-08T02:01:00.000Z', status: 'ok',
  payload: { pnl_daily: 0.001, pnl_cumulative: -0.015, drawdown_vs_threshold: { dd_now: 0.05, distance_pp: 3.2, basis: '即时轨' }, overseas: [{ key: 'a50', chgPct: 0.002 }] },
  missing_notes: [],
  ...over,
});
const mkKV = () => {
  const m = new Map();
  return {
    m,
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => { m.set(k, String(v)); },
  };
};
const mkFetch = (ok = true) => {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return { ok, status: ok ? 200 : 500 }; };
  return { calls, fn };
};
const post = (body, { origin, env = {} } = {}) => new Request('http://w/push', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

// ── 1. 路由（经 worker/index.js 默认导出，不 mock 任何运行时）──────────
test('路由：healthz / OPTIONS 预检 / 未知路径 404', async () => {
  const h = await worker.fetch(new Request('http://w/healthz'), {});
  assert.equal(h.status, 200);
  assert.equal((await h.json()).ok, true);
  const pre = await worker.fetch(new Request('http://w/push', { method: 'OPTIONS' }), {});
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  const nf = await worker.fetch(new Request('http://w/nope'), {});
  assert.equal(nf.status, 404);
});

// ── 2. 无 webhook → 静默跳过（与 CI 同纪律，本地零打扰）────────────────
test('无 OPS_WEBHOOK → 200 + pushed:false，不碰 KV 与网络', async () => {
  const kv = mkKV(); const f = mkFetch();
  const r = await handlePush(post(mkReport()), { PUSH_STATE: kv }, { now: NOW, fetchImpl: f.fn });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.pushed, false);
  assert.match(body.reason, /未配置 OPS_WEBHOOK/);
  assert.equal(f.calls.length, 0);
  assert.equal(kv.m.size, 0);
});

// ── 3. 成功推送：文案经 renderPushText、KV 记指纹 + 日计数 ─────────────
test('成功推送：msgtype=text + renderPushText 文案；KV 记 fp 与 day 计数', async () => {
  const kv = mkKV(); const f = mkFetch();
  const report = mkReport();
  const r = await handlePush(post(report), { OPS_WEBHOOK: 'https://wecom/example', PUSH_STATE: kv }, { now: NOW, fetchImpl: f.fn });
  const body = await r.json();
  assert.equal(body.pushed, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://wecom/example');
  const sent = JSON.parse(f.calls[0].init.body);
  assert.equal(sent.msgtype, 'text');
  assert.equal(sent.text.content, renderPushText(report), '文案必须与 Node 侧渲染逐字一致（同一渲染层）');
  assert.ok([...kv.m.keys()].some((k) => k.startsWith('fp:')), '指纹已记');
  assert.ok([...kv.m.keys()].some((k) => k.startsWith('day:')), '日计数已记');
});

// ── 4. 同内容去重 / urgent 免指纹（决议 3 对齐）──────────────────────
test('同内容二推被拦；urgent（trigger≠schedule）免指纹直达', async () => {
  const kv = mkKV(); const f = mkFetch();
  const env = { OPS_WEBHOOK: 'https://wecom/example', PUSH_STATE: kv };
  await handlePush(post(mkReport()), env, { now: NOW, fetchImpl: f.fn });
  const dup = await handlePush(post(mkReport()), env, { now: NOW, fetchImpl: f.fn });
  assert.equal((await dup.json()).pushed, false, '同内容 30 天内去重');
  assert.equal(f.calls.length, 1);
  // urgent：事件版是另一份报告（trigger 进指纹域）
  const urgent = await handlePush(post(mkReport({ trigger: 'event:circuit_breaker' })), env, { now: NOW, fetchImpl: f.fn });
  assert.equal((await urgent.json()).pushed, true, 'urgent 免指纹直达');
  assert.equal(f.calls.length, 2);
  const urgent2 = await handlePush(post(mkReport({ trigger: 'event:circuit_breaker' })), env, { now: NOW, fetchImpl: f.fn });
  assert.equal((await urgent2.json()).pushed, true, 'urgent 重复触发也直达（事件时效性优先，429/日上限兜底）');
});

// ── 5. 来源闸 ─────────────────────────────────────────────────────────
test('ALLOWED_ORIGIN 配置后：跨源 403 / 同源放行 / 未配置放行', async () => {
  const f = mkFetch();
  const env = { OPS_WEBHOOK: 'https://wecom/example', ALLOWED_ORIGIN: 'https://page.example', PUSH_STATE: mkKV() };
  const bad = await handlePush(post(mkReport(), { origin: 'https://evil.example' }), env, { now: NOW, fetchImpl: f.fn });
  assert.equal(bad.status, 403);
  const good = await handlePush(post(mkReport(), { origin: 'https://page.example' }), env, { now: NOW, fetchImpl: f.fn });
  assert.equal((await good.json()).pushed, true);
  const noGate = await handlePush(post(mkReport()), { OPS_WEBHOOK: 'https://wecom/example', PUSH_STATE: mkKV() }, { now: NOW, fetchImpl: f.fn });
  assert.equal((await noGate.json()).pushed, true, '未配置来源闸（本地 dev）放行');
});

// ── 6. 请求体校验 ────────────────────────────────────────────────────
test('请求体校验：GET 405 / 坏 JSON 400 / 类型不合法 400 / 超限 413', async () => {
  const env = { OPS_WEBHOOK: 'https://wecom/example', PUSH_STATE: mkKV() };
  const f = mkFetch();
  assert.equal((await handlePush(new Request('http://w/push'), env, { now: NOW, fetchImpl: f.fn })).status, 405);
  assert.equal((await handlePush(post('{bad'), env, { now: NOW, fetchImpl: f.fn })).status, 400);
  assert.equal((await handlePush(post({ report_type: 'webhook_spam', payload: {} }), env, { now: NOW, fetchImpl: f.fn })).status, 400);
  const big = { ...mkReport(), payload: { ...mkReport().payload, junk: 'x'.repeat(PROXY_CONSTS.BODY_CAP) } };
  assert.equal((await handlePush(post(big), env, { now: NOW, fetchImpl: f.fn })).status, 413);
});

// ── 7. 每日上限 / webhook 失败自愈 ────────────────────────────────────
test('每日上限 429；webhook 失败 502 且不记指纹（重试自愈）', async () => {
  const dayKey = `day:${new Date(NOW.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)}`;
  const kv = mkKV(); kv.m.set(dayKey, String(PROXY_CONSTS.DAILY_CAP));
  const capped = await handlePush(post(mkReport()), { OPS_WEBHOOK: 'https://wecom/example', PUSH_STATE: kv }, { now: NOW, fetchImpl: mkFetch().fn });
  assert.equal(capped.status, 429);
  const kv2 = mkKV(); const bad = mkFetch(false);
  const fail = await handlePush(post(mkReport()), { OPS_WEBHOOK: 'https://wecom/example', PUSH_STATE: kv2 }, { now: NOW, fetchImpl: bad.fn });
  assert.equal(fail.status, 502);
  assert.ok(![...kv2.m.keys()].some((k) => k.startsWith('fp:')), '失败不记指纹');
  const retry = await handlePush(post(mkReport()), { OPS_WEBHOOK: 'https://wecom/example', PUSH_STATE: kv2 }, { now: NOW, fetchImpl: mkFetch(true).fn });
  assert.equal((await retry.json()).pushed, true, '重试同内容照推（自愈）');
});

// ── 8. 指纹稳定性 ────────────────────────────────────────────────────
test('proxyFingerprint：易变字段剔除（generated_at 不影响）/ 内容变化必换', () => {
  const a = mkReport();
  assert.equal(proxyFingerprint(a), proxyFingerprint({ ...a, generated_at: '2027-01-01T00:00:00Z', generated_by: 'x' }));
  assert.notEqual(proxyFingerprint(a), proxyFingerprint({ ...a, trigger: 'event:circuit_breaker' }));
  assert.notEqual(proxyFingerprint(a), proxyFingerprint(mkReport({ payload: { ...a.payload, pnl_daily: 0.009 } })));
});

// ── 9. 三端渲染一致性（Worker 侧 import 的就是同一纯模块）────────────
test('渲染层三端同源：push_text.js 与 ai_report_push.js re-export 是同一函数对象', async () => {
  const nodeSide = await import('../src/ai_report_push.js');
  assert.strictEqual(nodeSide.renderPushText, renderPushText, 'Node 侧 re-export 即 Worker 侧直取');
  assert.strictEqual(nodeSide.PUSH_CONSTS, PUSH_CONSTS);
  assert.equal(handleHealth().status, 200);
});
