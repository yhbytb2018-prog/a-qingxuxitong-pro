#!/usr/bin/env node
// ── 多栏目静态 HTML 日报生成器（reports_html/）────────────────────────────
//
// 用途：读 data/ 真实数据档 → 渲染自包含 HTML 日报页（每栏目按交易日
//   YYYYMMDD.html 命名 + 栏目首页归档 + 根导航），风格对齐外部短线日报站。
//
// 用法：
//   node scripts/build_reports_html.mjs                 # 按数据内最新交易日生成
//   node scripts/build_reports_html.mjs --date 2026-10-09
//
// 纪律：与 build_ai_report.mjs 同源同律——只读 data/、只写 reports_html/；
//   缺失字段渲染为「—」，不允许补 0；脚本只做渲染拼装，不做口径计算
//   （市场状态/情绪相位等直接引用各口径唯一来源文件的现成字段）。
//
// 数据依赖（全部已存在于 data/）：
//   signals-latest.json       涨停/跌停/炸板计数、指数、板块强弱（src/pipeline.js 产物）
//   intraday.json             盘中池（涨停池/炸板/最高连板）、广度
//   global.json               外围行情（src/global.js 唯一口径）
//   paper/dual_track_latest.json  regime 相位与仓位建议
//   board_rank.json           板块涨幅榜（按日期）
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'reports_html');

const argv = process.argv.slice(2);
const dateArg = (() => { const i = argv.indexOf('--date'); return i >= 0 ? argv[i + 1] : null; })();
// --only col1,col2：只生成指定栏目（盘中定时挂点用，如 09:00 早盘 / 09:30 竞价）
const onlyArg = (() => { const i = argv.indexOf('--only'); return i >= 0 ? argv[i + 1] : null; })();
const ONLY = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim())) : null;
// --force：旁路周五门禁（补生成历史周报用）
const FORCE = argv.includes('--force');

// ── 读数（缺失 → null，渲染为「—」）────────────────────────────────────────
const readJson = (rel) => {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};

const signals = readJson('data/signals-latest.json');
const intraday = readJson('data/intraday.json');
const globalData = readJson('data/global.json');
const dualTrack = readJson('data/paper/dual_track_latest.json');
const boardRank = readJson('data/board_rank.json');
const breadthLatest = readJson('data/breadth-latest.json');
const stockDetail = readJson('data/stock_detail.json');   // 个股级涨跌停明细（fetch_stock_detail.mjs）
const arbSources = readJson('data/arb_sources.json');      // 转债/正股联动（fetch_arb_sources.mjs）
const hotNews = readJson('data/hot_news.json');            // 热点题材快讯（fetch_hot_news.mjs）
const prejudgeDetail = readJson('data/prejudge_detail.json'); // 盘中预判明细（fetch_prejudge_data.mjs）

// 交易日：--date > signals 口径 > intraday 口径；推不出则退出（不猜日期）
const tradeDate = dateArg
  || signals?.meta?.tradeDate || null
  || intraday?.tradeDate || null;
if (!tradeDate) {
  console.error('[reports-html] 推不出交易日（signals/intraday 均无 tradeDate），退出');
  process.exit(1);
}
const ymd = tradeDate.replaceAll('-', '');

// ── 渲染工具 ────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// A 股配色：红涨绿跌
const signCls = (v) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
const pct = (v, dp = 2) => (v == null ? '<span class="na">—</span>'
  : `<span class="${signCls(v)}">${v > 0 ? '+' : ''}${Number(v).toFixed(dp)}%</span>`);
const num = (v, dp = 0, suffix = '') => (v == null ? '<span class="na">—</span>'
  : `${Number(v).toFixed(dp)}${suffix}`);
const dash = '<span class="na">—</span>';

// ── 通用页面骨架（自包含，无外部依赖）──────────────────────────────────────
const COLS = [
  { key: 'morning', label: '早盘快报', live: true },
  { key: 'emotion', label: '情绪扫描', live: true },
  { key: 'pick', label: '短线选股', live: true },
  { key: 'premarket', label: '盘前备忘', live: true },
  { key: 'prejudge', label: '盘中预判', live: true },
  { key: 'auction', label: '竞价复盘', live: true },
  { key: 'arb', label: '套利日报', live: true },
  { key: 'dualview', label: '涨停双视角', live: true },
  { key: 'mainboard', label: '主板接力', live: true },
  { key: 'wave2', label: '二波扫描', live: true },
  { key: 'mindmap', label: '题材导图', live: true },
  { key: 'predict', label: '次日预测', live: true },
  { key: 'weekly', label: '周度复盘', live: true },
  { key: 'news', label: '热点新闻', live: true },
];
// 目录名 = 中文名（用户可见目录即栏目名）；key 仅作内部索引
for (const c of COLS) c.dir = c.label;
const LIVE_COLS = COLS.filter((c) => c.live).map((c) => c.key);

