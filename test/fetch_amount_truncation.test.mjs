// 测试：fetchAmountMap 截断防护（2026-10-08 病因B）
//
// 背景：同花顺年线接口间歇性返回截断序列（当晚实录：截到 20251231 缺 9 个月 /
// 截到 0930 缺当日，CI 18:30/21:00 两班 smoke 两连挂）。修复：调用方传 anchor，
// 序列最新键 < anchor → 腾讯实时两市兜底当日值（比值+区间护栏内建）。
// 本套 mock globalThis.fetch 按 URL 分流（同花顺年线 / 腾讯实时），锁死四场景：
//   ① 截断 + 腾讯正常 → 当日键被兜上（smoke 锚点断言可过的真值路径）
//   ② 完整序列 → 腾讯不被调（不该有副作用）
//   ③ 截断 + 腾讯单市脏值 → 兜底拒收，当日键缺失（宁缺勿假，不拦但也不造假值）
//   ④ 不传 anchor → 完全向后兼容（backfill_factors 等历史调用方行为不变）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAmountMap } from '../src/sources.js';

// ── mock 基建 ─────────────────────────────────────────────────────────
// 同花顺年线按指数分两次请求（zs_1A0001 / zs_399001），返回形如
// `D(name, {"data":"YYYYMMDD,o,h,l,c,?,amount;..."})`——fetchAmountMap 解析
// obj.data 的 c[0]=日期、c[6]=成交额（元，/1e8 → 亿）。mock 按 URL 里的 code 分流单市数据。
const thsLine = (days) => ({
  data: Object.entries(days).map(([d, yi]) => `${d},3800,3900,3700,3850,123,${Math.round(yi * 1e8)}`).join(';'),
});
// 腾讯实时行：`v_sh000001="~上证指数~...~成交额万元~..."`，f[37]=两市成交额（万元）。
const tencentBody = (shWan, szWan) => {
  const mk = (code, name, amt) => {
    const f = new Array(50).fill('');
    f[2] = name; f[37] = String(amt);
    return `v_${code}="${f.join('~')}";`;
  };
  return mk('sh000001', '上证指数', shWan) + mk('sz399001', '深证成指', szWan);
};

let calls; // 记录每次 fetch 的 URL（验证腾讯是否被调）
const realFetch = globalThis.fetch;

function installMock({ thsSh, thsSz, txSh, txSz }) {
  calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('d.10jqka.com.cn')) {
      const year = u.match(/\/(\d{4})\.js/)?.[1] ?? '';
      const days = (u.includes('zs_1A0001') ? thsSh : thsSz); // URL 里的指数决定返回哪一市
      const picked = Object.fromEntries(Object.entries(days).filter(([d]) => d.startsWith(year)));
      const text = 'D(1,' + JSON.stringify(thsLine(picked)) + ')';
      return { ok: true, text: async () => text };
    }
    if (u.includes('qt.gtimg.cn')) return { ok: true, text: async () => tencentBody(txSh, txSz) };
    return realFetch(url); // 未预期域段直连（避免假绿）
  };
}

const SH_OK = { '20251230': 7000, '20260105': 7200, '20261007': 7800, '20261008': 8112 };
const SZ_OK = { '20251230': 6000, '20260105': 6300, '20261007': 8709, '20261008': 8709 };
const SH_TRUNC = { '20251230': 7000, '20260105': 7200 }; // 截断版：停在 2026-01（< 锚点 20261008）
const SZ_TRUNC = { '20251230': 6000, '20260105': 6300 };

test.afterEach(() => { globalThis.fetch = realFetch; });

test('场景① 同花顺截断 + 腾讯正常 → 腾讯兜底当日键（值=两市实时合计，一位小数）', async () => {
  installMock({ thsSh: SH_TRUNC, thsSz: SZ_TRUNC, txSh: 81118310, txSz: 87094381 }); // 万元
  const m = await fetchAmountMap({ anchor: '20261008' });
  assert.ok(m, '兜底后 map 非空');
  assert.equal(m['20261008'], 16821.3, '8111.831 + 8709.4381 亿（r1 一位小数）');
  assert.equal(m['20251230'], 13000, '历史截断序列仍保留（真实值）');
  assert.ok(calls.some((u) => u.includes('qt.gtimg.cn')), '腾讯兜底被调用');
});

test('场景② 同花顺完整覆盖锚点 → 腾讯不被调（无副作用）', async () => {
  installMock({ thsSh: SH_OK, thsSz: SZ_OK, txSh: 81118310, txSz: 87094381 });
  const m = await fetchAmountMap({ anchor: '20261008' });
  assert.equal(m['20261008'], 8112 + 8709, '同花顺原值');
  assert.ok(!calls.some((u) => u.includes('qt.gtimg.cn')), '完整序列绝不调腾讯');
});

test('场景③ 同花顺截断 + 腾讯单市脏值（比值护栏拒收）→ 当日键缺失，绝不造假值', async () => {
  installMock({ thsSh: SH_TRUNC, thsSz: SZ_TRUNC, txSh: 81118310, txSz: 0 }); // 深市缺失
  const m = await fetchAmountMap({ anchor: '20261008' });
  assert.ok(m, '历史序列仍在');
  assert.equal(m['20261008'], undefined, '单市冒充两市必须被拒（10-08 上午实录事故回归）');
});

test('场景④ 不传 anchor → 向后兼容：截断序列原样返回，不触发兜底', async () => {
  installMock({ thsSh: SH_TRUNC, thsSz: SZ_TRUNC, txSh: 81118310, txSz: 87094381 });
  const m = await fetchAmountMap();
  assert.ok(m);
  assert.equal(m['20261008'], undefined, '无锚点不兜（backfill_factors 历史行为不变）');
  assert.ok(!calls.some((u) => u.includes('qt.gtimg.cn')));
});
