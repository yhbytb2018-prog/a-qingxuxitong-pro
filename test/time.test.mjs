// src/time.js + util.fetchWithRetry 的收敛守卫。
//
// 背景：BJ 时区换算与抓取重试此前在多处各自手算/手写，本测试锁住收敛后的唯一出处行为
// （换算正确性 + opts.read 的重试语义），防止后续改动悄悄漂移。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { bjDate, bjTime, bjStamp, bjInstant } from '../src/time.js';
import { fetchWithRetry, todayBeijing } from '../src/util.js';

// 夹具：显式 +08:00 写法，与宿主时区无关
const at = (s) => new Date(s + '+08:00');

test('bjDate/bjTime：UTC+8 换算正确（含跨日边界）', () => {
  assert.equal(bjDate(at('2026-10-05T23:30')), '2026-10-05');
  assert.equal(bjDate(at('2026-10-06T00:30')), '2026-10-06');
  // UTC 16:30 = 北京次日 00:30（跨日边界最易错处）
  assert.equal(bjDate(new Date('2026-10-05T16:30:00Z')), '2026-10-06');
  assert.equal(bjTime(new Date('2026-10-05T16:30:00Z')), '00:30');
  assert.equal(bjTime(new Date('2026-10-05T01:07:00Z')), '09:07');
});

test('bjStamp：显式 +08:00 偏移的完整时刻戳（毫秒精度保留）', () => {
  assert.equal(bjStamp(new Date('2026-10-05T02:03:04.567Z')), '2026-10-05T10:03:04.567+08:00');
});

test('bjInstant：北京墙上时刻 → 绝对时间戳数值（与 +08:00 解析及旧 Date.UTC 写法逐位等价）', () => {
  assert.equal(bjInstant('2026-10-05', '19:30'), Date.parse('2026-10-05T19:30:00+08:00'));
  // need_rebuild.mjs 收敛前的旧实现：Date.UTC(y, mo-1, d, hh, mm) - 8h，两者必须等价
  assert.equal(bjInstant('2026-10-08', '22:00'), Date.UTC(2026, 9, 8, 22, 0) - 8 * 3600 * 1000);
  // 返回数值（不是 Date）——publishDeadline 落盘 JSON 的格式契约
  assert.equal(typeof bjInstant('2026-10-05', '19:30'), 'number');
});

test('todayBeijing 委托 bjDate：同瞬间输出逐位一致', () => {
  assert.equal(todayBeijing(at('2026-10-06T00:30')), '2026-10-06');
  assert.equal(todayBeijing(new Date('2026-10-05T16:00:00Z')), '2026-10-06');
});

test('fetchWithRetry: opts.read 在重试范围内执行（读取/校验失败触发退避重试）', async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits += 1;
    res.end(hits < 3 ? 'bad' : 'ok'); // 前两次返回会被 read 拒绝的内容
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const out = await fetchWithRetry(`http://127.0.0.1:${srv.address().port}/`, {
      read: async (r) => {
        const t = await r.text();
        if (t !== 'ok') throw new Error('结构异常');
        return t;
      },
    }, 3, 1);
    assert.equal(out, 'ok');
    assert.equal(hits, 3);
  } finally {
    srv.close();
  }
});

test('fetchWithRetry: 不提供 opts.read 时返回 Response 本体', async () => {
  const srv = http.createServer((req, res) => res.end('ok'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const res = await fetchWithRetry(`http://127.0.0.1:${srv.address().port}/`, {}, 1, 1);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  } finally {
    srv.close();
  }
});
