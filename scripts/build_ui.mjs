// 合并构建（合并方案阶段2/3 · 2026-10-02）：PRO 管线当数据层 + 原系统 UI 当展示层。
// 用法：node scripts/build_ui.mjs [--archive data/archive.json] [--out dist/index.html]
//
// 输入：data/archive.json（PRO 编码存档+分片）、ui/template.html（已改写为读 PRO schema）、
//       ui/src/lab-*.js（实验室模块）、ui/kline/（全市场K线分片）、ui/guide.html、
//       data/board_rank.json（老系统一年板块排行种子）、data/ui_stocks.json（老系统上榜股 closes 种子）、
//       data/calendar.json（PRO 交易日历 → holidays 徽章）
// 输出：dist/index.html（单文件成品）、dist/guide.html、dist/brief-latest.txt、dist/kline/（Pages 伺服）
//
// schema 契约（test/merge_ui.test.mjs 逐项断言——漏字段=UI 白屏，CI 必红）：
//   pageData = { meta{holidays,dataQuality,freshness,lastAttempt,stale,formulaVersion,pageWindowDays},
//                generated, all_days[]（真实交易日，剔除回填占位日）,
//                signals{momentum{fresh,continuing,fading}, industry{top,bottom,asOf,note}},
//                briefs{date:text}, stocks{code:{name,closes}}, board_rank{date:[[name,pct]]} }
//   day 字段 = PRO archive 原生（emotion.value/factors/missing/lhb_daily_net、summary.lhb_daily_*
//   权威口径、themeList 去噪题材+强度分、lhb[] 五元组合并、hot[]、industry[]、indexes）+ build 派生
//   summary.yzt_chg（昨日涨停组合今日均涨幅，由 K 线分片计算——PRO 无此源，派生而非编数）。
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { atomicWriteJSON } from '../src/fsutil.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../src/config.js';
import { decodeArchive } from '../src/lhb_codec.js';
import { enrich } from '../src/pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ARCHIVE = argOf('--archive', path.join(ROOT, 'data', 'archive.json'));
const OUT = argOf('--out', path.join(ROOT, 'dist', 'index.html'));
const PAGE_WINDOW = parseInt(process.env.SENT_PAGE_WINDOW || '250', '10');

const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

// ── 1. 读档 + enrich（themeList/momentum 引擎口径，与管道同实现——不二次实现）──
const arch = decodeArchive(JSON.parse(readFileSync(ARCHIVE, 'utf8')));
const rawDays = (arch.all_days || []).filter((d) => d && d.trade_date);
// 回填占位日（emotion._backfill）只有 s_net 单因子占位值，不是综合分——绝不能进页面
const realDays = rawDays.filter((d) => !(d.emotion && d.emotion._backfill));
if (!realDays.length) { console.error('[build_ui] 无真实交易日，拒绝构建'); process.exit(1); }
const { out, momObj } = enrich(realDays);
const days = out;
const CUR = days[days.length - 1];

// ── 2. K 线分片索引（个股 closes + yzt_chg 派生用）──
const KLINE_DIR = path.join(ROOT, 'ui', 'kline');
const shardOf = (() => {
  const listPath = path.join(KLINE_DIR, '_list.json');
  if (!existsSync(listPath)) return new Map();
  const list = JSON.parse(readFileSync(listPath, 'utf8'));
  // _list.json: { codes: [{c:'sh600000', n:'浦发银行'}, ...] }
  const m = new Map();
  for (const it of list.codes || []) m.set(it.c.replace(/^(sh|sz|bj)/, ''), it.c);
  return m;
})();
const shardCache = new Map(); // code → {name, bars:[[d,o,c,h,l,v]]} | null（缺分片）
function shardOfCode(code) {
  if (shardCache.has(code)) return shardCache.get(code);
  let s = null;
  const file = shardOf.get(code);
  if (file) {
    try { s = JSON.parse(readFileSync(path.join(KLINE_DIR, `${file}.json`), 'utf8')); } catch { s = null; }
  }
  shardCache.set(code, s);
  return s;
}

// ── 3. stocks（个股 closes）：存档涉及个股 ← K 线分片；缺分片回退老系统种子 ──
const seedStocks = existsSync(path.join(ROOT, 'data', 'ui_stocks.json'))
  ? JSON.parse(readFileSync(path.join(ROOT, 'data', 'ui_stocks.json'), 'utf8')) : {};
