// 北交所存活代码枚举：qt.gtimg 批量行情探测（43/83/87/92 段）+ 腾讯 bj K 线可达性
// 产物：data/bt_bj_codes.json = [["bj430047","代码名"],...]
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { atomicWriteJSON } from '../src/fsutil.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'bt_bj_codes.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 腾讯 bj K 线可达性
try {
  const r = await fetch('https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=bj920002,day,,,10', { headers: { Referer: 'https://gu.qq.com/', 'User-Agent': UA } });
  const j = await r.json();
  const d = j.data && j.data.bj920002;
  console.log('腾讯 bj K 线:', d && d.day ? 'OK · ' + d.day.length + ' bars · 末条 ' + JSON.stringify(d.day[d.day.length - 1]) : '无数据 ' + JSON.stringify(j).slice(0, 120));
} catch (e) { console.log('腾讯 bj K 线异常:', e.message); }

if (existsSync(OUT)) {
  console.log('已有枚举缓存:', JSON.parse(readFileSync(OUT, 'utf8')).length, '只 · 跳过');
  process.exit(0);
}

// GBK 解码
const dec = new TextDecoder('gbk');
async function quoteBatch(codes) {
  const r = await fetch('https://qt.gtimg.cn/q=' + codes.join(','), { headers: { 'User-Agent': UA } });
  const buf = await r.arrayBuffer();
  const txt = dec.decode(buf);
  const out = [];
  for (const m of txt.matchAll(/v_(bj\d{6})="([^"]+)"/g)) {
    if (!m[2]) continue;
    const f = m[2].split('~');
    if (f.length > 2 && f[1]) out.push([m[1], f[1]]);
  }
  return out;
}

const live = [];
const ranges = [[920000, 920999], [830000, 839999], [870000, 879999], [430001, 439999]];
for (const [a, b] of ranges) {
  const all = [];
  for (let c = a; c <= b; c++) all.push('bj' + c);
  for (let i = 0; i < all.length; i += 60) {
    try {
      const got = await quoteBatch(all.slice(i, i + 60));
      for (const x of got) live.push(x);
    } catch (e) { console.error('批次失败 ' + all[i] + '~:', e.message); }
    await sleep(250);
  }
  console.log(`段 ${a}~${b} 完成 · 累计存活 ${live.length}`);
}
// 去重
const map = new Map(live);
atomicWriteJSON(OUT, JSON.stringify([...map.entries()], null, 1));
console.log(`北交所存活: ${map.size} 只 → ${OUT}`);
