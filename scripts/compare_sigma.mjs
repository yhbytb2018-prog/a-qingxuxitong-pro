// σ 对比回测（2026-10-07）：不碰 config.json，内存克隆配置覆盖 mainLine.sigma_multiplier，
// 逐日复刻 scripts/backtest.mjs 的主线识别链路（动态阈值 → 总阀门 gating → selectMainLine），
// 对比不同 σ 下的触发天数 / 识别率 / 逐日触发差异。
//
// 用法：node scripts/compare_sigma.mjs --days 60 --sigmas 0.5,1.0
//
// 口径对齐正式管线（scripts/backtest.mjs 162-209 行）：
//   · mlHistory = 截至前一日的全部非回填交易日（computeDynamicThreshold 内部截 lookback 窗）
//     ——up_count = 当日题材榜第一名的涨停家数，density = 该涨停数 ÷ 当日全题材涨停数；
//   · market_state：近 10 日（不含当日）量能 × 上证累计涨跌代理（archive 无指数点位序列）；
//   · sentiment_state：昨日主线龙头（旧口径排序第一、无阈值——「昨日龙头是谁」是事实不是门槛，
//     与 σ 无关）今日涨跌；找不到 → stable；
//   · gating 后 topN = min(2, maxOutput)；triggered = mains.length > 0。
// 差异说明：market_state / sentiment_state 不依赖 σ（预计算一次共用），σ 只作用于动态阈值。

import { readFileSync, writeFileSync } from 'node:fs';
import { default as config } from '../src/config.js';
import { decodeArchive } from '../src/lhb_codec.js';
import {
  computeDynamicThreshold, selectMainLine,
  assessMarketState, assessSentimentState, applyMainLineGating,
} from '../src/backtest.js';

// ── CLI：--days N（默认 60）、--sigmas a,b（默认 0.5,1.0，可多个） ──
const argOf = (name, dft) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dft;
};
const N_DAYS = Math.max(2, Math.trunc(+argOf('--days', 60)) || 60);
const SIGMAS = String(argOf('--sigmas', '0.5,1.0')).split(',')
  .map((s) => +String(s).trim()).filter((s) => Number.isFinite(s) && s >= 0);
if (SIGMAS.length < 1) {
  console.error('[compare_sigma] --sigmas 至少需要一个 ≥0 的数值（逗号分隔，多个则对比）');
  process.exit(1);
}
const COMPARE = SIGMAS.length >= 2; // 单 σ：纯回放统计（无不一致对比段）
const OUT_PATH = argOf('--out', 'data/sigma_compare.json');

// ── 样本：非回填交易日（与 scripts/backtest.mjs 同一过滤口径） ──
const arch = decodeArchive(JSON.parse(readFileSync('data/archive.json', 'utf8')));
const allDays = (arch.all_days || []).filter((d) => d && d.trade_date && !(d.emotion && d.emotion._backfill));
if (allDays.length < N_DAYS + 11) {
  console.error(`[compare_sigma] 样本不足：非回填日仅 ${allDays.length}，需 ${N_DAYS + 11}（${N_DAYS} 回放 + 11 门阀窗）`);
  process.exit(1);
}
const startK = allDays.length - N_DAYS; // 回放区间：最后 N_DAYS 天
const days = allDays.slice(0, startK + N_DAYS);
const GATE_IDX = '上证指数';

// 预计算①：逐日 (theme_up_count, theme_density)——σ 无关，slice(0,k) 即历史
const preHist = days.map((d) => {
  const e = Object.entries(d.themes || {}).filter(([, c]) => Number.isFinite(+c));
  const tot = e.reduce((a, [, c]) => a + (+c), 0) || 1;
  const mx = e.length ? Math.max(...e.map(([, c]) => +c)) : 0;
  return { date: d.trade_date, theme_up_count: mx, theme_density: mx / tot };
});
// 预计算②：逐日 market_state / sentiment_state——σ 无关
const preState = days.map((d, k) => {
  const gateWin = days.slice(Math.max(0, k - 11), k); // 昨日及以前共 ≤10 日（不含当日）
  const volHist = gateWin.map((x) => +x.summary?.amount_yi);
  const cumIdx = gateWin.reduce((a, x) => a + (+(x.indexes?.[GATE_IDX]) || 0), 0);
  const market_state = assessMarketState(
    { volume: +d.summary?.amount_yi, index_price: cumIdx, index_ma: 0 }, volHist, config.mainLine);
  let sentiment_state = 'stable';
  const yday = days[k - 1];
  if (yday) {
    const yMain = selectMainLine(yday, 1).mains[0] || null; // 昨日龙头：无阈值旧口径（与正式管线一致）
    const yLeader = yMain?.stocks?.[0] || null;
    const yQuote = yLeader ? (d.hot || []).find((h) => String(h.code) === String(yLeader.code)) : null;
    sentiment_state = assessSentimentState(yMain, yQuote ? { changePct: yQuote.change_pct } : null, config.mainLine);
  }
  return { market_state, sentiment_state };
});

