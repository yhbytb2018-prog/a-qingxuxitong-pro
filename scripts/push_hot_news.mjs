#!/usr/bin/env node
// ── 热点新闻企微推送（08:30 拍点 · scripts/push_hot_news.mjs）──────────────
//
// 用途：读 data/hot_news.json → 渲染「热门题材 TOP + 最新快讯」文本 →
//   推企微（复用 OPS_WEBHOOK 运维通道，零新增 secret）。带指纹防重推：
//   state 记已推的 generatedAt，同一次抓取不重推（脚本失败下拍自愈重试）。
//
// 用法：
//   node scripts/push_hot_news.mjs                    # 推最新一版（指纹去重）
//   node scripts/push_hot_news.mjs --force            # 忽略指纹强制推
//
// 通道：env OPS_WEBHOOK；未配置 → 静默跳过（与 push_ai_report.mjs 同纪律）。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = join(ROOT, 'data', 'hot_news_push_state.json');
const FORCE = process.argv.includes('--force');

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

const news = readJson(join(ROOT, 'data', 'hot_news.json'));
if (!news || !news.generatedAt) {
  console.error('[hot-news-push] data/hot_news.json 不存在或无 generatedAt（先跑 fetch_hot_news.mjs）');
  process.exit(1);
}

// ── 文本渲染 ────────────────────────────────────────────────────────────────
const themes = (news.hotThemes ?? []).slice(0, 6)
  .map((t) => `${t.name}（${t.count} 家涨停）`).join('、');
const headlines = (news.items ?? []).slice(0, 10)
  .map((n, i) => `${i + 1}. ${n.time ? `[${n.time}] ` : ''}${n.title}`)
  .join('\n');
const text = [
  `📰 热点题材晨报（${news.generatedAt.slice(0, 16).replace('T', ' ')}）`,
  '',
  `🔥 热门题材：${themes || '—'}`,
  '',
  '📢 最新快讯：',
  headlines || '—',
  '',
  '详情见 reports_html/热点新闻/ · 不构成投资建议',
].join('\n');

// ── 指纹防重推 ──────────────────────────────────────────────────────────────
const state = readJson(STATE_FILE) ?? { schema_version: '1.0', pushed: [] };
if (!FORCE && state.pushed?.some((p) => p.fingerprint === news.generatedAt)) {
  console.log('[hot-news-push] 本版已推过（指纹命中），跳过');
  process.exit(0);
}

const url = process.env.OPS_WEBHOOK;
if (!url) {
  console.log('[hot-news-push] 未配置 OPS_WEBHOOK，仅落盘不推送（以下为将推内容预览）\n' + text);
  process.exit(0);
}

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
  signal: AbortSignal.timeout(20000),
});
let wechat = {};
try { wechat = await res.json(); } catch { /* 响应体异常按空处理 */ }
const ok = res.ok && (wechat.errcode === undefined || wechat.errcode === 0);
console.log(`[hot-news-push] HTTP ${res.status}, errcode: ${wechat.errcode}, errmsg: ${wechat.errmsg}`);

if (ok) {
  state.pushed.unshift({ fingerprint: news.generatedAt, pushed_at: new Date().toISOString() });
  state.pushed = state.pushed.slice(0, 30); // 只留近 30 条指纹
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 1) + '\n');
} else {
  // 失败不记指纹 → 下一拍内容未变仍重试（自愈）
  process.exit(1);
}