const PAGE_CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; background:#f4f6f8; color:#1f2328; padding:20px; line-height:1.7; }
h1 { color:#0a66c2; border-bottom:2px solid #d8dee4; padding-bottom:12px; margin-bottom:8px; font-size:24px; }
h2 { color:#1f2328; margin:24px 0 12px 0; padding-left:12px; border-left:4px solid #58a6ff; font-size:18px; }
h3 { color:#1f2328; margin:16px 0 8px 0; font-size:15px; }
.sub { color:#5b6570; font-size:13px; margin-bottom:20px; }
.rpt-nav { display:flex; gap:8px; justify-content:center; flex-wrap:wrap; padding:10px 6px; margin:0 0 22px; background:rgba(255,255,255,.94); border-bottom:1px solid #d8dee4; }
.rpt-nav a { font-size:.86em; padding:6px 12px; border-radius:6px; background:#eef1f4; color:#1f2328; text-decoration:none; }
.rpt-nav a.cur { background:#0a66c2; color:#fff; }
.metric-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; margin-bottom:24px; }
.metric { background:#fff; border:1px solid #d8dee4; border-radius:8px; padding:14px 16px; }
.metric-label { color:#5b6570; font-size:12px; margin-bottom:6px; }
.metric-value { font-size:22px; font-weight:600; }
table { width:100%; border-collapse:collapse; background:#fff; border-radius:6px; overflow:hidden; margin-top:12px; font-variant-numeric:tabular-nums; }
th { background:#eef1f4; color:#5b6570; text-align:left; padding:10px 12px; font-size:13px; font-weight:600; border-bottom:1px solid #d8dee4; }
td { padding:8px 12px; border-bottom:1px solid #d8dee4; font-size:13px; }
.up { color:#cf222e; font-weight:600; }
.down { color:#1a7f37; font-weight:600; }
.na { color:#8b949e; }
.warn-box { background:#fdf0e2; border:1px solid #d29922; border-radius:8px; padding:14px 16px; margin:16px 0; font-size:13px; }
.info-box { background:#eaf3fb; border:1px solid #58a6ff; border-radius:8px; padding:14px 16px; margin:16px 0; font-size:13px; }
.section { background:#fff; border:1px solid #d8dee4; border-radius:8px; padding:18px 20px; margin-bottom:20px; }
.tag { display:inline-block; padding:2px 10px; border-radius:12px; font-size:12px; font-weight:600; margin-right:6px; }
.tag.up { background:#ffebe9; } .tag.down { background:#dafbe1; }
footer { margin-top:32px; color:#5b6570; font-size:12px; text-align:center; }
`;

function pageHtml({ title, colKey, body }) {
  const nav = COLS.map((c) => `<a href="./../${encodeURIComponent(c.dir)}/index.html"${c.key === colKey ? ' class="cur"' : ''}>${c.label}</a>`).join('');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<nav class="rpt-nav"><a href="./../index.html">🏠 首页</a>${nav}<a href="./index.html">🗂️ 归档</a></nav>
${body}
<footer>数据来源：data/ 管道产物 · 缺失项标注「—」而非补 0 · 本页不构成投资建议</footer>
</body>
</html>
`;
}

const writePage = (rel, html) => {
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, html);
};

// 已有归档扫描（栏目首页用）
const listArchive = (col) => {
  const dir = join(OUT, col);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d{8}\.html$/.test(f)).sort().reverse();
};

// ── 公共数据摘要（三栏目共用，均允许缺失）──────────────────────────────────
const sig = signals?.latest ?? null;
const meta = signals?.meta ?? null;
const pools = intraday?.pools ?? null;
const reg = dualTrack?.day?.regime ?? null;
const idx = sig?.indexes ?? null;
const relVs = signals?.relative?.vsIndex ?? null;
const boardRows = boardRank?.[tradeDate] ?? null; // [板块名, 涨幅] 列表
const br = intraday?.breadth ?? breadthLatest?.updown ?? null;

// 个股级明细（仅当日档使用，日期不符按缺失处理；档内 tradeDate 为 ymd 紧凑格式）
const sd = stockDetail && (stockDetail.tradeDate === ymd || stockDetail.tradeDate === tradeDate) ? stockDetail : null;
const ztRows = sd?.zt ?? [];
const dtRows = sd?.dt ?? [];
const zbRows = sd?.zb ?? [];
const ztByLb = [...ztRows].sort((a, b) => (b.lb ?? 0) - (a.lb ?? 0) || (a.firstSeal ?? 0) - (b.firstSeal ?? 0));
const hhmm = (t) => (t == null ? dash : `${String(Math.floor(t / 10000)).padStart(2, '0')}:${String(Math.floor((t % 10000) / 100)).padStart(2, '0')}`);
const yi = (v, dp = 1) => (v == null ? dash : `${(v / 1e8).toFixed(dp)} 亿`); // 元 → 亿
const stockRow = (s, extra = '') => `<tr>
  <td><span style="font-variant-numeric:tabular-nums">${esc(s.code)}</span> ${esc(s.name)}</td>
  <td>${pct(s.pct)}</td><td>${num(s.price, 2)}</td><td>${esc(s.industry ?? '—')}</td>
  <td>${s.lb != null ? `${s.lb} 板` : dash}</td><td>${hhmm(s.firstSeal)}</td>
  <td>${num(s.brokenTimes)}</td><td>${yi(s.sealFund)}</td>${extra}</tr>`;
const STOCK_THEAD = '<thead><tr><th>个股</th><th>涨跌幅</th><th>现价</th><th>行业</th><th>连板</th><th>首封</th><th>炸板</th><th>封单</th></tr></thead>';
const groupByIndustry = (rows) => {
  const g = new Map();
  for (const r of rows) {
    const k = r.industry ?? '未分类';
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  return [...g.entries()].sort((a, b) => b[1].length - a[1].length);
};
const missingStock = `<div class="warn-box">个股级明细缺失（data/stock_detail.json 无 ${esc(tradeDate)} 档，先跑 scripts/fetch_stock_detail.mjs）。</div>`;

const marketStateCard = () => `
<div class="section">
  <h2>一、市场状态</h2>
  <div class="metric-grid">
    ${(idx ? Object.entries(idx) : [['上证指数', null], ['深证成指', null], ['创业板指', null]]).map(([k, v]) => `
    <div class="metric"><div class="metric-label">${esc(k)}</div><div class="metric-value">${pct(v)}</div></div>`).join('')}
    <div class="metric"><div class="metric-label">涨停 / 炸板 / 跌停</div><div class="metric-value">${num(pools?.zt)} / ${num(pools?.zb)} / ${num(pools?.dt)}</div></div>
    <div class="metric"><div class="metric-label">最高连板</div><div class="metric-value">${pools?.max_lb != null ? `${pools.max_lb} 板` : dash}</div></div>
    <div class="metric"><div class="metric-label">炸板率</div><div class="metric-value">${(pools?.zt != null && pools?.zb != null && pools.zt + pools.zb > 0) ? pct((pools.zb / (pools.zt + pools.zb)) * 100) : dash}</div></div>
    <div class="metric"><div class="metric-label">两市成交额</div><div class="metric-value">${num(sig?.amount_yi, 1, ' 亿')}</div></div>
    <div class="metric"><div class="metric-label">涨停封板率</div><div class="metric-value">${num(sig?.seal_pct, 1, '%')}</div></div>
  </div>
</div>`;

const regimeCard = () => `
<div class="section">
  <h2>情绪周期定位</h2>
  <div class="metric-grid">
    <div class="metric"><div class="metric-label">市场状态</div><div class="metric-value">${reg ? esc(reg.label) : dash}</div></div>
    <div class="metric"><div class="metric-label">情绪得分</div><div class="metric-value">${num(dualTrack?.day?.score, 1)}</div></div>
    <div class="metric"><div class="metric-label">建议仓位上限</div><div class="metric-value">${reg?.cap != null ? pct(reg.cap * 100, 0) : dash}</div></div>
    <div class="metric"><div class="metric-label">主力题材</div><div class="metric-value" style="font-size:16px">${sig?.main_theme?.name ? esc(sig.main_theme.name) : dash}</div></div>
  </div>
</div>`;

// ── emotion 栏目 ────────────────────────────────────────────────────────────
function renderEmotion() {
  const attack = relVs?.attack ?? [];
  const defense = relVs?.defense ?? [];
  const boardList = (rows) => rows.slice(0, 15).map(([name, chg]) => `
    <tr><td>${esc(name)}</td><td>${pct(chg)}</td></tr>`).join('');
  const body = `
<h1>📊 ${esc(tradeDate)} 全市场情绪扫描</h1>
<div class="sub">数据日 ${esc(tradeDate)} · 生成于数据管道收盘口径 · 情绪得分 ${num(dualTrack?.day?.score, 1)}</div>
${regimeCard()}
<div class="section">
  <h2>涨跌结构</h2>
  <div class="metric-grid">
    <div class="metric"><div class="metric-label">上涨</div><div class="metric-value up">${num(br?.up)}</div></div>
    <div class="metric"><div class="metric-label">下跌</div><div class="metric-value down">${num(br?.down)}</div></div>
    <div class="metric"><div class="metric-label">平盘</div><div class="metric-value">${num(br?.flat)}</div></div>
    <div class="metric"><div class="metric-label">涨停家数</div><div class="metric-value up">${num(pools?.zt ?? sig?.zt_count)}</div></div>
    <div class="metric"><div class="metric-label">跌停家数</div><div class="metric-value down">${num(pools?.dt ?? sig?.dt_count)}</div></div>
    <div class="metric"><div class="metric-label">炸板家数</div><div class="metric-value">${num(pools?.zb ?? sig?.zb_count)}</div></div>
    <div class="metric"><div class="metric-label">二板家数</div><div class="metric-value">${num(pools?.lb2)}</div></div>
    <div class="metric"><div class="metric-label">板块涨跌中位数</div><div class="metric-value">${pct(signals?.relative?.medianPct)}</div></div>
  </div>
</div>
<div class="section">
  <h2>强势板块 TOP 10（相对大盘超额）</h2>
  ${attack.length ? `<table><thead><tr><th>板块</th><th>涨跌幅</th><th>超额</th></tr></thead><tbody>
    ${attack.slice(0, 10).map((a) => `<tr><td>${esc(a.name)}</td><td>${pct(a.change_pct)}</td><td>${pct(a.excess)}</td></tr>`).join('')}
  </tbody></table>` : `<div class="warn-box">板块强弱数据缺失（signals.relative 未产出）。</div>`}
  ${defense.length ? `<h3>防御板块（跌幅最浅）</h3><table><thead><tr><th>板块</th><th>涨跌幅</th><th>超额</th></tr></thead><tbody>
    ${defense.slice(0, 5).map((a) => `<tr><td>${esc(a.name)}</td><td>${pct(a.change_pct)}</td><td>${pct(a.excess)}</td></tr>`).join('')}
  </tbody></table>` : ''}
</div>
<div class="section">
  <h2>板块涨幅榜（${esc(tradeDate)}，前 15）</h2>
  ${boardRows?.length ? `<table><thead><tr><th>板块</th><th>涨跌幅</th></tr></thead><tbody>${boardList(boardRows)}</tbody></table>`
    : `<div class="warn-box">当日板块榜数据缺失（board_rank.json 无 ${esc(tradeDate)}）。</div>`}
</div>`;
  return pageHtml({ title: `${tradeDate} 全市场情绪扫描`, colKey: 'emotion', body });
}

// ── morning 栏目 ────────────────────────────────────────────────────────────
function renderMorning() {
  const quotes = globalData?.quotes ?? [];
  const pick = (keys) => keys.map((k) => quotes.find((q) => q.key === k)).filter(Boolean);
  const overseas = pick(['a50', 'sox', 'ixic', 'ndx', 'spx', 'dji', 'hsi', 'hstech', 'fxi', 'hxc', 'dxy', 'cnh']);
  const overseasRows = overseas.map((q) => `
    <tr><td>${esc(q.name)}</td><td>${q.chgPctText ? `<span class="${q.chgPct > 0 ? 'up' : q.chgPct < 0 ? 'down' : ''}">${esc(q.chgPctText)}</span>` : dash}</td><td>${q.ok ? 'ok' : `<span class="down">${esc(q.stateText || 'failed')}</span>`}</td></tr>`).join('');
  const body = `
<h1>🏠 A股早盘快报 — ${esc(tradeDate)}</h1>
<div class="sub">数据日 ${esc(tradeDate)} · 外围行情来自 global.json 唯一口径（src/global.js）</div>
${regimeCard()}
<div class="section">
  <h2>核心指数概览</h2>
  <table><thead><tr><th>指数</th><th>涨跌幅</th></tr></thead><tbody>
    ${Object.entries(idx ?? {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${pct(v)}</td></tr>`).join('') || '<tr><td colspan="2"><span class="na">—</span></td></tr>'}
  </tbody></table>
  <div class="metric-grid" style="margin-top:12px">
    <div class="metric"><div class="metric-label">上涨 / 下跌 / 平盘</div><div class="metric-value" style="font-size:16px">${num(br?.up)} / ${num(br?.down)} / ${num(br?.flat)}</div></div>
    <div class="metric"><div class="metric-label">两市成交额</div><div class="metric-value">${num(sig?.amount_yi, 1, ' 亿')}</div></div>
    <div class="metric"><div class="metric-label">涨停 / 跌停 / 炸板</div><div class="metric-value" style="font-size:16px">${num(pools?.zt)} / ${num(pools?.dt)} / ${num(pools?.zb)}</div></div>
  </div>
</div>
<div class="section">
  <h2>外围行情（盘前锚）</h2>
  ${overseasRows ? `<table><thead><tr><th>品种</th><th>涨跌幅</th><th>状态</th></tr></thead><tbody>${overseasRows}</tbody></table>`
    : '<div class="warn-box">外围行情数据缺失（data/global.json 不存在或为空）。</div>'}
</div>
<div class="section">
  <h2>风险提示</h2>
  <div class="info-box">建议仓位上限 ${reg?.cap != null ? pct(reg.cap * 100, 0) : dash}（regime：${reg ? esc(reg.label) : '未知'}）。开盘后请以竞价与首 30 分钟量能复核，本页为收盘口径数据的盘前转发。</div>
</div>`;
  return pageHtml({ title: `A股早盘快报 — ${tradeDate}`, colKey: 'morning', body });
}

// ── pick 栏目 ───────────────────────────────────────────────────────────────
function renderPick() {
  const attack = relVs?.attack ?? [];
  const ztCodes = pools?.zt_codes ?? [];
  const body = `
<h1>⚡ A股短线选股 · ${esc(tradeDate)}</h1>
<div class="sub">基准日 ${esc(tradeDate)} 收盘口径 · 面向下一交易日（T+1）· 不构成投资建议</div>
${marketStateCard()}
<div class="section">
  <h2>强势板块（相对大盘超额前 8）</h2>
  ${attack.length ? `<table><thead><tr><th>板块</th><th>涨跌幅</th><th>超额</th></tr></thead><tbody>
    ${attack.slice(0, 8).map((a) => `<tr><td>${esc(a.name)}</td><td>${pct(a.change_pct)}</td><td>${pct(a.excess)}</td></tr>`).join('')}
  </tbody></table>` : '<div class="warn-box">板块强弱数据缺失。</div>'}
  <p style="margin-top:8px;font-size:13px;color:#5b6570">强合力板块数（涨幅≥2.5%）：${attack.filter((a) => a.change_pct >= 2.5).length} / 共 ${num(signals?.relative?.total)} 个行业，中位数 ${pct(signals?.relative?.medianPct)}</p>
</div>
<div class="section">
  <h2>连板梯队（汇总口径）</h2>
  <div class="metric-grid">
    <div class="metric"><div class="metric-label">最高连板</div><div class="metric-value">${pools?.max_lb != null ? `${pools.max_lb} 板` : dash}</div></div>
    <div class="metric"><div class="metric-label">二板家数</div><div class="metric-value">${num(pools?.lb2)}</div></div>
    <div class="metric"><div class="metric-label">涨停家数</div><div class="metric-value up">${num(pools?.zt)}</div></div>
    <div class="metric"><div class="metric-label">炸板率</div><div class="metric-value">${(pools?.zt != null && pools?.zb != null && pools.zt + pools.zb > 0) ? pct((pools.zb / (pools.zt + pools.zb)) * 100) : dash}</div></div>
  </div>
  ${ztCodes.length ? `<p style="font-size:13px;color:#5b6570;margin-top:8px">涨停池代码（${ztCodes.length} 只）：</p><p style="font-size:13px;font-variant-numeric:tabular-nums">${ztCodes.map(esc).join('　')}</p>`
    : '<div class="warn-box">涨停池代码缺失（intraday.pools.zt_codes 未产出）。</div>'}
</div>
<div class="section">
  <h2>短线候选池</h2>
  <div class="warn-box">个股级候选池（Q1–Q3 硬过滤、买卖区间、止损目标位）依赖个股级行情与资金明细，当前数据管道未产出该粒度——本节标注缺失而非补 0；接入个股级数据源后直接填充。</div>
</div>`;
  return pageHtml({ title: `短线选股 · ${tradeDate}`, colKey: 'pick', body });
}

// ── dualview 栏目（涨停双视角：首板/连板分层 + 炸板反查）───────────────────
function renderDualview() {
  if (!sd) return pageHtml({ title: `涨停双视角 · ${tradeDate}`, colKey: 'dualview', body: `<h1>🔁 今日涨停次日预测 · 双视角点评 ${esc(tradeDate)}</h1>${missingStock}` });
  const firstBoard = ztRows.filter((s) => (s.lb ?? 1) === 1);
  const multiBoard = ztRows.filter((s) => (s.lb ?? 1) > 1);
  const tier = (rows, label, note) => `<h3>${label}（${rows.length} 只 · ${note}）</h3>
    <table>${STOCK_THEAD}<tbody>${rows.slice(0, 30).map((s) => stockRow(s)).join('')}</tbody></table>`;
  const body = `
<h1>🔁 今日涨停次日预测 · 双视角点评 ${esc(tradeDate)}</h1>
<div class="sub">一句话定性：涨停 ${ztRows.length} 家（首板 ${firstBoard.length} / 连板 ${multiBoard.length}）· 炸板 ${zbRows.length} 家 · 跌停 ${dtRows.length} 家</div>
${regimeCard()}
<div class="section">
  <h2>板块合力分布（≥2 家涨停）</h2>
  <table><thead><tr><th>板块</th><th>涨停家数</th><th>成员（连板）</th></tr></thead><tbody>
    ${groupByIndustry(ztRows).filter(([, rs]) => rs.length >= 2).slice(0, 12).map(([k, rs]) => `<tr><td>${esc(k)}</td><td class="up">${rs.length}</td><td style="font-size:12px">${rs.map((s) => `${esc(s.name)}${(s.lb ?? 1) > 1 ? `(${s.lb}板)` : ''}`).join('、')}</td></tr>`).join('') || '<tr><td colspan="3">无合力板块（分散）</td></tr>'}
  </tbody></table>
</div>
<div class="section">
  <h2>连板视角（次日晋级/断板博弈面）</h2>
  ${tier(multiBoard, '连板梯队', '按连板数降序')}
</div>
<div class="section">
  <h2>首板视角（次日 1 进 2 扫描面）</h2>
  ${tier(ztByLb.filter((s) => (s.lb ?? 1) === 1).sort((a, b) => (b.sealFund ?? 0) - (a.sealFund ?? 0)).slice(0, 30), '首板按封单额', '封单大 = 分歧小')}
</div>
<div class="section">
  <h2>炸板反查（分歧面，次日回避参考）</h2>
  ${zbRows.length ? `<table><thead><tr><th>个股</th><th>涨跌幅</th><th>现价</th><th>行业</th><th>炸板次数</th><th>成交额</th></tr></thead><tbody>
    ${[...zbRows].sort((a, b) => (b.brokenTimes ?? 0) - (a.brokenTimes ?? 0)).slice(0, 25).map((s) => `<tr><td><span style="font-variant-numeric:tabular-nums">${esc(s.code)}</span> ${esc(s.name)}</td><td>${pct(s.pct)}</td><td>${num(s.price, 2)}</td><td>${esc(s.industry ?? '—')}</td><td class="down">${num(s.brokenTimes)}</td><td>${yi(s.amount)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="info-box">当日炸板池为空或未产出。</div>'}
</div>`;
  return pageHtml({ title: `今日涨停次日预测 · 双视角点评 ${tradeDate}`, colKey: 'dualview', body });
}

// ── mainboard 栏目（主板接力：10cm 梯队与封单强度）─────────────────────────
function renderMainboard() {
  if (!sd) return pageHtml({ title: `主板接力 · ${tradeDate}`, colKey: 'mainboard', body: `<h1>主板接力模式 · ${esc(ymd)}</h1>${missingStock}` });
  const ladder = ztByLb.filter((s) => (s.lb ?? 0) >= 2);
  const body = `
<h1>主板接力模式 · ${esc(ymd)}</h1>
<div class="sub">盘后选池 → 次日执行 · 阈值按 10cm 主板口径 · 连板 ${ladder.length} 只（≥2 板）</div>
${marketStateCard()}
<div class="section">
  <h2>连板梯队（按连板数 · 接力候选池）</h2>
  ${ladder.length ? `<table>${STOCK_THEAD}<tbody>${ladder.map((s) => stockRow(s)).join('')}</tbody></table>`
    : '<div class="warn-box">当日无 ≥2 板梯队（或个股明细缺失）。</div>'}
</div>
<div class="section">
  <h2>首板强封（次日 1 进 2 观察池）</h2>
  <p style="font-size:13px;color:#5b6570">筛选：首板 · 首封时间 ≤ 10:30 · 炸板次数 ≤ 1 · 按封单额降序，取前 15</p>
  ${ztRows.length ? `<table>${STOCK_THEAD}<tbody>${ztRows.filter((s) => (s.lb ?? 1) === 1 && (s.firstSeal ?? 999999) <= 103000 && (s.brokenTimes ?? 0) <= 1).sort((a, b) => (b.sealFund ?? 0) - (a.sealFund ?? 0)).slice(0, 15).map((s) => stockRow(s)).join('') || '<tr><td colspan="8">无符合筛选的标的</td></tr>'}</tbody></table>`
    : '<div class="warn-box">个股级明细缺失。</div>'}
</div>
<div class="section">
  <h2>接力风险面</h2>
  <div class="info-box">最高连板 ${num(pools?.max_lb)} 板 · 昨日高位板晋级失败与断层情况以次日实盘复核为准；本页为收盘口径的预案，不构成投资建议。</div>
</div>`;
  return pageHtml({ title: `主板接力模式 · ${ymd}`, colKey: 'mainboard', body });
}

// ── mindmap 栏目（涨停题材思维导图：板块→个股树）───────────────────────────
function renderMindmap() {
  if (!sd) return pageHtml({ title: `涨停题材思维导图 ${ymd}`, colKey: 'mindmap', body: `<h1>涨停题材思维导图 ${esc(ymd)}</h1>${missingStock}` });
  const groups = groupByIndustry(ztRows);
  const tree = groups.map(([k, rs]) => {
    const leaf = rs.map((s) => `<div style="padding:3px 0;font-size:13px;font-variant-numeric:tabular-nums">${esc(s.name)} <span class="${signCls(s.pct)}">${pct(s.pct)}</span>${(s.lb ?? 1) > 1 ? ` <b>${s.lb}板</b>` : ''} <span style="color:#8b949e">${hhmm(s.firstSeal)}</span></div>`).join('');
    return `<div class="section" style="margin-bottom:12px"><h3>📂 ${esc(k)}（${rs.length} 家）</h3>${leaf}</div>`;
  }).join('');
  const body = `
<h1>涨停题材思维导图 ${esc(ymd)}</h1>
<div class="sub">行业 → 个股两级树 · 涨停 ${ztRows.length} 家 · 共 ${groups.length} 个题材分支（按家数排序）</div>
${tree || '<div class="warn-box">个股级明细缺失。</div>'}`;
  return pageHtml({ title: `涨停题材思维导图 ${ymd}`, colKey: 'mindmap', body });
}

// ── predict 栏目（次日预测：涨停样本 → 次日晋级/断板预测面）────────────────
function renderPredict() {
  if (!sd) return pageHtml({ title: `次日预测 · ${tradeDate}`, colKey: 'predict', body: `<h1>次日预测 ${esc(tradeDate)}</h1>${missingStock}` });
  const highSeal = ztRows.filter((s) => (s.brokenTimes ?? 0) === 0 && (s.sealFund ?? 0) >= 5e7); // 未开板 + 封单≥5000万
  const fragile = ztRows.filter((s) => (s.brokenTimes ?? 0) >= 3); // 反复开板
  const body = `
<h1>次日预测 · ${esc(tradeDate)}</h1>
<div class="sub">收盘口径样本 → 下一交易日（T+1）晋级/断板预测面 · 不构成投资建议</div>
${regimeCard()}
<div class="section">
  <h2>晋级倾向（硬封样本：未开板 · 封单 ≥ 5000 万）</h2>
  ${highSeal.length ? `<table>${STOCK_THEAD}<tbody>${ztByLb.filter((s) => highSeal.includes(s)).slice(0, 25).map((s) => stockRow(s)).join('')}</tbody></table>`
    : '<div class="warn-box">无硬封样本（个股明细缺失或当日分歧大）。</div>'}
</div>
<div class="section">
  <h2>断板倾向（反复开板 ≥ 3 次）</h2>
  ${fragile.length ? `<table><thead><tr><th>个股</th><th>涨跌幅</th><th>行业</th><th>连板</th><th>炸板次数</th><th>封单</th></tr></thead><tbody>
    ${fragile.map((s) => `<tr><td><span style="font-variant-numeric:tabular-nums">${esc(s.code)}</span> ${esc(s.name)}</td><td>${pct(s.pct)}</td><td>${esc(s.industry ?? '—')}</td><td>${s.lb ?? dash}</td><td class="down">${num(s.brokenTimes)}</td><td>${yi(s.sealFund)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="info-box">无反复开板样本（封板质量整体较好）。</div>'}
</div>
<div class="section">
  <h2>情绪环境校准</h2>
  <div class="info-box">最高连板 ${num(pools?.max_lb)} 板 · 炸板率 ${(pools?.zt != null && pools?.zb != null && pools.zt + pools.zb > 0) ? pct((pools.zb / (pools.zt + pools.zb)) * 100) : dash} · 环境相位「${reg ? esc(reg.label) : '未知'}」：晋级预测仅在同向环境下可信，逆环境时整体降档。</div>
</div>`;
  return pageHtml({ title: `次日预测 · ${tradeDate}`, colKey: 'predict', body });
}

// ── prejudge 栏目（盘中预判：大盘铁律 → 情绪过滤 → 10日涨幅硬过滤 → 组合AB）──
// 结构对齐外部模板 prejudge/20261009.html 九节；数据源 data/prejudge_detail.json
// （fetch_prejudge_data.mjs，创科 10日涨幅榜 + 硬过滤 + 主力资金交叉验证）。
function renderPrejudge() {
  const pj = prejudgeDetail;
  const c = pj?.counts ?? {};
  const idxRows = Object.entries(idx ?? {});
  const cjk = idx?.['创业板指'] ?? null; // 铁律1：创业板指跌 >1% → 终止
  const rule1 = cjk != null && cjk < -1;
  const ztN = (sd?.zt?.length ?? pools?.zt ?? sig?.zt_count ?? null);
  const zbN = (sd?.zb?.length ?? pools?.zb ?? sig?.zb_count ?? null);
  const dtN = (sd?.dt?.length ?? pools?.dt ?? sig?.dt_count ?? null);
  const zbRate = (ztN != null && zbN != null && ztN + zbN > 0) ? Number(((zbN / (ztN + zbN)) * 100).toFixed(1)) : null;
  const cm20 = (sd?.zt ?? []).filter((s) => s.code?.startsWith('30') || s.code?.startsWith('68'));
  const maxLbStock = ztByLb[0] ?? null;
  const emotionPass = !(cm20.length >= 5 && zbRate != null && zbRate >= 40);
  const cutRow = (s, extra = '') => `<tr>
    <td><span style="font-variant-numeric:tabular-nums">${esc(s.code)}</span> ${esc(s.name ?? '')}</td>
    <td>${pct(s.pct)}</td><td>${num(s.price, 2)}</td><td>${num(s.turnover, 2, '%')}</td>
    <td>${s.pct10d != null ? pct(s.pct10d) : dash}</td><td>${esc(s.industry ?? '—')}</td>${extra}</tr>`;
  const emptyGate = (title, reasons) => `<div class="section"><h2>${title}</h2><div class="metric-grid">
    <div class="metric"><div class="metric-label">入选</div><div class="metric-value">0 只</div></div></div>
    <p style="font-size:13px;margin-top:8px">判定依据：</p><ul style="font-size:13px;padding-left:20px">${reasons.map((r) => `<li>${r}</li>`).join('')}</ul></div>`;

  const body = `
<h1>⏱️ 盘中预判 · ${esc(tradeDate)}</h1>
<div class="sub">数据基准：盘中实时快照（生成于 ${esc(pj?.generatedAt?.replace('T', ' ').slice(0, 16) ?? '—')}）· 临近 14:50 请二次确认 · 不构成投资建议</div>
${pj ? '' : `<div class="warn-box">盘中预判明细缺失（data/prejudge_detail.json 不存在——需东财 push2 clist，先跑 scripts/fetch_prejudge_data.mjs；本地网络拉不通时仅 CI 可生成）。以下仅展示可用的市场级数据。</div>`}
<div class="section">
  <h2>一、大盘形势</h2>
  <table><thead><tr><th>指数</th><th>涨跌幅</th><th>判定</th></tr></thead><tbody>
    ${idxRows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${pct(v)}</td><td>${v < -1 ? '❌ 弱势' : v < 0 ? '⚠️' : '✅'}</td></tr>`).join('') || '<tr><td colspan="3"><span class="na">—</span></td></tr>'}
  </tbody></table>
  <p style="font-size:13px;margin-top:8px">两市成交额 ${num(sig?.amount_yi, 1, ' 亿')} · 铁律1（创业板指跌&gt;1%）→ ${rule1 ? '<b class="down">❌ 触发，套利流程终止</b>' : '✅ 未触发'} · 指数级主力净额：本管道未接入（如实标注，不臆造）</p>
</div>
<div class="section">
  <h2>二、情绪过滤结果</h2>
  <table><thead><tr><th>指标</th><th>数值</th><th>判定</th></tr></thead><tbody>
    <tr><td>涨停家数</td><td>${num(ztN)} 家</td><td>—</td></tr>
    <tr><td>炸板家数 / 炸板率</td><td>${num(zbN)} 家 / ${zbRate != null ? pct(zbRate, 1) : dash}</td><td>${zbRate != null && zbRate >= 40 ? '❌ ≥40% 触发' : '✅ <40% 未触发'}</td></tr>
    <tr><td>20cm 涨停家数</td><td>${num(cm20.length)} 家</td><td>${cm20.length >= 5 ? '⚠️ 高位区' : '⚠️ 连续低位区'}</td></tr>
    <tr><td>最高连板</td><td>${maxLbStock ? `${maxLbStock.lb} 板（${esc(maxLbStock.name)}·${esc(maxLbStock.industry ?? '—')}）` : num(pools?.max_lb, 0, ' 板')}</td><td>${(pools?.max_lb ?? 0) > 2 ? '✅ >2板 不做减半' : '⚠️ ≤2板 做减半处理'}</td></tr>
    <tr><td>跌停家数</td><td>${num(dtN)} 家</td><td>${(dtN ?? 0) < 50 ? '✅ <50' : '❌'}</td></tr>
  </tbody></table>
  <p style="font-size:13px;margin-top:8px">闸门判定：${emotionPass ? '✅ 通过（AND 条件不成立）' : '❌ 未通过'}${cm20.length ? ` · 20cm 样本：${cm20.slice(0, 5).map((s) => `${esc(s.name)}(${esc(s.industry ?? '—')})`).join('、')}` : ''}</p>
</div>
${pj ? `
<div class="section">
  <h2>三、候选池硬过滤（创科 10日涨幅前${pj.rankN} → 通过${c.passed}只）</h2>
  <div class="metric-grid">
    <div class="metric"><div class="metric-label">上榜</div><div class="metric-value">${c.rank}</div></div>
    <div class="metric"><div class="metric-label">通过</div><div class="metric-value up">${c.passed}</div></div>
    <div class="metric"><div class="metric-label">淘汰</div><div class="metric-value down">${c.eliminated}</div></div>
    <div class="metric"><div class="metric-label">淘汰率</div><div class="metric-value">${c.rank ? pct((c.eliminated / c.rank) * 100, 1) : dash}</div></div>
  </div>
  <h3>淘汰原因计数</h3>
  <table><thead><tr><th>原因</th><th>计数</th></tr></thead><tbody>
    ${Object.entries(pj.reasonCount ?? {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="down">${v}</td></tr>`).join('') || '<tr><td colspan="2">—</td></tr>'}
  </tbody></table>
  <h3>通过池（${c.passed} 只）</h3>
  <table><thead><tr><th>个股</th><th>涨跌幅</th><th>现价</th><th>换手</th><th>10日涨幅</th><th>行业</th></tr></thead><tbody>
    ${(pj.passed ?? []).slice(0, 40).map((s) => cutRow(s)).join('') || '<tr><td colspan="6">全部被否</td></tr>'}
  </tbody></table>
  <h3>淘汰明细（前 30）</h3>
  <table><thead><tr><th>个股</th><th>涨跌幅</th><th>现价</th><th>换手</th><th>10日涨幅</th><th>行业</th><th>淘汰原因</th></tr></thead><tbody>
    ${(pj.eliminated ?? []).slice(0, 30).map((s) => cutRow(s, `<td class="down">${esc((s.reasons ?? []).join('；'))}</td>`)).join('') || '<tr><td colspan="7">—</td></tr>'}
  </tbody></table>
</div>
<div class="section">
  <h2>四、板块分析</h2>
  <h3>行业板块涨幅排行（相对大盘超额前 15）</h3>
  ${(relVs?.attack ?? []).length ? `<table><thead><tr><th>板块</th><th>涨跌幅</th><th>超额</th><th>判定</th></tr></thead><tbody>
    ${(relVs?.attack ?? []).slice(0, 15).map((a) => `<tr><td>${esc(a.name)}</td><td>${pct(a.change_pct)}</td><td>${pct(a.excess)}</td><td>${a.change_pct >= 2.5 ? '✅ 合力' : '弱'}</td></tr>`).join('')}</tbody></table>
    <p style="font-size:12px;color:#8b949e">板块净流入/涨跌家数：本管道未接入该粒度，标注缺失。</p>`
    : '<div class="warn-box">板块强弱数据缺失。</div>'}
  <h3>候选票板块合力评级（通过池聚合）</h3>
  <table><thead><tr><th>板块</th><th>池内票数</th><th>强势票（涨幅&gt;3%）</th><th>成员</th></tr></thead><tbody>
    ${(pj.synergy ?? []).slice(0, 12).map((g) => `<tr><td>${esc(g.industry)}</td><td>${g.count}</td><td>${g.strong > 0 ? `<span class="up">${g.strong}</span>` : '0'}</td><td style="font-size:12px">${esc(g.members ?? '')}</td></tr>`).join('') || '<tr><td colspan="4">—</td></tr>'}
  </tbody></table>
  <p style="font-size:13px;margin-top:8px">情绪周期（regime 口径）：「${reg ? esc(reg.label) : '未知'}」，建议仓位上限 ${reg?.cap != null ? pct(reg.cap * 100, 0) : dash}。合力达标线 ⭐⭐⭐⭐（强势票≥2 且板块入 Top15）：${((pj.synergy ?? []).some((g) => g.strong >= 2 && (relVs?.attack ?? []).some((a) => a.name === g.industry && a.change_pct >= 2.5))) ? '✅ 有板块达标' : '❌ 无板块达标，铁律4 独立否决'}</p>
</div>
${c.combA || c.combB ? `
<div class="section">
  <h2>五、组合A（主线推荐：主力净额 ≥ 1 亿）</h2>
  ${c.combA ? `<table><thead><tr><th>个股</th><th>涨跌幅</th><th>现价</th><th>主力净额</th><th>行业</th></tr></thead><tbody>
    ${(pj.combA ?? []).map((s) => `<tr><td><span style="font-variant-numeric:tabular-nums">${esc(s.code)}</span> ${esc(s.name ?? '')}</td><td>${pct(s.pct)}</td><td>${num(s.price, 2)}</td><td class="up">${yi(s.mainNet)}</td><td>${esc(s.industry ?? '—')}</td></tr>`).join('')}</tbody></table>`
    : emptyGate('组合A：0 只', ['资金门槛否决：通过池内无主力净额 ≥1亿 标的'])}
</div>
<div class="section">
  <h2>六、组合B（弹性博弈：主力净额 ≥ 5000 万）</h2>
  ${c.combB ? `<table><thead><tr><th>个股</th><th>涨跌幅</th><th>现价</th><th>主力净额</th><th>行业</th></tr></thead><tbody>
    ${(pj.combB ?? []).map((s) => `<tr><td><span style="font-variant-numeric:tabular-nums">${esc(s.code)}</span> ${esc(s.name ?? '')}</td><td>${pct(s.pct)}</td><td>${num(s.price, 2)}</td><td class="up">${yi(s.mainNet)}</td><td>${esc(s.industry ?? '—')}</td></tr>`).join('')}</tbody></table>`
    : emptyGate('组合B：0 只', ['资金门槛否决：通过池内无主力净额 ≥5000万 标的（不降标）'])}
</div>` : emptyGate('五/六、组合A / 组合B', c.fundsAvailable ? ['铁律/资金门槛双重否决，无入选标的'] : ['主力净额口径缺失（f62 全为空）→ 资金门槛判定跳过，如实标注'])}
<div class="section">
  <h2>七、★ 交叉验证：候选池 ∩ 主力净额门槛名单（全创科 ≥5000万 前 30）</h2>
  <table><thead><tr><th>个股</th><th>主力净额</th><th>涨跌幅</th><th>换手</th><th>行业</th><th>是否在池内</th></tr></thead><tbody>
    ${(pj.mainFunds ?? []).map((r) => {
      const inPool = (pj.passed ?? []).some((s) => s.code === r.code);
      const elim = (pj.eliminated ?? []).find((s) => s.code === r.code);
      const why = inPool ? '✅ 池内' : elim ? `⚠️ ${esc(elim.reasons.join('；'))}` : '❌ 未入榜';
      return `<tr><td><span style="font-variant-numeric:tabular-nums">${esc(r.code)}</span> ${esc(r.name ?? '')}</td><td class="up">${yi(r.mainNet)}</td><td>${pct(r.pct)}</td><td>${num(r.turnover, 2, '%')}</td><td>${esc(r.industry ?? '—')}</td><td>${why}</td></tr>`;
    }).join('') || '<tr><td colspan="6">—</td></tr>'}
  </tbody></table>
  <p style="font-size:13px;margin-top:8px">核心结论：硬过滤通过 ${c.passed} 只 ∩ 主力≥5000万 名单 ${c.mainFunds} 只 = <b>${(pj.passed ?? []).filter((s) => (pj.mainFunds ?? []).some((r) => r.code === s.code)).length} 只</b>重叠。</p>
</div>` : ''}
<div class="section">
  <h2>八、缩量预检 / 九、形态评分</h2>
  <div class="warn-box">逐票昨日全天量与 K 线形态评分依赖个股历史日K逐只复算，当前管道未接入该粒度——标注缺失而非补 0；接入后由本页直接扩展本节。</div>
</div>`;
  return pageHtml({ title: `盘中预判 ${tradeDate}`, colKey: 'prejudge', body });
}

// ── wave2 栏目（二波扫描：断板回踩面）───────────────────────────────────────
function renderWave2() {
  if (!sd) return pageHtml({ title: `二波扫描 ${ymd}`, colKey: 'wave2', body: `<h1>二波扫描 · ${esc(ymd)}</h1>${missingStock}` });
  // 二波适用池 = 当日炸板（断板路径）+ 首封极早的一字首板（一字路径）
  const broken = [...zbRows].sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
  const board = groupByIndustry(broken);
  const body = `
<h1>二波扫描 · ${esc(ymd)}</h1>
<div class="sub">清单 A = 断板路径（炸板池按成交额）· ${broken.length} 只 · 行业聚合 ${board.length} 组 · 评分依赖个股历史日K，未接入前按口径字段直列</div>
${regimeCard()}
<div class="section">
  <h2>清单 A：断板路径（二波适用池，按成交额前 20）</h2>
  ${broken.length ? `<table><thead><tr><th>个股</th><th>涨跌幅</th><th>现价</th><th>行业</th><th>炸板次数</th><th>成交额</th></tr></thead><tbody>
    ${broken.slice(0, 20).map((s) => `<tr><td><span style="font-variant-numeric:tabular-nums">${esc(s.code)}</span> ${esc(s.name)}</td><td>${pct(s.pct)}</td><td>${num(s.price, 2)}</td><td>${esc(s.industry ?? '—')}</td><td>${num(s.brokenTimes)}</td><td>${yi(s.amount)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="warn-box">炸板池为空（无断板样本）。</div>'}
</div>
<div class="section">
  <h2>断板行业分布</h2>
  <table><thead><tr><th>行业</th><th>断板家数</th></tr></thead><tbody>
    ${board.slice(0, 10).map(([k, rs]) => `<tr><td>${esc(k)}</td><td>${rs.length}</td></tr>`).join('') || '<tr><td colspan="2">—</td></tr>'}
  </tbody></table>
</div>
<div class="section">
  <h2>局限</h2>
  <div class="warn-box">完整二波评分模型（回踩幅度 / 均线位置 / 量能保持）需要个股历史日K逐只复算，当前管道未接入该粒度——本页先直列口径字段，接入后填充评分列。</div>
</div>`;
  return pageHtml({ title: `二波扫描 ${ymd}`, colKey: 'wave2', body });
}

// ── premarket 栏目（盘前备忘：日历 + 外围 + 上期涨停回顾）───────────────────
function renderPremarket() {
  const cal = (() => {
    const c = readJson('data/calendar.json');
    const days = Array.isArray(c?.days) ? c.days.filter((d) => d >= tradeDate) : [];
    return days.slice(0, 5);
  })();
  const body = `
<h1>📋 盘前备忘 · ${esc(tradeDate)}</h1>
<div class="sub">外围行情 + 情绪环境 + 近期交易日提醒 · 09:15 竞价前过一遍</div>
${regimeCard()}
<div class="section">
  <h2>外围行情（隔夜盘前锚）</h2>
  ${(globalData?.quotes ?? []).length ? `<table><thead><tr><th>品种</th><th>涨跌幅</th><th>状态</th></tr></thead><tbody>
    ${(globalData?.quotes ?? []).filter((q) => ['a50', 'sox', 'ixic', 'hsi', 'hstech', 'cnh', 'dxy'].includes(q.key)).map((q) => `<tr><td>${esc(q.name)}</td><td>${q.chgPctText ? `<span class="${q.chgPct > 0 ? 'up' : q.chgPct < 0 ? 'down' : ''}">${esc(q.chgPctText)}</span>` : dash}</td><td>${q.ok ? 'ok' : `<span class="down">${esc(q.stateText || 'failed')}</span>`}</td></tr>`).join('')}</tbody></table>`
    : '<div class="warn-box">外围行情缺失（先跑 scripts/fetch_global.mjs）。</div>'}
</div>
<div class="section">
  <h2>近期交易日</h2>
  ${cal.length ? `<p style="font-size:14px">${cal.map((d) => esc(d)).join('　·　')}</p>` : '<div class="warn-box">交易日历未覆盖本日（data/calendar.json 截止范围之外）。</div>'}
</div>
<div class="section">
  <h2>上期涨停回顾（隔夜样本）</h2>
  ${ztRows.length ? `<table>${STOCK_THEAD}<tbody>${ztByLb.filter((s) => (s.lb ?? 0) >= 2).slice(0, 15).map((s) => stockRow(s)).join('')}</tbody></table>`
    : '<div class="warn-box">个股级明细缺失（先跑 scripts/fetch_stock_detail.mjs）。</div>'}
</div>`;
  return pageHtml({ title: `盘前备忘 · ${tradeDate}`, colKey: 'premarket', body });
}

// ── auction 栏目（9:25 竞价反查：一字/秒板样本 + 开盘规则检验）──────────────
function renderAuction() {
  if (!sd) return pageHtml({ title: `竞价复盘 · ${ymd}`, colKey: 'auction', body: `<h1>9:25 竞价打板 · 收盘反查 ${esc(ymd)}</h1>${missingStock}` });
  const oneWord = ztRows.filter((s) => (s.firstSeal ?? 999999) <= 92500);        // 首封 ≤ 09:25 = 竞价封死
  const fastSeal = ztRows.filter((s) => (s.firstSeal ?? 999999) > 92500 && (s.firstSeal ?? 999999) <= 93500); // 开盘 10 分钟内
  const body = `
<h1>9:25 竞价打板 · 收盘反查 ${esc(ymd)}</h1>
<div class="sub">竞价口径 = 首次封板时间 09:25（东财 fbt）；无独立竞价行情源，以下按首封时间反查 · 不构成投资建议</div>
${marketStateCard()}
<div class="section">
  <h2>2. 竞价封死样本（首封 ≤ 09:25，${oneWord.length} 只）</h2>
  ${oneWord.length ? `<table>${STOCK_THEAD}<tbody>${oneWord.map((s) => stockRow(s)).join('')}</tbody></table>`
    : '<div class="info-box">当日无竞价封死样本。</div>'}
</div>
<div class="section">
  <h2>3. 开盘 10 分钟内封板（${fastSeal.length} 只）</h2>
  ${fastSeal.length ? `<table>${STOCK_THEAD}<tbody>${fastSeal.slice(0, 20).map((s) => stockRow(s)).join('')}</tbody></table>`
    : '<div class="info-box">当日无 09:25–09:35 封板样本。</div>'}
</div>
<div class="section">
  <h2>4. 分级有效性检验</h2>
  <div class="metric-grid">
    <div class="metric"><div class="metric-label">竞价封死存活率（收盘仍涨停）</div><div class="metric-value">${ztRows.length ? pct((oneWord.length / Math.max(oneWord.length, 1)) * 100, 0) : dash}（样本即涨停池成员，100% 存活）</div></div>
    <div class="metric"><div class="metric-label">炸板池中曾有竞价样本</div><div class="metric-value">${zbRows.filter((s) => oneWord.some((z) => z.code === s.code)).length} 只</div></div>
    <div class="metric"><div class="metric-label">涨停总数</div><div class="metric-value up">${num(ztRows.length)}</div></div>
  </div>
</div>`;
  return pageHtml({ title: `9:25竞价打板 · 收盘反查 ${ymd}`, colKey: 'auction', body });
}

// ── arb 栏目（套利日报：转债/正股联动背离）─────────────────────────────────
function renderArb() {
  if (!arbSources || arbSources.tradeDate !== tradeDate) {
    return pageHtml({ title: `套利日报 ${tradeDate}`, colKey: 'arb', body: `<h1>⚡ 套利日报 ${esc(tradeDate)}</h1><div class="warn-box">转债联动数据缺失（data/arb_sources.json 无 ${esc(tradeDate)} 档，先跑 scripts/fetch_arb_sources.mjs）。</div>` });
  }
  const items = arbSources.items ?? [];
  const bondStrong = items.filter((x) => x.gap != null).slice(0, 12);   // 转债强于正股
  const stockStrong = items.filter((x) => x.gap != null).slice(-12).reverse(); // 正股强于转债
  const row = (x) => `<tr>
    <td><span style="font-variant-numeric:tabular-nums">${esc(x.bondCode)}</span> ${esc(x.bondName)}</td><td>${num(x.price, 2)}</td><td>${pct(x.pct)}</td>
    <td>${esc(x.stockCode)} ${esc(x.stockName ?? '—')}</td><td>${pct(x.stockPct)}</td>
    <td><span class="${signCls(x.gap)}">${x.gap != null ? (x.gap > 0 ? '+' : '') + x.gap.toFixed(2) + '%' : '—'}</span></td></tr>`;
  const ARB_THEAD = '<thead><tr><th>转债</th><th>现价</th><th>转债涨跌</th><th>正股</th><th>正股涨跌</th><th>差值（转债−正股）</th></tr></thead>';
  const body = `
<h1>⚡ 套利日报 · ${esc(tradeDate)}</h1>
<div class="sub">在市转债 ${arbSources.counts?.listed ?? '—'} 只（有报价 ${arbSources.counts?.quoted ?? '—'} 只）· 扫描面 = 转债/正股涨跌幅背离 · 不构成投资建议</div>
<div class="section">
  <h2>转债强于正股（溢价扩张面 · 追高风险参考）</h2>
  <table>${ARB_THEAD}<tbody>${bondStrong.map(row).join('')}</tbody></table>
</div>
<div class="section">
  <h2>正股强于转债（联动缺失面 · 转债补涨/折价修复扫描）</h2>
  <table>${ARB_THEAD}<tbody>${stockStrong.map(row).join('')}</tbody></table>
</div>
<div class="section">
  <h2>口径说明</h2>
  <div class="info-box">差值 = 转债当日涨跌幅 − 正股当日涨跌幅（同一时点腾讯行情快照之差，非口径复算）。背离只描述联动缺失，是否可做须叠加转股溢价率、剩余规模、正股基本面判断——这些字段当前管道未接入，标注缺失。</div>
</div>`;
  return pageHtml({ title: `套利日报 ${tradeDate}`, colKey: 'arb', body });
}

// ── weekly 栏目（周度复盘：archive 全档近 5 日情绪聚合）────────────────────
function renderWeekly() {
  const arch = readJson('data/archive.json');
  const allDays = arch?.all_days ?? [];
  const recent = allDays.slice(-6, -1); // 本周之前的近 5 个交易日（不含今日）
  const rows = recent.map((d) => {
    const s = d?.score ?? null;
    return `<tr><td>${esc(d?.date ?? '—')}</td><td>${s != null ? num(s, 1) : dash}</td><td>${esc(d?.regime?.label ?? d?.label ?? '—')}</td></tr>`;
  });
  const body = `
<h1>📅 周度复盘 · 截至 ${esc(tradeDate)}</h1>
<div class="sub">数据源：data/archive.json 全档情绪序列 · 近 5 个交易日聚合</div>
${regimeCard()}
<div class="section">
  <h2>近 5 个交易日情绪序列</h2>
  ${rows.length ? `<table><thead><tr><th>交易日</th><th>情绪分</th><th>状态</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    : '<div class="warn-box">archive 序列缺失（all_days 未产出或字段形态不符）。</div>'}
</div>
<div class="section">
  <h2>本周主线回顾</h2>
  <div class="metric-grid">
    <div class="metric"><div class="metric-label">主力题材（最新）</div><div class="metric-value" style="font-size:16px">${sig?.main_theme?.name ? esc(sig.main_theme.name) : dash}</div></div>
    <div class="metric"><div class="metric-label">涨停总数（最新交易日）</div><div class="metric-value">${num(ztRows.length)}</div></div>
    <div class="metric"><div class="metric-label">炸板家数</div><div class="metric-value">${num(zbRows.length)}</div></div>
  </div>
  <div class="warn-box">周度板块轮动/涨停家数逐日柱状图需要板块历史的完整序列聚合，当前 board_rank 档未覆盖全部交易日——补齐后自动扩展本节。</div>
</div>`;
  return pageHtml({ title: `周度复盘 · 截至 ${tradeDate}`, colKey: 'weekly', body });
}

// ── news 栏目（热点题材新闻：热门题材聚合 + 7x24 快讯）─────────────────────
function renderNews() {
  const items = hotNews?.items ?? [];
  const themes = hotNews?.hotThemes ?? [];
  const body = `
<h1>📰 热点题材新闻 · ${esc(hotNews?.generatedAt?.slice(0, 10) ?? tradeDate)}</h1>
<div class="sub">抓取时间 ${esc(hotNews?.generatedAt?.replace('T', ' ').slice(0, 16) ?? '—')}（北京时间 08:30 拍点与盘后各一版）· 新闻源：东财 7x24 快讯 · 题材源：涨停池行业聚合（${esc(hotNews?.tradeDate ?? '—')}）</div>
<div class="section">
  <h2>热门题材 TOP 12（当日涨停家数分布）</h2>
  ${themes.length ? `<table><thead><tr><th>题材</th><th>涨停家数</th></tr></thead><tbody>
    ${themes.map((t) => `<tr><td>${esc(t.name)}</td><td class="up">${t.count}</td></tr>`).join('')}</tbody></table>`
    : '<div class="warn-box">热门题材缺失（data/stock_detail.json 无涨停池，先跑 scripts/fetch_stock_detail.mjs）。</div>'}
</div>
<div class="section">
  <h2>7x24 财经快讯（最新 40 条）</h2>
  ${items.length ? `<table><thead><tr><th style="width:70px">时间</th><th>快讯标题（点击跳原文）</th></tr></thead><tbody>
    ${items.map((n) => `<tr><td style="font-variant-numeric:tabular-nums;color:#5b6570">${esc(n.time ?? '—')}</td><td>${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>` : esc(n.title)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="warn-box">快讯缺失（fetch_hot_news.mjs 抓取失败，未补 0）。</div>'}
</div>`;
  return pageHtml({ title: `热点题材新闻 · ${hotNews?.generatedAt?.slice(0, 10) ?? tradeDate}`, colKey: 'news', body });
}

// ── 骨架栏目（数据未接入，只出占位首页）────────────────────────────────────
function renderSkeleton(col) {
  const body = `
<h1>${esc(col.label)}（搭建中）</h1>
<div class="sub">该栏目已规划、数据粒度尚未接入——标注缺失而非补 0；接入对应数据源后由本脚本直接产出日报。</div>
<div class="section">
  <h2>状态</h2>
  <div class="warn-box">本栏目依赖的个股级/竞价级数据源未接入当前 data/ 管道，暂无日报产出。已有归档见下方列表（若为空即尚无历史页面）。</div>
</div>`;
  return pageHtml({ title: `${col.label} · 归档`, colKey: col.key, body });
}

// ── 发布时间表（reports_html/发布时间.html · 各栏目推送时刻速查）───────────
// 时刻事实源 = daily.yml 的 cron 与拍点守卫（详见该文件），本页只做展示搬运；
// 改 workflow 时刻后本页随下次生成自动更新（文案改在下方 COL_SCHEDULE）。
const COL_SCHEDULE = [
  ['热点新闻', '08:30 首版（快讯+企微晨报）· 18:30/21:00 题材表刷新为当日涨停分布', '东财 7x24 快讯 + 涨停题材聚合'],
  ['早盘快报', '09:00', '隔夜外围（美股 04:30 收盘快照）+ 昨收情绪环境'],
  ['竞价复盘', '09:30 首版（竞价/秒板反查）· 18:30/21:00 全天数据覆盖', '东财涨停池首封时间'],
  ['情绪扫描', '18:30 首版 · 21:00 补全覆盖', '收盘口径 signals + 涨停池'],
  ['短线选股', '18:30 首版 · 21:00 补全覆盖', '收盘口径 signals + 涨停池'],
  ['盘前备忘', '18:30 生成（次日盘前使用）', '外围 + 上期涨停样本'],
  ['盘中预判', '18:30 生成（盘中快照池为 09:00–15:30 每 30 分钟档）', 'intraday.json 盘中快照'],
  ['套利日报', '18:30 首版 · 21:00 补全覆盖', '转债/正股收盘快照'],
  ['涨停双视角', '18:30 首版 · 21:00 补全覆盖', '个股级涨停/炸板明细'],
  ['主板接力', '18:30 首版 · 21:00 补全覆盖', '个股级连板梯队'],
  ['二波扫描', '18:30 首版 · 21:00 补全覆盖', '炸板池断板路径'],
  ['题材导图', '18:30 首版 · 21:00 补全覆盖', '涨停池行业聚合'],
  ['次日预测', '18:30 首版 · 21:00 补全覆盖', '封板质量样本 + 情绪环境'],
  ['周度复盘', '仅周五 18:30 / 21:00', 'archive 全档近 5 日聚合'],
];
function renderSchedulePage() {
  const rows = COL_SCHEDULE.map(([name, time, src]) => `
    <tr><td>${esc(name)}</td><td style="font-variant-numeric:tabular-nums">${esc(time)}</td><td style="font-size:12px;color:#5b6570">${esc(src)}</td></tr>`).join('');
  const body = `
<h1>⏰ 各栏目发布时间表</h1>
<div class="sub">北京时间 · 周一至周五 · 页面上线 = job 完成提交后 1–2 分钟 · 时刻事实源：.github/workflows/daily.yml（cron 为 UTC，北京 = UTC+8）</div>
<div class="section">
  <h2>分时拍点总览</h2>
  <table><thead><tr><th style="width:110px">拍点</th><th>内容</th></tr></thead><tbody>
    <tr><td>08:30</td><td>热点新闻抓取 + 企微晨报推送</td></tr>
    <tr><td>09:00</td><td>早盘快报</td></tr>
    <tr><td>09:30</td><td>竞价复盘（开局反查）</td></tr>
    <tr><td>09:00–15:30 每 30 分钟</td><td>盘中快照数据流（intraday.json，不生成页面）</td></tr>
    <tr><td>18:30</td><td>收盘版：情绪扫描 / 短线选股 / 盘前备忘 / 盘中预判 / 套利日报 / 涨停双视角 / 主板接力 / 二波扫描 / 题材导图 / 次日预测（+ 早盘/竞价/新闻覆盖）</td></tr>
    <tr><td>21:00</td><td>补抓覆盖：龙虎榜/深证日K等延迟源齐后的全量版</td></tr>
    <tr><td>周五 18:30 / 21:00</td><td>周度复盘（仅周五生成）</td></tr>
  </tbody></table>
</div>
<div class="section">
  <h2>逐栏目明细</h2>
  <table><thead><tr><th style="width:110px">栏目</th><th>发布时间</th><th>数据基准</th></tr></thead><tbody>${rows}</tbody></table>
</div>
<div class="section">
  <h2>说明</h2>
  <div class="warn-box">同日同名文件「后跑覆盖先跑」：09:30 竞价复盘是开局反查样本，当晚 21:00 版为完整反查；节假日 09:00/09:30 拍点仍会生成（数据日 = 上一交易日收盘口径，页面自标注数据日）。推送全部经 GitHub Actions 自动提交 → Pages 部署，无人工步骤。</div>
</div>`;
  return pageHtml({ title: '各栏目发布时间表', colKey: '__schedule', body });
}

// ── 栏目归档首页 ────────────────────────────────────────────────────────────
function renderColIndex(col) {
  const files = listArchive(col.dir);
  const rows = files.map((f) => {
    const d = `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}`;
    return `<tr><td><a href="./${f}">${d}</a></td><td><a href="./${f}">${f}</a></td></tr>`;
  }).join('');
  const body = `
<h1>${esc(col.label)} · 往期归档</h1>
<div class="sub">共 ${files.length} 期 · 按日期倒序</div>
<div class="section">
  ${rows ? `<table><thead><tr><th>交易日</th><th>文件</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="warn-box">暂无归档页面。</div>'}
</div>`;
  return pageHtml({ title: `${col.label} · 往期归档`, colKey: col.key, body });
}

// ── 根导航 ──────────────────────────────────────────────────────────────────
function renderRootIndex() {
  const latest = (col) => {
    const files = listArchive(col);
    if (!files.length) return '<span class="na">暂无</span>';
    const f = files[0];
    const d = `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}`;
    return `<a href="./${col}/${f}">${d}</a>`;
  };
  const live = COLS.filter((c) => c.live);
  const rest = COLS.filter((c) => !c.live);
  const row = (c) => `<tr><td><a href="./${encodeURIComponent(c.dir)}/index.html">${esc(c.label)}</a></td><td>${c.live ? latest(c.dir) : '<span class="na">搭建中</span>'}</td></tr>`;
  const body = `
<h1>A股短线日报 · 栏目导航</h1>
<div class="sub">数据日 ${esc(tradeDate)} · 由 scripts/build_reports_html.mjs 从 data/ 管道产物生成 · <a href="./发布时间.html">⏰ 各栏目发布时间表</a></div>
<div class="section">
  <h2>已上线栏目</h2>
  <table><thead><tr><th>栏目</th><th>最新一期</th></tr></thead><tbody>${live.map(row).join('')}</tbody></table>
</div>
<div class="section">
  <h2>规划中栏目（数据源未接入）</h2>
  <table><thead><tr><th>栏目</th><th>最新一期</th></tr></thead><tbody>${rest.map(row).join('')}</tbody></table>
</div>`;
  return pageHtml({ title: 'A股短线日报 · 栏目导航', colKey: '__root', body });
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
let written = 0;
const RENDERERS = {
  emotion: renderEmotion,
  morning: renderMorning,
  pick: renderPick,
  premarket: renderPremarket,
  prejudge: renderPrejudge,
  auction: renderAuction,
  arb: renderArb,
  dualview: renderDualview,
  mainboard: renderMainboard,
  wave2: renderWave2,
  mindmap: renderMindmap,
  predict: renderPredict,
  weekly: renderWeekly,
  news: renderNews,
};
let dailyPages = 0;
for (const col of COLS) {
  if (!col.live) continue;
  if (ONLY && !ONLY.has(col.key)) continue;
  // 周报门禁：仅在周五生成（非周五跳过 = 正常退出）；--force 旁路补历史
  if (col.key === 'weekly' && !FORCE) {
    const dow = new Date(`${tradeDate}T12:00:00+08:00`).getDay();
    if (dow !== 5) { console.log(`[reports-html] weekly 跳过：${tradeDate} 非周五（周报只在周五出）`); continue; }
  }
  writePage(`${col.dir}/${ymd}.html`, RENDERERS[col.key]());
  dailyPages++;
  written++;
}
for (const col of COLS) {
  writePage(`${col.dir}/index.html`, renderColIndex(col));
  written++;
}
writePage('index.html', renderRootIndex());
writePage('发布时间.html', renderSchedulePage());
written++;

console.log(`[reports-html] ${tradeDate} → reports_html/（日报 ${dailyPages} 页 + 栏目首页 ${COLS.length} + 根导航，共 ${written} 文件）`);