// ── 逐 σ × 逐日回放 ──
const perDay = [];
const summaryBySigma = new Map(SIGMAS.map((s) => [s, {
  sigma: s, triggered: 0, weak_days: 0, retreat_days: 0, fallback_days: 0, mainThemes: 0,
}]));
for (let k = startK; k < days.length; k++) {
  const day = days[k];
  const hist = preHist.slice(0, k); // 历史不含当日
  const st = preState[k];
  const row = { date: day.trade_date, market_state: st.market_state, sentiment_state: st.sentiment_state, by_sigma: {} };
  for (const sigma of SIGMAS) {
    const cfg = structuredClone(config.mainLine); // 内存覆盖：不碰 config.json
    cfg.sigma_multiplier = sigma;
    const th = computeDynamicThreshold(hist, cfg);
    const gated = applyMainLineGating(th, st, cfg);
    const topN = gated.maxOutput != null ? Math.min(2, gated.maxOutput) : 2;
    const ml = selectMainLine(day, topN, gated.threshold);
    const rec = {
      mode: th.mode || 'dynamic',
      up_threshold: Math.round(gated.threshold.up_count_threshold * 100) / 100,
      density_threshold: Math.round(gated.threshold.density_threshold * 1e4) / 1e4,
      triggered: ml.mains.length > 0,
      main_count: ml.mains.length,
      themes: ml.mains.map((m) => m.theme),
    };
    row.by_sigma[String(sigma)] = rec;
    const s = summaryBySigma.get(sigma);
    if (rec.triggered) s.triggered++;
    if (rec.mode === 'fallback') s.fallback_days++;
    if (st.market_state === 'weak') s.weak_days++;
    if (st.sentiment_state === 'retreating') s.retreat_days++;
    s.mainThemes += rec.main_count;
  }
  perDay.push(row);
}

// ── 汇总与差异 ──
const total = perDay.length;
const summary = SIGMAS.map((s) => {
  const x = summaryBySigma.get(s);
  return {
    sigma: s, triggered_days: x.triggered, total_days: total,
    identification_rate: Math.round((x.triggered / total) * 1000) / 10,
    weak_days: x.weak_days, retreat_days: x.retreat_days,
    fallback_days: x.fallback_days, main_theme_count: x.mainThemes,
  };
});
// 触发不一致：任一 σ 的 triggered 与其他不同（含主线数差异仅作附加信息，不单独算不一致）
const disagreements = perDay.filter((r) => {
  const vals = SIGMAS.map((s) => r.by_sigma[String(s)].triggered);
  return vals.some((v) => v !== vals[0]);
});
// 题材分布统计：各题材触发天数（一日本题材多计则按「该日入选」计一次）与占比
const themeStats = new Map();
for (const r of perDay) {
  for (const s of SIGMAS) {
    for (const t of r.by_sigma[String(s)].themes) {
      const x = themeStats.get(t) || { theme: t, days: 0 };
      x.days++;
      themeStats.set(t, x);
    }
  }
}
const themeStatsArr = [...themeStats.values()].sort((a, b) => b.days - a.days || a.theme.localeCompare(b.theme));

// 阈值漂移监控：gating 后 up_threshold 的区间/峰值/高阈值天数与对应触发率。
// 单 σ → 直接对象；多 σ → 按 σ 字符串分组（结构同）。触发率分母为 0 时为 null（无样本不猜）。
const driftOf = (sigma) => {
  const seq = perDay.map((r) => ({ date: r.date, up: r.by_sigma[String(sigma)].up_threshold, hit: r.by_sigma[String(sigma)].triggered }));
  let max = -Infinity, maxDate = null;
  for (const x of seq) if (Number.isFinite(x.up) && x.up > max) { max = x.up; maxDate = x.date; }
  const above10 = seq.filter((x) => x.up >= 10);
  const above12 = seq.filter((x) => x.up >= 12);
  const rate = (arr) => arr.length ? Math.round((arr.filter((x) => x.hit).length / arr.length) * 1000) / 10 : null;
  return {
    start: seq.length ? seq[0].up : null,
    end: seq.length ? seq[seq.length - 1].up : null,
    max: maxDate != null ? max : null,
    max_date: maxDate,
    days_above_10: above10.length,
    days_above_12: above12.length,
    trigger_rate_above_10: rate(above10),
    trigger_rate_above_12: rate(above12),
  };
};
const driftBySigma = SIGMAS.map((s) => [String(s), driftOf(s)]);

