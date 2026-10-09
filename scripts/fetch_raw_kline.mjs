// 历史六因子回填 · 步骤1：全市场不复权日K抓取（腾讯 kline/kline 端点）
//
// 为什么不复权：涨停/炸板/跌停判定需要「实际成交价 == 交易所涨停价（round(prev×(1+pct),2)）」
// 的精确相等。老系统 kline 分片是 qfq 前复权（分红除权后历史被缩放），33 日交叉验证显示
// 系统性多计（低价股 9.9% 收盘落进 0.015 容差）。不复权价与交易所规则逐位对齐。
//
// 股池：老系统 5553 分片（沪深主板/创业板/科创）+ 东财 clist 枚举的北交所（EM 池含 ~1% BJ 股）。
// 产物：data/bt_kline/{code}.json = {c, n, bars:[[date,open,close,high,low,vol]...]}（640 根 ≈ 2.6 年）
//
// 用法：
//   node scripts/fetch_raw_kline.mjs            # 全量（断点续传：已有分片跳过）
//   node scripts/fetch_raw_kline.mjs --refresh  # 重抓末根非 2026-09-30 的分片
//   node scripts/fetch_raw_kline.mjs --limit 20 # 小样测试
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { atomicWriteJSON } from '../src/fsutil.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'data', 'bt_kline');
const OLD_DIR = path.resolve(ROOT, '..', 'a-sentiment', 'kline');
const REFRESH = process.argv.includes('--refresh');
const LIMIT = (process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT_DIR, { recursive: true });

// ── 股池 ──
const names = new Map(); // code → name
const codes = [];
for (const f of readdirSync(OLD_DIR).filter((f) => /^[a-z]{2}\d{6}\.json$/.test(f))) {
  try {
    const j = JSON.parse(readFileSync(path.join(OLD_DIR, f), 'utf8'));
    codes.push(j.c); names.set(j.c, j.n || '');
  } catch {}
}
console.log(`[kline] 沪深股池（老分片）: ${codes.length}`);

// 北交所：qt.gtimg 段探测枚举（scripts/fetch_bj_codes.mjs 产物；push2 系域名本机被墙不可用）
async function bjCodes() {
  const p = path.join(ROOT, 'data', 'bt_bj_codes.json');
  if (!existsSync(p)) { console.warn('[kline] ⚠ data/bt_bj_codes.json 缺失（先跑 scripts/fetch_bj_codes.mjs），北交所不入池'); return []; }
  return JSON.parse(readFileSync(p, 'utf8'));
}

const bj = await bjCodes();
for (const [c, n] of bj) { if (!codes.includes(c)) { codes.push(c); names.set(c, n); } }
console.log(`[kline] 加北交所后总股池: ${codes.length}`);

let todo = codes.filter((c) => {
  const p = path.join(OUT_DIR, c + '.json');
  if (!existsSync(p)) return true;
  if (!REFRESH) return false;
  try {
    const bars = JSON.parse(readFileSync(p, 'utf8')).bars || [];
    return !bars.length || bars[bars.length - 1][0] < '2026-09-30';
  } catch { return true; }
});
if (LIMIT) todo = todo.slice(0, +LIMIT);
console.log(`[kline] 待抓: ${todo.length}（已有跳过 ${codes.length - todo.length}）`);

// ── 抓取（4 并发 worker，各自限速 120ms）──
const WORKERS = 4;
let cursor = 0, done = 0, fail = [];
async function worker() {
  while (cursor < todo.length) {
    const code = todo[cursor++];
    let bars = null;
    for (let att = 0; att < 3 && !bars; att++) {
      try {
        const u = 'https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=' + code + ',day,,,640';
        const j = await (await fetch(u, { headers: { Referer: 'https://gu.qq.com/', 'User-Agent': UA } })).json();
        const d = j.data && j.data[code];
        const day = d && d.day;
        if (Array.isArray(day) && day.length) bars = day;
      } catch { await sleep(600); }
    }
    if (bars) {
      atomicWriteJSON(path.join(OUT_DIR, code + '.json'), JSON.stringify({ c: code, n: names.get(code) || '', bars }));
      done++;
    } else fail.push(code);
    if ((done + fail.length) % 500 === 0) console.log(`[kline] 进度 ${done + fail.length}/${todo.length} · 失败 ${fail.length}`);
    await sleep(120);
  }
}
await Promise.all(Array.from({ length: WORKERS }, () => worker()));
console.log(`[kline] 完成: 成功 ${done} · 失败 ${fail.length}${fail.length ? ' · ' + fail.slice(0, 20).join(',') : ''}`);