const involved = new Map(); // code → name（取最近一次出现）
for (const d of days) {
  for (const s of d.lhb || []) involved.set(s.code, s.name);
  for (const s of d.hot || []) involved.set(s.code, s.name);
}
const stocks = {};
let fromShard = 0, fromSeed = 0;
const CLOSES_KEEP = 250; // 与页面滑动窗口对齐：UI 最长用 slice(-40) 走势 + S11 前向收益，250 根足够；全量 640 根会让单文件膨胀到 18MB+
for (const [code, name] of involved) {
  const sh = shardOfCode(code);
  if (sh && Array.isArray(sh.bars) && sh.bars.length) {
    stocks[code] = { name: sh.n || name, closes: sh.bars.slice(-CLOSES_KEEP).map((b) => [b[0], b[2]]) }; // [date, close]
    fromShard++;
  } else if (seedStocks[code] && Array.isArray(seedStocks[code].closes)) {
    stocks[code] = { name: seedStocks[code].name || name, closes: seedStocks[code].closes.slice(-CLOSES_KEEP) };
    fromSeed++;
  }
}

// ── 4. yzt_chg（昨日涨停组合今日均涨幅）：PRO 无此源，由 K 线分片派生（缺数据如实 null）──
const closeMapOf = (code) => {
  const sh = shardOfCode(code);
  if (!sh) return null;
  const m = new Map();
  for (const b of sh.bars || []) m.set(b[0], b[2]);
  return m;
};
let yztDays = 0;
for (let i = 1; i < days.length; i++) {
  const prev = days[i - 1], today = days[i];
  const ztCodes = (prev.summary && prev.summary.zt_codes) || [];
  if (!ztCodes.length) continue;
  const rets = [];
  for (const c of ztCodes) {
    const m = closeMapOf(c);
    if (!m) continue;
    const c1 = m.get(today.trade_date), c0 = m.get(prev.trade_date);
    if (c1 != null && c0 != null && c0 > 0) rets.push((c1 / c0 - 1) * 100);
  }
  if (rets.length) { today.summary.yzt_chg = r2(rets.reduce((a, b) => a + b, 0) / rets.length); yztDays++; }
}

// ── 5. board_rank：老系统一年种子 ∪ 存档每日 industry[] 增量 ──
const boardRank = existsSync(path.join(ROOT, 'data', 'board_rank.json'))
  ? JSON.parse(readFileSync(path.join(ROOT, 'data', 'board_rank.json'), 'utf8')) : {};
let brAdded = 0;
for (const d of days) {
  if (boardRank[d.trade_date] || !Array.isArray(d.industry) || !d.industry.length) continue;
  boardRank[d.trade_date] = d.industry.map((it) => [it.name, r2(it.change_pct)]);
  brAdded++;
}

