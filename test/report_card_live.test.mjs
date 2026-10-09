// ─────────────────────────────────────────────────────────────────────────────
// S3-4 AI 盘中报告卡（src/report_card_live.js）——生成器复用路线的单测面：
//   ① 逐位对齐：buildLiveReport 产出的实时信封与桥数据逐位一致（信封唯一出处，
//     卡面零自算——nav_realtime / dd_now / distance_pp / max_drawdown_daily）；
//   ② 降级零拼凑：任一源 fetch 失败 → 整体 null（用户决议：不许部分成功部分失败）；
//   ③ "估值非结算"标注：generated_by==='browser' → isValuation；CI 归档 → 否；
//   ④ 源缓存：同日 5 源只拉一次；跨日重拉；intraday.json 30 分钟 TTL 独立计时。
// 数据面用真实 data/ 档（与 CI build_ai_report.mjs 同一份输入），不造假夹具。
// ─────────────────────────────────────────────────────────────────────────────
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildLiveReport, cardData, resetReportCardCache, INTRADAY_TTL_MS } from '../src/report_card_live.js';
import { buildLiveAccount, liveAccountStats, riskTierDistance } from '../src/intraday_live.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readData = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const DAY_FILES = {
  'data/paper/dual_track_latest.json': 'dualTrack',
  'data/signals-latest.json': 'signals',
  'data/global.json': 'global',
  'data/backtest.json': 'backtest',
  'data/ops-alerts-latest.json': 'opsAlerts',
};
const REAL = {};
for (const url of Object.keys(DAY_FILES)) REAL[url] = readData(url);
REAL['data/intraday.json'] = readData('data/intraday.json');

/** 桥形态（src/intraday_sampler.js publish() 的产物） */
const mkBridge = (equityRealtime = 986965.14) => {
  const account = buildLiveAccount({
    navSeries: [{ date: '2026-09-29', equity: 985000 }],
    equityRealtime,
    tradeDate: '2026-09-30',
    initCash: 1000000,
  });
  return { account, stats: liveAccountStats(account), drawdownDaily: 0.03123, updatedAt: '2026-09-30T02:35:00Z' };
};

/** fake fetch：默认全成功（真实档）；可指定某 url 抛错 / 计数 */
function mkGetJson({ failUrls = [] } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (failUrls.includes(url)) throw new Error(`fetch fail: ${url}`);
    const v = REAL[url];
    if (v === undefined) throw new Error(`unexpected url: ${url}`);
    return structuredClone(v);
  };
  fn.calls = calls;
  return fn;
}

test('① 逐位对齐：实时信封与桥数据逐位一致（信封唯一出处，卡面零自算）', async () => {
  resetReportCardCache();
  const bridge = mkBridge();
  const env = await buildLiveReport(bridge, { getJson: mkGetJson(), today: () => '2026-10-07', now: () => 1e12 });
  assert.ok(env, '全源就绪 → 信封非 null');
  assert.equal(env.generated_by, 'browser', '浏览器即时轨');
  assert.equal(env.report_type, 'intraday');
  // 逐位对齐（对齐基准 = 桥的 stats / drawdownDaily，与采样器同源）
  assert.equal(env.payload.nav_realtime, bridge.stats.total, 'nav_realtime = 桥 stats.total（实时权益）');
  assert.ok(Math.abs(env.payload.drawdown_vs_threshold.dd_now - Math.abs(bridge.stats.drawdown)) < 1e-12, 'dd_now = 总回撤实时版');
  assert.equal(env.payload.max_drawdown_daily, bridge.drawdownDaily, 'max_drawdown_daily = 桥当日序列峰谷（S3-1 注入点）');
  assert.match(env.payload.drawdown_vs_threshold.basis, /即时轨/, 'basis 切即时轨');
  assert.ok(Math.abs(env.payload.drawdown_vs_threshold.distance_pp - riskTierDistance(bridge.stats.drawdown) * 100) < 0.01,
    '距风控档与快照卡同尺（报告侧展示口径舍入到 0.01pp）');
  // data_health 与 CI 报告同构：intraday 源在场（非 missing 拼凑）
  assert.ok(env.data_health.sources.intraday, 'intraday 健康标记在场');
});

