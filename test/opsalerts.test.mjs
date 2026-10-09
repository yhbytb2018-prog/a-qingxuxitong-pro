// 运维告警模块（opsalerts）单测 —— 拦截器翻译层 + 推送容错。
//
// 核心断言三件事：
//   ① 事件构造是纯函数：各种「坏事实」→ 对应 severity/kind 的事件，干净档案 → 空；
//   ② 推送纪律：无 OPS_WEBHOOK 静默跳过；fetch 失败绝不抛出（告警不能炸主管道）；
//   ③ 落盘：合并历史 + 上限截断，格式稳定可审计。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { opsEventsFromArchive, formatOpsText, writeOpsAlerts, pushOpsAlerts, OPS_SEVERITIES } from '../src/opsalerts.js';

const mkArchive = (over = {}) => ({
  meta: { lastAttempt: { outcome: 'ok', reason: null }, freshness: { state: 'fresh' }, ...(over.meta || {}) },
  signals: { imputedRatioLatest: 0.1, ...(over.signals || {}) },
  all_days: [
    { trade_date: '2026-09-30', emotion: { missing: [] } },
    ...(over.extraDays || []),
  ],
});

test('ops: 干净档案 → 0 条事件（不制造噪音）', () => {
  assert.deepEqual(opsEventsFromArchive(mkArchive()), []);
});

test('ops: 抓取失败（回退档）→ error 事件，含原因', () => {
  const ev = opsEventsFromArchive(mkArchive({ meta: { lastAttempt: { outcome: 'failed', reason: '东财超时' } } }));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].severity, 'error');
  assert.equal(ev[0].kind, 'fetch-failed');
  assert.ok(ev[0].detail.includes('东财超时'));
});

test('ops: 数据滞后 → warn；补位超标 → warn（判定线可注入，与 config 同源）', () => {
  const ev = opsEventsFromArchive(
    // H-5：合法值是 'behind'（freshness.state ∈ fresh|pending|behind|unknown）——
    // 历史上这里与实现犯同一个错（都写 'stale'），两边互相印证成假绿：实现永不触发，
    // 测试也从未真正验证过告警分支。
    mkArchive({ meta: { freshness: { state: 'behind' } }, signals: { imputedRatioLatest: 0.5 } }),
    { warnImputedRatio: 0.34 },
  );
  assert.equal(ev.length, 2);
  const stale = ev.find((e) => e.kind === 'data-stale');
  const imputed = ev.find((e) => e.kind === 'imputed-ratio-high');
  assert.equal(stale.severity, 'warn');
  assert.ok(imputed.detail.includes('50.0%'));
  // 判定线边界：恰好等于不算超标（> 严格大于）
  assert.equal(opsEventsFromArchive(
    mkArchive({ signals: { imputedRatioLatest: 0.34 } }), { warnImputedRatio: 0.34 },
  ).filter((e) => e.kind === 'imputed-ratio-high').length, 0);
});

test('ops: 缺失因子 → info 事件（如实可见，不制造紧迫感）', () => {
  const ev = opsEventsFromArchive(mkArchive({
    extraDays: [{ trade_date: '2026-10-09', emotion: { missing: ['s_zbl', 's_amt'] } }],
  }));
  // all_days 末位是 10-09（extraDays 追加在后），latest 取最后一天
  assert.equal(ev.length, 1);
  assert.equal(ev[0].severity, 'info');
  assert.ok(ev[0].detail.includes('s_zbl') && ev[0].detail.includes('s_amt'));
});

test('ops: dataQuality 任何 *Ok=false → error（防御式扫描，未来新增源健康标记自动覆盖）', () => {
  const ev = opsEventsFromArchive(mkArchive({
    meta: { dataQuality: { industrySourceOk: false, someFutureSourceOk: false, anotherFlag: true } },
  }));
  assert.equal(ev.length, 2);
  assert.ok(ev.every((e) => e.severity === 'error' && e.kind === 'source-degraded'));
  assert.ok(ev.some((e) => e.source === 'dataQuality.industrySourceOk'));
  assert.ok(ev.some((e) => e.source === 'dataQuality.someFutureSourceOk'));
});

test('ops: 事件按 severity 排序（error → warn → info）', () => {
  const ev = opsEventsFromArchive(mkArchive({
    meta: {
      lastAttempt: { outcome: 'failed', reason: 'x' },
      freshness: { state: 'behind' },
      dataQuality: { industrySourceOk: false },
    },
    signals: { imputedRatioLatest: 0.9 },
    extraDays: [{ trade_date: '2026-10-09', emotion: { missing: ['s_hot'] } }],
  }));
  assert.deepEqual(ev.map((e) => e.severity), ['error', 'error', 'warn', 'warn', 'info']);
  for (const e of ev) {
    assert.ok(OPS_SEVERITIES.includes(e.severity));
    assert.ok(typeof e.kind === 'string' && e.kind.length > 0);
    assert.ok(typeof e.detail === 'string' && e.detail.length > 0);
    assert.ok(typeof e.at === 'string');
  }
});

