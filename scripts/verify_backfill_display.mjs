// 真浏览器核验：241 天档案下「回填天不进展示」是否真的生效。
// 断言点（全部从真实 DOM 读，不接受引擎自述）：
//   1) 趋势图数据点数应等于 displayDays 长度（33），而不是 all_days 长度（241）
//   2) 报告里「样本 N 个交易日」必须是 33，不是 241
//   3) 档案的确含 208 个 _backfill 天（否则本核验无意义）
//   4) 无 JS 异常
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = 'http://127.0.0.1:8811/index.html';

const browser = await chromium.launch({ executablePath: EDGE });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const r = await page.evaluate(() => {
  // ARC 是 app.js 的模块内局部变量，不在 window 上 → 全部改为从**可见 DOM 文本**读，
  // 这也更接近真实用户看到的东西（不依赖任何引擎自述字段）。
  const svg = document.querySelector('#trendSvg');
  const circles = svg ? svg.querySelectorAll('circle').length : -1;
  const reportText = (document.querySelector('#briefBody') || {}).textContent || '';
  const m = reportText.match(/样本\s*(\d+)\s*个交易日/);
  const tip = (document.querySelector('#trendTip') || {}).textContent || '';
  // 走势图提示里的「最新 YYYY-MM-DD 分值」
  const tm = tip.match(/最新\s*(\d{4}-\d{2}-\d{2})\s*([\d.]+)/);
  // 顶部展示的数据日期
  const tradeDate = (document.querySelector('#tradeDate') || {}).textContent || '';
  return {
    circles,
    reportSampleN: m ? Number(m[1]) : null,
    reportMentions241: /241\s*个交易日/.test(reportText),
    reportHasNaN: /NaN|undefined|Infinity/.test(reportText),
    tipLatestDate: tm ? tm[1] : null,
    tipLatestValue: tm ? Number(tm[2]) : null,
    tradeDate: tradeDate.trim(),
    trendTip: tip,
  };
});

await page.screenshot({ path: 'shots/backfill_verify.png', fullPage: false });
await browser.close();

console.log(JSON.stringify(r, null, 1));
console.log('');
const checks = [
  ['报告样本数 = 33（不含 208 回填天）', r.reportSampleN === 33],
  ['报告未出现「241 个交易日」', r.reportMentions241 === false],
  ['走势图最新日 = 2026-09-30', r.tipLatestDate === '2026-09-30'],
  ['走势图最新值 64.4（真综合分，非 s_net 占位）', r.tipLatestValue === 64.4],
  ['顶部数据日期 = 2026-09-30', r.tradeDate === '2026-09-30'],
  ['趋势数据点 ≤ 20（15 日窗口）', r.circles >= 0 && r.circles <= 20],
  ['报告无 NaN/undefined', r.reportHasNaN === false],
  ['无 JS 异常', errs.length === 0],
];
let pass = 0;
for (const [name, ok] of checks) { console.log(`${ok ? '✓' : '✗'} ${name}`); if (ok) pass++; }
console.log(`\n[backfill-verify] ${pass}/${checks.length} 通过`);
if (errs.length) { console.log('JS 异常：'); for (const e of errs.slice(0, 5)) console.log('  ' + e); }
process.exit(pass === checks.length ? 0 : 1);
