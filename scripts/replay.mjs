// 离线回放：用快照页面重建 archive.json，并打印"去噪前/后"噪声对比
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runOffline, extractArchive, writeArchive } from '../src/pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const snap = path.join(ROOT, 'snapshot.html');
if (!existsSync(snap)) { console.error('缺少 snapshot.html'); process.exit(1); }

const html = readFileSync(snap, 'utf8');
const arc = extractArchive(html);
const days = arc.all_days || [];

// 去噪前（原始 topics 标签）动量
const recent = days.slice(-5), prev = days.slice(-10, -5);
const rt = new Set(); recent.forEach((d) => (d.topics || []).forEach((t) => rt.add(t.tag)));
const pt = new Set(); prev.forEach((d) => (d.topics || []).forEach((t) => pt.add(t.tag)));
const freshRaw = [...rt].filter((t) => !pt.has(t));
const fadeRaw = [...pt].filter((t) => !rt.has(t));

// 去噪后（管道产出）
const out = runOffline(snap);
const a = writeArchive(out);
console.log('========== 噪声对比 ==========');
console.log('去噪前: 新晋', freshRaw.length, '/ 退潮', fadeRaw.length, ' (原始 topics 标签)');
console.log('去噪后: 新晋', out.signals.momentum.fresh.length,
  '/ 退潮', out.signals.momentum.fading.length, ' (标准题材)');
console.log('最新日:', out.signals.tradeDate, '| 情绪分:', out.signals.latestEmotion?.value ?? out.signals.latestEmotion?.score);
console.log('最新日 去噪题材 TOP:',
  Object.entries(out.all_days[out.all_days.length - 1].themes)
    .sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${k}(${v})`).join(' '));
console.log('输出:', a.path);
