#!/usr/bin/env node
// v4.8 全市场K线数据层（仓库分片方案）—— 合并版 ESM 移植（2026-10-02，merge/pro-into-ui）。
// 用法:
//   node ui/fetch_kline_all.mjs --init            历史回填: 枚举全市场代码 + 每股 fqkline 640 条 → ui/kline/<code>.json
//   node ui/fetch_kline_all.mjs                   每日增量: 批量行情 → 各分片追加当日 bar（停牌跳过）
//   node ui/fetch_kline_all.mjs --init --dry      干跑
// 环境变量: SENT_KLINE_LIMIT=30 限制处理只数（本地小样测试）· SENT_KLINE_CONC=4 并发
// 分片格式: {c:"sh600000", n:"浦发银行", bars:[["2025-06-09",11.48,11.48,11.51,11.27,565781],...]}  // [日期,开,收,高,低,量(手)]
// 改动相对原 fetch-kline-all.js：CommonJS→ESM（PRO 仓库 type:module）；熔断分支引用不在作用域的
// fresh 计数改为 done（原代码该路径会 ReferenceError，仅 60 连败触发）；其余逻辑一字未动。
import fs from 'node:fs';
import { atomicWriteJSON } from '../src/fsutil.js';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KLINE_DIR = path.join(__dirname, 'kline');
const LIST_FILE = path.join(KLINE_DIR, '_list.json');
const args = process.argv.slice(2);
const INIT = args.includes('--init');
const DRY = args.includes('--dry');
const LIMIT = parseInt(process.env.SENT_KLINE_LIMIT || '0', 10);
const CONC = parseInt(process.env.SENT_KLINE_CONC || '4', 10);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url, gbk, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      return new TextDecoder(gbk ? 'gbk' : 'utf-8').decode(buf);
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(800);
    }
  }
}

// ── 代码清单：候选区间枚举（qt.gtimg 无效代码直接缺席响应 → 天然过滤）──
function candidateRanges() {
  const out = [];
  for (let i = 600000; i <= 605999; i++) out.push('sh' + i);      // 沪主板（600/601/603/605）
  for (let i = 688000; i <= 689999; i++) out.push('sh' + i);      // 科创板
  for (let i = 1; i <= 3999; i++) out.push('sz' + String(i).padStart(6, '0'));   // 深主板 000/001/002/003
  for (let i = 300000; i <= 301999; i++) out.push('sz' + i);      // 创业板
  return out;
}

async function enumMarket() {
  const cand = candidateRanges();
  const list = [];
  const BATCH = 60;
  for (let i = 0; i < cand.length; i += BATCH) {
    const batch = cand.slice(i, i + BATCH);
    let body = '';
    try { body = await getText('https://qt.gtimg.cn/q=' + batch.join(','), true); } catch (e) { console.error('批量行情失败 @' + i, e.message); continue; }
    for (const line of body.split(';')) {
      const m = line.match(/v_(\w+)="([^"]*)"/);
      if (!m) continue;
      const p = m[2].split('~');
      if (p.length < 45 || !p[1] || p[1] === '') continue;      // 无效/缺席过滤
      const code = p[2], name = p[1];
      const mkt = m[1].slice(0, 2);
      if (code !== m[1].slice(2)) continue;                     // 回显代码与请求不符则弃
      if (!/^\d{6}$/.test(code)) continue;
      list.push({ c: mkt + code, n: name });
    }
    if ((i / BATCH) % 40 === 0) console.log('  枚举进度 ' + i + '/' + cand.length + ' · 已识别 ' + list.length);
    await sleep(60);
  }
  return list;
}

