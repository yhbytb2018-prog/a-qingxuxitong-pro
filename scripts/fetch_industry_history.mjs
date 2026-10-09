// 历史六因子回填 · 步骤2：同花顺 881xxx 行业板块年线抓取（行业广度因子 s_brd 原料）
//
// 与每日管线 fetchBoards 同源同端点（q.10jqka.com.cn/thshy/ 板块清单 + d.10jqka 年线），
// 差别只在于：管线只取当日一行，这里把 2025+2026 两年的完整日K缓存到本地。
//
// 产物：data/bt_industry.json = [{code, name, bars: [[YYYYMMDD, close], ...]}, ...]
// 用法：node scripts/fetch_industry_history.mjs   （幂等：缓存存在即跳过，--force 强制重抓）
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { atomicWriteJSON } from '../src/fsutil.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'bt_industry.json');
const FORCE = process.argv.includes('--force');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (existsSync(OUT) && !FORCE) {
  const cache = JSON.parse(readFileSync(OUT, 'utf8'));
  console.log(`[industry] 缓存已有 ${cache.length} 板块 · 跳过（--force 重抓）`);
  process.exit(0);
}

async function fetchGBK(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  const buf = await r.arrayBuffer();
  return new TextDecoder('gbk').decode(buf);
}

// 板块清单（与 src/sources.js fetchBoards 同一正则——口径唯一出处对齐）
const html = await fetchGBK('https://q.10jqka.com.cn/thshy/');
const re = /thshy\/detail\/code\/(88\d{4})\/" target="_blank">([^<]+)</g;
const boards = [];
let m;
const seen = new Set();
while ((m = re.exec(html))) if (!seen.has(m[1])) { seen.add(m[1]); boards.push({ code: m[1], name: m[2].trim() }); }
if (boards.length < 50) { console.error('[industry] 板块清单异常: ' + boards.length); process.exit(1); }
console.log(`[industry] 板块清单: ${boards.length} 个`);

const out = [];
let fail = 0;
const WORKERS = 4;
let cursor = 0;
async function worker() {
  while (cursor < boards.length) {
    const { code, name } = boards[cursor++];
    const bars = [];
    for (const year of [2025, 2026]) {
      // 每个年份独立重试（不能用「bars 已有 2025 数据」当完成条件——那会跳过 2026 年抓取）
      let gotYear = false;
      for (let att = 0; att < 3 && !gotYear; att++) {
        try {
          const t = await (await fetch('http://d.10jqka.com.cn/v6/line/48_' + code + '/01/' + year + '.js',
            { headers: { 'User-Agent': UA, Referer: 'https://q.10jqka.com.cn/' } })).text();
          const s = t.slice(t.indexOf('(') + 1, t.lastIndexOf(')'));
          const obj = JSON.parse(s);
          const lines = (obj.data || '').split(';').filter(Boolean).map((l) => l.split(','));
          for (const k of lines) if (k[0] && k[4]) bars.push([k[0], +k[4]]);
          gotYear = lines.length > 0;
        } catch { await sleep(500); }
      }
      await sleep(150);
    }
    if (bars.length >= 100) out.push({ code, name, bars: bars.sort((a, b) => a[0] < b[0] ? -1 : 1) });
    else fail++;
    if ((out.length + fail) % 30 === 0) console.log(`[industry] 进度 ${out.length + fail}/${boards.length}`);
  }
}
await Promise.all(Array.from({ length: WORKERS }, () => worker()));
if (out.length < 50) { console.error(`[industry] 成功过少: ${out.length}/${boards.length}`); process.exit(1); }
atomicWriteJSON(OUT, JSON.stringify(out));
console.log(`[industry] 完成: ${out.length} 板块 · 失败 ${fail} → ${OUT}`);
