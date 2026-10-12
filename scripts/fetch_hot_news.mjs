#!/usr/bin/env node
// ── 热点题材新闻采集（data/hot_news.json）──────────────────────────────────
//
// 用途：抓东财 7x24 财经快讯（newsapi.eastmoney.com，JSONP 列表）+ 聚合
//   当日涨停池的行业分布（热门题材），喂活 reports_html/ 的热点新闻栏目，
//   并供 08:30 企微推送（push_hot_news.mjs）。
//
// 用法：node scripts/fetch_hot_news.mjs [--limit 40]
//
// 纪律：只写 data/hot_news.json；接口失败置 null 不补 0；热门题材直接
//   复用 stock_detail.json 的行业字段聚合（不复算口径）。
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? Number(process.argv[i + 1]) || 40 : 40; })();

// ── 1) 东财 7x24 快讯（JSONP：var ajaxResult={...};）────────────────────────
let items = null;
try {
  const res = await fetch(`https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_${LIMIT}_1_.html`, {
    headers: { Referer: 'https://kuaixun.eastmoney.com/' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const m = text.match(/var ajaxResult=(\{[\s\S]*\});?\s*$/);
  if (!m) throw new Error('JSONP 形态不符');
  const j = JSON.parse(m[1]);
  items = (j.LivesList ?? []).map((x) => {
    // showTime 缺席时从 sort（epoch 毫秒串）派生北京时间 HH:MM
    let time = x.showTime ?? null;
    if (!time && x.sort) {
      const t = Number(x.sort);
      if (Number.isFinite(t)) time = new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });
    }
    return {
      title: x.title ?? null,
      url: x.url_w ?? x.url_unique ?? null,
      time,
      sort: x.sort ?? null,              // 排序键（时间戳串，倒序用）
    };
  }).filter((x) => x.title);
} catch (e) {
  console.error(`[hot-news] 快讯抓取失败：${e.message}（items 置 null）`);
}

// ── 2) 热门题材聚合（涨停池行业分布，复用个股明细档）───────────────────────
let hotThemes = null;
let themesSourceDate = null;
try {
  const sd = JSON.parse(readFileSync(join(ROOT, 'data', 'stock_detail.json'), 'utf8'));
  themesSourceDate = sd.tradeDate ?? null;
  const rows = sd.zt ?? [];
  const g = new Map();
  for (const r of rows) {
    const k = r.industry ?? '未分类';
    g.set(k, (g.get(k) ?? 0) + 1);
  }
  hotThemes = [...g.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
} catch { /* stock_detail 缺失 → hotThemes 置 null */ }

const out = {
  kind: 'hot-news',
  version: 1,
  generatedAt: new Date().toISOString(),
  source: 'eastmoney-kuaixun-102 + stock_detail.zt',
  tradeDate: themesSourceDate,
  failed: items == null ? ['kuaixun'] : undefined,
  counts: { news: items?.length ?? null, themes: hotThemes?.length ?? null },
  items,
  hotThemes,
};
mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(join(ROOT, 'data', 'hot_news.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`[hot-news] 快讯 ${out.counts.news ?? '—'} 条 · 热门题材 ${out.counts.themes ?? '—'} 个（题材源日 ${themesSourceDate ?? '—'}）→ data/hot_news.json`);