// ── 历史日K: fqkline 单请求 640 条 [date,open,close,high,low,vol] ──
async function fetchHistory(code) {
  const body = await getText('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + code + ',day,,,640,qfq');
  const j = JSON.parse(body);
  const d = j.data && j.data[code];
  if (!d) return null;
  const raw = d.qfqday || d.day;
  if (!Array.isArray(raw) || !raw.length) return null;
  return raw.map((b) => [b[0], +(+b[1]).toFixed(3), +(+b[2]).toFixed(3), +(+b[3]).toFixed(3), +(+b[4]).toFixed(3), Math.round(+b[5] || 0)])
    .filter((b) => b[0] && isFinite(b[1]) && b[1] > 0);
}

function shardPath(code) { return path.join(KLINE_DIR, code + '.json'); }

// ── v4.8.1 回填专用节奏化循环（单工 + 自适应冷却）──
// 实测教训：CONC=4/80ms ≈ 12.8 请求/秒，腾讯在 ~1000 次后封禁出口 IP（此后 60+ 分钟全拒，失败率 78%）。
// 对策：单工 300ms 基础间隔 + 连续失败指数冷却（15s→8min 封顶）+ 每 800 只分批 git 提交（进度落袋，可断点续跑）。
async function pacedLoop(items, worker) {
  const paceBase = parseInt(process.env.SENT_KLINE_INTERVAL || '300', 10);
  let pace = paceBase, done = 0, failStreak = 0, coolN = 0, okStreak = 0;
  const errs = [];
  const t0 = Date.now();
  for (const it of items) {
    let ok = false;
    try { await worker(it); ok = true; } catch (e) { errs.push({ item: it, msg: e.message }); }
    done++;
    if (done % 400 === 0) console.log('  进度 ' + done + '/' + items.length + ' · 失败 ' + errs.length + ' · 节奏 ' + pace + 'ms · 用时 ' + Math.round((Date.now() - t0) / 1000) + 's');
    if (ok) {
      failStreak = 0; okStreak++;
      if (okStreak >= 50) coolN = 0;                                 // 连续成功 50 只 → 冷却级别归零（限流窗口可能已重置）
      if (okStreak % 300 === 0 && pace > paceBase) pace = Math.max(paceBase, Math.round(pace * 0.9));  // 成功 streak 达 300 → 缓慢收窄节奏
    } else {
      failStreak++; okStreak = 0;
      if (failStreak >= 60) { console.log('⚠ 连续失败 ' + failStreak + ' → 判定行情源封禁，提前收工（已处理 ' + done + ' 只已分批提交，下次运行断点续跑）'); break; }
      if (failStreak >= 3 && failStreak % 10 === 0) {            // v4.8.4: 每 10 次连续失败才冷却探测一次
        coolN = Math.min(coolN + 1, 6);
        const pause = Math.min(15000 * Math.pow(2, coolN - 1), 480000);
        pace = Math.min(Math.round(pace * 1.4), 2000);
        console.log('  ⚠ 连续失败 ' + failStreak + ' → 冷却 ' + Math.round(pause / 1000) + 's · 节奏放宽至 ' + pace + 'ms');
        await sleep(pause);
      }
    }
    await sleep(pace + Math.round(Math.random() * 100));          // 抖动 ±100ms，避免机械节拍
  }
  return errs;
}

function gitCommitShards(n) {
  try {
    execSync(
      'git add kline && git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" commit -q -m "kline backfill: +' + n + ' shards (batch)"',
      { stdio: ['ignore', 'ignore', 'ignore'], cwd: __dirname });
    console.log('  📦 分批提交: 累计 ' + n + ' 只已 commit（断点保护）');
    return true;
  } catch (e) { return false; }                                  // 无变更（全跳过）时 commit 失败属正常
}

async function pooled(items, worker) {
  const queue = items.slice();
  let done = 0; const errs = [];
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const it = queue.shift();
      try { await worker(it); } catch (e) { errs.push({ item: it, msg: e.message }); }
      done++;
      if (done % 200 === 0) console.log('  进度 ' + done + '/' + items.length + ' · 失败 ' + errs.length);
      await sleep(80);
    }
  }));
  return errs;
}