test('② 降级零拼凑：任一源失败 → 整体 null；缓存未清，重试可恢复', async () => {
  resetReportCardCache();
  const bridge = mkBridge();
  const today = () => '2026-10-07';
  const now = () => 1e12;
  const failAll = mkGetJson({ failUrls: ['data/backtest.json'] }); // 6 源之一失败
  const r1 = await buildLiveReport(bridge, { getJson: failAll, today, now });
  assert.equal(r1, null, '整体降级为 null，不拼凑部分数据');
  assert.equal(failAll.calls.length, 6, '首次尝试拉满 6 源（不因单源失败短路）');
  // 重试（全部成功）：恢复实时信封——失败的尝试没有污染任何缓存
  const r2 = await buildLiveReport(bridge, { getJson: mkGetJson(), today, now });
  assert.ok(r2, '重试全源成功 → 信封恢复');
});

test('③ "估值非结算"标注：browser 即时轨 → isValuation；CI 归档 → 否（同投影函数）', async () => {
  resetReportCardCache();
  const env = await buildLiveReport(mkBridge(), { getJson: mkGetJson(), today: () => '2026-10-07', now: () => 1e12 });
  const live = cardData(env);
  assert.equal(live.isValuation, true, '即时估值轨 → 卡面标注"估值非结算"');
  // CI 归档报告同过 cardData（形态统一，渲染层无需区分）
  const archived = cardData(readData('data/reports/intraday_2026-09-30.json'));
  assert.ok(archived, '归档信封投影成功（与实时同构）');
  assert.equal(archived.isValuation, false, '归档轨 → 不标估值');
  assert.equal(archived.generatedBy, 'ci');
  assert.equal(cardData(null), null, '非法入参 → null');
  // 归档基座字段面：卡面消费的字段全部可投影（schema 同构的证据）
  for (const k of ['navRealtime', 'maxDrawdownDaily', 'ddNow', 'distancePp', 'basis', 'status', 'missingNotes']) {
    assert.ok(k in archived, `归档投影含 ${k}`);
  }
});

test('④ 源缓存：同日 5 源一次；跨日重拉；intraday.json 30 分钟 TTL 独立', async () => {
  resetReportCardCache();
  const bridge = mkBridge();
  let day = '2026-10-07';
  let t = 1e12;
  const io = () => ({ today: () => day, now: () => t });
  const g1 = mkGetJson();
  await buildLiveReport(bridge, { getJson: g1, ...io() });
  assert.equal(g1.calls.length, 6, '首次：6 源全拉');
  // 同日 +10 分钟：5 日源缓存、intraday TTL 内 → 零 fetch
  t += 10 * 60 * 1000;
  const g2 = mkGetJson();
  await buildLiveReport(bridge, { getJson: g2, ...io() });
  assert.equal(g2.calls.length, 0, '同日 10 分钟内：全部走缓存');
  // 同日 +31 分钟：仅 intraday.json 过期 → 只重拉它
  t += 21 * 60 * 1000;
  const g3 = mkGetJson();
  await buildLiveReport(bridge, { getJson: g3, ...io() });
  assert.deepEqual(g3.calls, ['data/intraday.json'], '31 分钟后：仅 intraday.json（30 分钟 TTL）');
  // 跨日：5 日源整组重拉（intraday 缓存仍新鲜 → 不重拉）
  day = '2026-10-08'; t += 60 * 1000;
  const g4 = mkGetJson();
  await buildLiveReport(bridge, { getJson: g4, ...io() });
  assert.equal(g4.calls.length, 5, '跨日：5 日源重拉');
  assert.ok(!g4.calls.includes('data/intraday.json'), 'intraday TTL 未到不重拉');
  // TTL 常量对齐 CI 快照周期
  assert.equal(INTRADAY_TTL_MS, 30 * 60 * 1000);
});
