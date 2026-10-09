// 涨停池情绪历史生成（2026-10-08）：遍历 archive.json 全部交易日，逐日输出情绪状态。
//
// ── 双轨数据源（口径纪律）────────────────────────────────────────────────────
// · 精确轨：data/ztpool_history.json（[{date:'YYYYMMDD', pool:[...]}]，即东财
//   getTopicZTPool 每日快照原样落盘，含 hybk/zbc）。指标由 src/emotion_cycle.js
//   唯一实现计算。该接口**只能取最近交易日**（2026-10-08 实测历史 date 被服务端
//   忽略回退），故精确数据自 --fetch-latest 首跑之日起积累。
// · 近似轨（approx=true）：无 pool 的交易日退回 archive.json all_days[].summary
//   汇总字段——zt_count/lb2_count/max_lb 原值可用；broken_rate ← zb/(zt+zb)、
//   hard_board_rate ← zt/(zt+zb)（触板口径，≠ 池内 zbc 口径，数值系统性偏低）；
//   theme_concentration ← null（archive 无 hybk，主升在该轨永不触发）。
// · 环比状态（复苏/退潮）沿日期链传递前一日 metrics；首日及跨轨交界处口径可能
//   混合，结果按「趋势参考」使用，精确判定以精确轨为准。
//
// 用法：
//   node scripts/emotion_history.mjs                 # 只计算，输出 data/emotion_history.json
//   node scripts/emotion_history.mjs --fetch-latest  # 先抓最近交易日涨停池入库再计算（每日定时跑）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { computeEmotion, computeEmotionMetrics, classifyEmotion, computeEmotionScore } from '../src/emotion_cycle.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const data = (f) => `${ROOT}data/${f}`;
const ymd = (d) => String(d).replace(/-/g, '');
const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);

// ── 精确轨数据源：东财涨停池（与 src/sources.js fetchPools 同端点同参数口径）──
async function fetchLatestPool() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const url = `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fbt%3Aasc&date=${today}&_=${Date.now()}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://quote.eastmoney.com/',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const pool = j?.data?.pool;
  if (!Array.isArray(pool) || !pool.length) return null; // 非交易日/未生成
  return { date: String(j.data.qdate), pool };           // qdate = 服务端实际交易日
}

// ── 近似轨：archive 汇总字段 → 情绪函数兼容形态 ──
function approxMetrics(day) {
  const s = day?.summary || {};
  const zt = +s.zt_count, zb = +s.zb_count;
  if (!Number.isFinite(zt) || zt <= 0) return null;
  const den = Number.isFinite(zb) ? zt + zb : null;
  return {
    limit_up_count: zt,
    continuous_count: Number.isFinite(+s.lb2_count) ? +s.lb2_count : null,
    broken_rate: den ? r4(zb / den) : null,            // 近似口径：收盘炸板/盘中触板
    max_board: Number.isFinite(+s.max_lb) ? +s.max_lb : null,
    theme_concentration: null,                          // archive 无 hybk
    theme_top: null,
    hard_board_rate: den ? r4(zt / den) : null,        // 近似口径：封板率
  };
}

// ── main ──
const fetchLatest = process.argv.includes('--fetch-latest');

// 1. 精确轨数据（--fetch-latest 时先抓当天）
let hist = [];
if (existsSync(data('ztpool_history.json'))) {
  try { hist = JSON.parse(readFileSync(data('ztpool_history.json'), 'utf8')); } catch { hist = []; }
}
if (fetchLatest) {
  const got = await fetchLatestPool();
  if (got) {
    const i = hist.findIndex((x) => x.date === got.date);
    if (i >= 0) hist[i] = got; else hist.push(got);
    hist.sort((a, b) => (a.date < b.date ? -1 : 1));
    writeFileSync(data('ztpool_history.json'), JSON.stringify(hist, null, 1));
    console.log(`[fetch-latest] ${got.date} 涨停池 ${got.pool.length} 只已入库（ztpool_history.json 共 ${hist.length} 天）`);
  } else {
    console.log('[fetch-latest] 接口今日无数据（非交易日或池未生成），跳过');
  }
}
const poolByDate = new Map(hist.map((x) => [x.date, x.pool]));

// 2. 遍历 archive.json 全部交易日
const archive = JSON.parse(readFileSync(data('archive.json'), 'utf8'));
const days = archive?.all_days || [];
const out = [];
let prev = null; // 前一日 metrics（环比链，跨轨口径见模块头注释）
for (const day of days) {
  const d = ymd(day.trade_date);
  const pool = poolByDate.get(d);
  if (Array.isArray(pool) && pool.length) {
    out.push(computeEmotion(pool, prev, d));           // 精确轨
    prev = out[out.length - 1].metrics;
  } else {
    const m = approxMetrics(day);                       // 近似轨
    if (m) {
      out.push({
        date: d, emotion: classifyEmotion(m, prev), score: computeEmotionScore(m),
        metrics: m, approx: true, approx_source: 'archive_summary',
      });
      prev = m;
    } else {
      out.push({ date: d, emotion: 'no_data', score: null, metrics: null, approx: true, approx_source: 'archive_summary' });
      prev = null; // 数据断档，环比链重置
    }
  }
}

// 3. 落盘 + 摘要
const dist = out.reduce((acc, x) => { acc[x.emotion] = (acc[x.emotion] || 0) + 1; return acc; }, {});
const exact = out.filter((x) => !x.approx).length;
const payload = {
  meta: {
    generatedAt: new Date().toISOString(),
    days: out.length,
    exact_days: exact,
    approx_days: out.length - exact,
    rules: 'src/emotion_cycle.js（冰点>退潮>高潮>主升>复苏>震荡；score 六项加权 0-100）',
    caliber_note: 'approx=true 日子来自 archive.json 汇总字段：broken_rate/hard_board_rate 为触板口径（≠池内 zbc 口径）、theme_concentration 为 null（主升不触发）；精确数据自 ztpool_history.json 积累之日起覆盖（接口只能取最近交易日）',
    emotion_dist: dist,
  },
  history: out,
};
writeFileSync(data('emotion_history.json'), JSON.stringify(payload, null, 1));
console.log(`\n情绪历史 ${out.length} 天已写入 data/emotion_history.json（精确 ${exact} / 近似 ${out.length - exact}）`);
console.log('状态分布:', JSON.stringify(dist));
console.log('\n最近 10 天:');
for (const x of out.slice(-10)) {
  const m = x.metrics || {};
  console.log(`  ${x.date}  ${x.emotion.padEnd(4, ' ')} score=${x.score == null ? '—' : x.score}`
    + `  涨停${m.limit_up_count ?? '—'} 连板${m.continuous_count ?? '—'} 炸板率${m.broken_rate ?? '—'} 最高${m.max_board ?? '—'} 集中度${m.theme_concentration ?? '—'}${x.approx ? '  [近似]' : ''}`);
}