// ── 回填 ──
async function runInit() {
  if (!fs.existsSync(KLINE_DIR)) fs.mkdirSync(KLINE_DIR, { recursive: true });
  let list;
  if (fs.existsSync(LIST_FILE)) {
    const old = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
    if (Date.now() - old.generated < 6 * 864e5 && old.codes && old.codes.length > 1000) {
      console.log('代码清单: 复用 ' + old.generatedAt + ' 的 ' + old.codes.length + ' 条（6 天内免重枚举）');
      list = old.codes;
    }
  }
  if (!list) {
    console.log('代码清单: 枚举候选区间 ' + candidateRanges().length + ' 个…');
    list = await enumMarket();
    if (!DRY) atomicWriteJSON(LIST_FILE, JSON.stringify({ generated: Date.now(), generatedAt: new Date().toISOString().slice(0, 10), note: '沪深A股清单（北交所 v4.8 未含），qt.gtimg 批量行情枚举', codes: list }));
    console.log('代码清单: 识别 ' + list.length + ' 只沪深A股');
  }
  if (LIMIT) { list = list.slice(0, LIMIT); console.log('（SENT_KLINE_LIMIT 限 ' + LIMIT + ' 只）'); }
  if (DRY) { console.log('--dry 干跑结束'); return; }

  let fresh = 0, skip = 0;
  const errs = await pacedLoop(list, async (it) => {
    const fp = shardPath(it.c);
    if (fs.existsSync(fp)) { skip++; return; }
    const bars = await fetchHistory(it.c);
    if (!bars || bars.length < 5) return;                     // 长期停牌/新股无数据 → 跳过不留空壳
    atomicWriteJSON(fp, JSON.stringify({ c: it.c, n: it.n, bars }));
    fresh++;
    if (fresh % 800 === 0) gitCommitShards(fresh);            // 每 800 只分批提交：再被封禁也不丢进度
  });
  console.log('══ 回填完成: 新增 ' + fresh + ' · 已存在跳过 ' + skip + ' · 失败 ' + errs.length + ' ══');
  if (errs.length) {
    errs.slice(0, 5).forEach((e) => console.error('  例:', e.item.c, e.msg));
    gitCommitShards(fresh);                                   // 有失败先提交落袋
    if (errs.length > list.length * 0.1) {
      console.error('⚠ 失败率超 10%（' + Math.round(errs.length / list.length * 100) + '%）——大概率被行情源限流。');
      console.error('⚠ 本次已提交 ' + fresh + ' 只（分批 commit），剩余 ' + errs.length + ' 只待补。');
      console.error('⚠ 按 exit 0 结束让提交步得以推送进度；请稍后再触发一次 kline_backfill 断点续跑补齐。');
      process.exit(0);                                        // v4.8.3: 软失败——exit 1 会被 GitHub 跳过提交步，分批提交全废
    }
  }
}

// ── 每日增量 ──
async function runDaily() {
  if (!fs.existsSync(LIST_FILE)) { console.error('FATAL: 无代码清单，先跑 --init'); process.exit(1); }
  const meta = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
  const list = meta.codes;
  if (!DRY) console.log('清单: ' + list.length + ' 只（' + meta.generatedAt + '）'); else console.log('清单: ' + list.length + ' 只');
  if (LIMIT) list.length = Math.min(list.length, LIMIT);

  // 批量行情 → 当日 bar 表
  const todayMap = new Map();
  const BATCH = 60;
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH).map((x) => x.c);
    let body = '';
    try { body = await getText('https://qt.gtimg.cn/q=' + batch.join(','), true); } catch (e) { console.error('批量行情失败 @' + i, e.message); continue; }
    for (const line of body.split(';')) {
      const m = line.match(/v_(\w+)="([^"]*)"/);
      if (!m) continue;
      const p = m[2].split('~');
      if (p.length < 45 || !p[1]) continue;
      const dt = (p[30] || '').slice(0, 8);                   // YYYYMMDDHHMMSS → 交易日
      if (!/^\d{8}$/.test(dt)) continue;
      const o = +p[5], c = +p[3], h = +p[33], l = +p[34], v = Math.round(+p[6] || 0);
      if (!(o > 0 && c > 0 && h > 0 && l > 0) || v <= 0) continue;   // 停牌/未开盘 → 无 bar
      const iso = dt.slice(0, 4) + '-' + dt.slice(4, 6) + '-' + dt.slice(6, 8);
      todayMap.set(m[1], [iso, +o.toFixed(3), +c.toFixed(3), +h.toFixed(3), +l.toFixed(3), v]);
    }
    await sleep(60);
  }
  console.log('当日有成交: ' + todayMap.size + ' 只');

  let added = 0, updated = 0, unchanged = 0, missing = 0;
  const errs = await pooled(list, async (it) => {
    const fp = shardPath(it.c);
    const bar = todayMap.get(it.c);
    if (!bar) { missing++; return; }                          // 当日无成交（停牌）
    if (!fs.existsSync(fp)) { missing++; return; }            // 清单有但分片缺失（回填遗漏）→ 增量跳过，下次 --init 补
    const shard = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const bars = shard.bars;
    const last = bars.length ? bars[bars.length - 1][0] : '';
    if (bar[0] <= last) { unchanged++; return; }              // 已在档（幂等）
    if (bars.length && last && bar[0] > last && bars.length > 700) bars.shift();   // 硬顶 700 条防无限膨胀
    bars.push(bar);
    shard.n = it.n || shard.n;
    atomicWriteJSON(fp, JSON.stringify(shard));
    added++; updated++;
  });
  console.log('══ K线增量完成: 追加 ' + added + ' · 当日无成交 ' + missing + ' · 已在档 ' + unchanged + ' · 失败 ' + errs.length + ' ══');
  if (added === 0 && unchanged === 0) console.log('（提示: 非交易日或全部停牌，无增量）');
  if (errs.length > list.length * 0.1) process.exit(1);
}

(INIT ? runInit() : runDaily()).catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