// ── 终端报告 ──
console.log(`\n[compare_sigma] 样本：${total} 个非回填交易日（${perDay[0]?.date} ~ ${perDay[perDay.length - 1]?.date}），lookback=${config.mainLine.lookback_days}，min_sample=${config.mainLine.min_sample_days}\n`);
const pad = (v, w) => String(v).padEnd(w, ' ');
console.log(`${pad('σ', 6)}${pad('触发天数', 10)}${pad('识别率', 9)}${pad('weak日', 7)}${pad('退潮日', 7)}${pad('降级日', 7)}主线题材总数`);
for (const s of summary) {
  console.log(`${pad(s.sigma, 6)}${pad(`${s.triggered_days}/${s.total_days}`, 10)}${pad(s.identification_rate + '%', 9)}${pad(s.weak_days, 7)}${pad(s.retreat_days, 7)}${pad(s.fallback_days, 7)}${s.main_theme_count}`);
}
console.log(`\n题材分布（各题材触发天数 · 占比=题材天数 ÷ 触发日数合计，同日多题材分别计）：`);
{
  const totalThemeDays = themeStatsArr.reduce((a, x) => a + x.days, 0) || 1;
  for (const x of themeStatsArr) {
    console.log(`  ${pad(x.theme, 14)} ${pad(x.days + ' 天', 8)} ${Math.round((x.days / totalThemeDays) * 1000) / 10}%`);
  }
}
console.log(`\n逐日触发明细（未触发日以 - 标注）：`);
for (const r of perDay) {
  const parts = SIGMAS.map((s) => {
    const rec = r.by_sigma[String(s)];
    return `${SIGMAS.length >= 2 ? `σ${s}: ` : ''}${rec.triggered ? `up≥${rec.up_threshold} → ${rec.themes.join('、')}${rec.main_count > 1 ? `（${rec.main_count}条）` : ''}` : 'up≥' + rec.up_threshold + ' 未达'}`;
  });
  console.log(`  ${r.date} ${pad(r.market_state, 7)} ${pad(r.sentiment_state, 9)} ${parts.join(' | ')}`);
}
if (COMPARE) {
  console.log(`\n触发不一致的日期（${disagreements.length} 天）：`);
  if (!disagreements.length) {
    console.log('  （无——各 σ 在全部样本日触发状态一致）');
  } else {
    for (const r of disagreements) {
      const parts = SIGMAS.map((s) => {
        const rec = r.by_sigma[String(s)];
        return `σ${s}: ${rec.triggered ? `触发(${rec.main_count})` : '未触发'} up≥${rec.up_threshold}`;
      });
      console.log(`  ${r.date} | market=${r.market_state} | ${parts.join(' | ')}`);
    }
  }
}
console.log(`\n阈值漂移监控：`);
for (const [key, dr] of driftBySigma) {
  const rateTxt = (r) => (r == null ? '—' : r + '%');
  console.log(`  ${COMPARE ? `σ${key} ` : ''}区间：${dr.start} → ${dr.end}，最高 ${dr.max}${dr.max_date ? `（${dr.max_date}）` : ''}`);
  console.log(`  阈值≥10：${dr.days_above_10} 天，触发率 ${rateTxt(dr.trigger_rate_above_10)}`);
  console.log(`  阈值≥12：${dr.days_above_12} 天，触发率 ${rateTxt(dr.trigger_rate_above_12)}`);
}
console.log(`  提示：若阈值持续>12 且触发率<30%，建议复核 lookback 或 σ`);

// ── 落盘（完整逐日明细，供人工/后续脚本分析） ──
const payload = {
  meta: {
    generatedAt: arch.meta?.generatedAt || new Date().toISOString(),
    tool: 'scripts/compare_sigma.mjs',
    days: N_DAYS, sigmas: SIGMAS, total_days: total,
    range: [perDay[0]?.date, perDay[perDay.length - 1]?.date],
    caliber: '与 scripts/backtest.mjs 主线链路同口径：mlHistory 不含当日；market_state=量能×上证累计涨跌代理；sentiment=昨日主线龙头(无阈值口径)今日涨跌；gating 后 topN=min(2,maxOutput)',
    mainLine: {
      lookback_days: config.mainLine.lookback_days,
      min_sample_days: config.mainLine.min_sample_days,
      fixedFallback: config.mainLine.fixedFallback,
      top_n: config.mainLine.top_n,
    },
  },
  summary,
  per_day: perDay,
  theme_stats: themeStatsArr.map((x) => ({ ...x })),
  // 单 σ：直接对象；多 σ：按 σ 分组（结构同 driftOf 返回值）
  threshold_drift: COMPARE ? Object.fromEntries(driftBySigma) : driftBySigma[0][1],
  disagreements: COMPARE ? disagreements.map((r) => r.date) : undefined,
};
writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n');
console.log(`\n[compare_sigma] 明细已写出 ${OUT_PATH}（per_day ${perDay.length} 条 · 不一致 ${disagreements.length} 天）`);