// ── 6. briefs（每日复盘简报，移植自老 build.js makeBrief——字段切 PRO 权威口径）──
function makeBrief(day, prevDay, allDays) {
  const e = day.emotion || {}, s = day.summary || {};
  const pe = (prevDay && prevDay.emotion) || {};
  const L = [];
  L.push(`【${day.trade_date} 复盘简报】A股市场情绪系统（PRO 管线）`);
  const diff = pe.value != null ? e.value - pe.value : null;
  L.push(`一、情绪面：综合情绪 ${e.value ?? '—'}（历史分位 ${e.pct_rank ?? '—'}%，存档 ${allDays.length} 日内排名）${diff != null ? `，较前值${diff >= 0 ? ' ↑' : ' ↓'}${Math.abs(diff).toFixed(1)}` : ''}。龙虎榜当日榜净买入 ${e.lhb_daily_net == null ? '—' : (e.lhb_daily_net >= 0 ? '+' : '') + e.lhb_daily_net + ' 亿元'}（净买 ${s.net_pos} 家 / 净卖 ${s.net_neg} 家；全量口径 ${s.lhb_all_net ?? '—'} 亿）。`);
  const tp = (day.themeList || [])[0] || {};
  L.push(`二、热点：最热题材「${tp.tag || '—'}」${tp.count || 0} 只（强度 ${tp.score ?? '—'} 分）；题材集中度 ${e.topic_conc ?? '—'}%；同花顺强势股 ${s.hot_count ?? '—'} 只。`);
  const lhb = day.lhb || [];
  if (lhb.length) {
    const sorted = lhb.slice().sort((a, b) => b.net_buy_wan - a.net_buy_wan);
    const top1 = sorted[0], bot1 = sorted[sorted.length - 1];
    const fmt = (v) => (v >= 0 ? '+' : '') + (v / 10000).toFixed(2) + '亿';
    L.push(`三、资金：净买第一「${top1.name}」${fmt(top1.net_buy_wan)}（${top1.reason || '—'}）；净卖第一「${bot1.name}」${fmt(bot1.net_buy_wan)}。上榜个股共 ${lhb.length} 只（同股多榜已合并）。`);
  }
  if (day.industry && day.industry.length) {
    const t = day.industry[0], b = day.industry[day.industry.length - 1];
    L.push(`四、行业：领涨「${t.name}」${t.change_pct > 0 ? '+' : ''}${t.change_pct}%；领跌「${b.name}」${b.change_pct}%。`);
  } else {
    L.push(`四、行业：板块数据缺失，行业广度因子按代理/中性处理（emotion.missing 有留痕）。`);
  }
  L.push(`五、提示：以上为统计口径复盘素材，非行情预测。情绪分位 = 当日在全部存档交易日中的排名。`);
  return L.join('\n');
}
const briefs = {};
days.forEach((d, i) => { briefs[d.trade_date] = makeBrief(d, days[i - 1], days); });

// ── 7. signals.industry（行业 5 日动量，移植自老 build.js——口径不变）──
function addIndustryMomentum() {
  if (days.length < 5) return 0;
  const win = days.slice(-5);
  const acc = new Map();
  win.forEach((d) => (d.industry || []).forEach((it) => {
    const o = acc.get(it.name) || { prod: 1, n: 0 };
    o.prod *= 1 + (it.change_pct || 0) / 100; o.n++;
    acc.set(it.name, o);
  }));
  const rows = [...acc.entries()]
    .filter(([, o]) => o.n === win.length)
    .map(([name, o]) => ({ name, chg5: Math.round((o.prod - 1) * 10000) / 100 }))
    .sort((a, b) => b.chg5 - a.chg5);
  return rows;
}
const indRows = addIndustryMomentum();

// ── 8. pageData 组装（含 250 日滑动窗口——仓库 data/archive.json 永远全量）──
const cal = existsSync(path.join(ROOT, 'data', 'calendar.json'))
  ? JSON.parse(readFileSync(path.join(ROOT, 'data', 'calendar.json'), 'utf8')) : {};
const meta = {
  holidays: Array.isArray(cal.closed) ? cal.closed : [],
  // 行业源健康由存档实况判定（PRO 侧无独立标记位——空板块=失效，如实）
  dataQuality: { industrySourceOk: Array.isArray(CUR.industry) && CUR.industry.length > 0 },
  freshness: arch.meta?.freshness || null,
  lastAttempt: arch.meta?.lastAttempt || null,
  stale: arch.meta?.stale || false,
  staleReason: arch.meta?.staleReason || null,
  formulaVersion: arch.meta?.formulaVersion || config.formulaVersion,
  generatedAt: arch.meta?.generatedAt || new Date().toISOString(),
};
let pageDays = days;
let boardRankPage = boardRank; // 页面注入副本（窗口过滤绝不回写种子——否则写回会毁掉一年历史）
if (PAGE_WINDOW > 0 && days.length > PAGE_WINDOW) {
  const keepSet = new Set(days.slice(-PAGE_WINDOW).map((d) => d.trade_date));
  pageDays = days.slice(-PAGE_WINDOW);
  boardRankPage = Object.fromEntries(Object.entries(boardRank).filter(([k]) => keepSet.has(k)));
  meta.pageWindowDays = PAGE_WINDOW;
  meta.pageWindowNote = `页面仅注入最近 ${PAGE_WINDOW} 个交易日；全档数据留存于仓库 data/archive.json`;
}
const pageData = {
  meta,
  generated: meta.generatedAt.replace('T', ' ').slice(0, 19),
  all_days: pageDays,
  signals: {
    momentum: momObj,
    industry: indRows.length ? {
      top: indRows.slice(0, 8),
      bottom: indRows.slice(-8).reverse(),
      asOf: CUR.trade_date,
      note: '由最近 5 个存档交易日板块涨跌幅复合重建（同花顺行业指数日K）',
    } : { top: [], bottom: [], asOf: CUR.trade_date, note: '存档不足 5 日，行业动量空榜' },
  },
  briefs,
  stocks,
  board_rank: boardRankPage,
};