test('ops: formatOpsText —— 头部计数 + 超长截断', () => {
  const ev = opsEventsFromArchive(mkArchive({
    meta: { lastAttempt: { outcome: 'failed', reason: 'r' }, freshness: { state: 'behind' } },
  }));
  const text = formatOpsText(ev);
  assert.ok(text.includes('运维告警') && text.includes('2 条'));
  assert.ok(text.includes('[ERROR] fetch-failed'));
  const long = formatOpsText([{ severity: 'warn', kind: 'k', source: 's', detail: '很长的细节'.repeat(600) }], { cap: 100 });
  assert.ok(long.length <= 101 && long.endsWith('…'));
});

test('ops: writeOpsAlerts —— 合并历史 + 上限截断 + 空事件也落盘（体检留痕）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opsalerts-'));
  const file = path.join(dir, 'ops-alerts-latest.json');
  try {
    const e1 = [{ at: '2026-10-02T01:00:00Z', severity: 'warn', kind: 'a', source: 's', detail: 'd' }];
    const e2 = [{ at: '2026-10-02T02:00:00Z', severity: 'error', kind: 'b', source: 's', detail: 'd' }];
    writeOpsAlerts(e1, file);
    writeOpsAlerts(e2, file, { cap: 5 });
    const mid = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(mid.count, 2);
    assert.equal(mid.events[0].kind, 'a');
    assert.equal(mid.events[1].kind, 'b');
    // cap 生效：灌 8 条历史后只留最近 5 条
    const many = Array.from({ length: 8 }, (_, i) => ({ at: `2026-10-0${i + 1}T00:00:00Z`, severity: 'info', kind: `k${i}`, source: 's', detail: 'd' }));
    writeOpsAlerts(many, file, { cap: 5 });
    const fin = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(fin.count, 5);
    assert.equal(fin.events[0].kind, 'k3'); // 最早的 k0~k2 被截掉
    // 空事件也写（体检留痕）：历史保留、只刷新 updatedAt —— CI 提交依赖文件存在
    writeOpsAlerts([], file);
    const empty = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(empty.count, 5); // 历史不因「本轮干净」而清空（留痕语义）
    assert.ok(empty.updatedAt);
    assert.equal(empty.events.length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ops: pushOpsAlerts —— 无环境变量静默跳过（本地零打扰）', async () => {
  let called = 0;
  const fetchImpl = async () => { called++; return { ok: true }; };
  const r = await pushOpsAlerts([{ severity: 'warn', kind: 'k', source: 's', detail: 'd' }], {
    env: {}, fetchImpl,
  });
  assert.deepEqual(r, { pushed: 0, skipped: true });
  assert.equal(called, 0);
});

test('ops: pushOpsAlerts —— 企微 text 格式 + 成功计数', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true };
  };
  const events = [
    { at: 'x', severity: 'error', kind: 'fetch-failed', source: 'pipeline', detail: '超时' },
    { at: 'x', severity: 'warn', kind: 'data-stale', source: 'freshness', detail: '滞后' },
  ];
  const r = await pushOpsAlerts(events, { env: { OPS_WEBHOOK: 'https://example.test/hook' }, fetchImpl });
  assert.equal(r.pushed, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/hook');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.msgtype, 'text');
  assert.ok(body.text.content.includes('2 条') && body.text.content.includes('fetch-failed'));
});

test('ops: pushOpsAlerts —— fetch 抛错/HTTP 非 200 都不抛出（告警不炸主管道）', async () => {
  const r1 = await pushOpsAlerts([{ severity: 'warn', kind: 'k', source: 's', detail: 'd' }], {
    env: { OPS_WEBHOOK: 'https://x.test' },
    fetchImpl: async () => { throw new Error('网络断'); },
  });
  assert.equal(r1.pushed, 0);
  assert.ok(r1.error.includes('网络断'));
  const r2 = await pushOpsAlerts([{ severity: 'warn', kind: 'k', source: 's', detail: 'd' }], {
    env: { OPS_WEBHOOK: 'https://x.test' },
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  assert.equal(r2.pushed, 0);
  assert.ok(r2.error.includes('500'));
  // 空事件列表：不推送
  const r3 = await pushOpsAlerts([], { env: { OPS_WEBHOOK: 'https://x.test' }, fetchImpl: async () => ({ ok: true }) });
  assert.deepEqual(r3, { pushed: 0, skipped: true });
});