// ── 9. 模板拼装（函数式 replace：防 JSON/模块代码里的 $&/$$/$' 模式被特殊解释）──
let tpl = readFileSync(path.join(ROOT, 'ui', 'template.html'), 'utf8').replace(/\r\n/g, '\n');
const MODULES = [
  'lab-core.js', 'lab-kline.js', 'lab-s1.js', 'lab-s2.js', 'lab-s5.js', 'lab-s7.js',
  'lab-s6.js', 'lab-s4.js', 'lab-s8.js', 'lab-s3.js', 'lab-s9.js', 'lab-s11.js',
  'vendor/qrcode.min.js', 'lab-sync.js', 'lab-realtime.js',
];
const MOD_ANCHOR = '/*__LAB_MODULES__*/';
if (!tpl.includes(MOD_ANCHOR)) { console.error('[build_ui] 实验室占位符缺失'); process.exit(1); }
if (!tpl.includes('__REPORT_DATA__')) { console.error('[build_ui] 数据占位符缺失'); process.exit(1); }
const modCodes = MODULES.map((f) => {
  const p = path.join(ROOT, 'ui', 'src', f);
  if (!existsSync(p)) { console.error('[build_ui] 模块缺失: ui/src/' + f); process.exit(1); }
  return '// ════ ui/src/' + f + ' ════\n' + readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trim();
});
tpl = tpl.replace(MOD_ANCHOR, () => modCodes.join('\n\n'));
tpl = tpl.replace('__BUILD_AT__', () => pageData.generated);
const json = JSON.stringify(pageData).replace(/<\//g, '<\\/');
tpl = tpl.replace('__REPORT_DATA__', () => json);

// ── 10. 产物落盘 ──
const distDir = path.dirname(OUT);
mkdirSync(distDir, { recursive: true });
writeFileSync(OUT, tpl, 'utf8');
// board_rank 种子增量写回（当日 industry[] 已并入——CI 提交后历史滚动积累；测试模式禁写）
if (!process.env.SENT_NO_WRITEBACK) {
  atomicWriteJSON(path.join(ROOT, 'data', 'board_rank.json'), JSON.stringify(boardRank) + '\n');
}
const lastDate = Object.keys(briefs).sort().pop();
writeFileSync(path.join(distDir, 'brief-latest.txt'), briefs[lastDate] + '\n', 'utf8');
const guideSrc = path.join(ROOT, 'ui', 'guide.html');
if (existsSync(guideSrc)) copyFileSync(guideSrc, path.join(distDir, 'guide.html'));
const kdist = path.join(distDir, 'kline');
let kn = 0;
if (!process.env.SENT_SKIP_KLINE) { // 测试模式跳过 5554 文件拷贝（~150MB，CI 正常构建不设此变量）
  mkdirSync(kdist, { recursive: true });
  for (const f of readdirSync(KLINE_DIR)) {
    if (!f.endsWith('.json')) continue;
    copyFileSync(path.join(KLINE_DIR, f), path.join(kdist, f));
    kn++;
  }
}
console.log(`[build_ui] ${pageDays.length} 个真实交易日（剔回填 ${rawDays.length - realDays.length} 天）· 题材 themeList ×${(CUR.themeList || []).length}`);
console.log(`[build_ui] stocks ${Object.keys(stocks).length} 只（K线分片 ${fromShard} + 种子回退 ${fromSeed}）· yzt_chg 覆盖 ${yztDays}/${days.length - 1} 天 · board_rank ${Object.keys(boardRank).length} 天（增量 +${brAdded}）`);
console.log(`[build_ui] briefs ${Object.keys(briefs).length} 期 · 行业动量 ${indRows.length} 板块 · kline 分片 ${kn} → ${path.relative(ROOT, distDir)}/kline/`);
console.log(`[build_ui] 构建完成: ${OUT} (${(tpl.length / 1024).toFixed(0)} KB)`);
