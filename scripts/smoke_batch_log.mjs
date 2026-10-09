// 真浏览器冒烟：验证「批量下单」与「事件日志」两张面板在 Edge 里真的可用。
//
// 为什么不只靠 check_frontend（jsdom）：jsdom 不做布局、不跑真实事件时序，
// 「面板渲染出来了」和「用户点得动」是两件事。本脚本用真浏览器把主链路走一遍：
//   ① 打开页面 → 两张卡片存在且可见
//   ② 填两行标的 → 点批量提交 → 结果表出现行 + 汇总条有计数
//   ③ 日志表出现日志行；切「龙虎过滤」阶段后行数收敛
// 只做只读断言 + 一次本地账本操作（localStorage），不发任何真实交易请求。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// ESM 的 import 不认 NODE_PATH，必须用 createRequire 走 CJS 解析器，
// 才能找到隔离目录里装的 playwright-core（与项目既有约定一致）。
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const ROOT = process.cwd();
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok: !!ok, extra });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
};

const browser = await chromium.launch({ channel: 'msedge', executablePath: EDGE });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));

const url = 'http://127.0.0.1:8811/index.html';
await page.goto(url, { waitUntil: 'load' });
// 等存档 fetch + 首屏渲染 + 实时行情
await page.waitForTimeout(3500);

check('页面加载无 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '));

check('批量下单卡片存在且可见',
  await page.locator('#zone-paper .paper-batch').isVisible().catch(() => false));
check('事件日志卡片存在且可见',
  await page.locator('#zone-paper .paper-log').isVisible().catch(() => false));
check('批量输入区 / 结果表 / 汇总条齐备',
  await page.locator('#btInput').count() === 1
  && await page.locator('#btTable').count() === 1
  && await page.locator('#btSummary').count() === 1);

// 填两行并提交（会被龙虎过滤如实拦下或放行，两者都算链路通）
await page.fill('#btInput', '300893,5\n600519,5');
await page.click('#btSubmit');
await page.waitForTimeout(2500);

const btRows = await page.locator('#btTable tbody tr').count();
check('批量提交后结果表逐只列出', btRows >= 2, `${btRows} 行`);

const sumTxt = (await page.locator('#btSummary').innerText()).replace(/\s+/g, ' ');
check('汇总条给出已挂单/被拦计数', /已挂单/.test(sumTxt) && /被拦/.test(sumTxt), sumTxt.slice(0, 110));

const hintTxt = (await page.locator('#btHint').innerText()).replace(/\s+/g, ' ');
check('脚注写明龙虎过滤版本与三档口径',
  /龙虎榜前置过滤版本/.test(hintTxt) && /主池/.test(hintTxt) && /剔除/.test(hintTxt), hintTxt.slice(0, 110));

// 日志面板
const logRows = await page.locator('#logTable tbody tr').count();
check('事件日志表自动产生日志行', logRows >= 1, `${logRows} 行`);

await page.click('#logTabs button[data-stage="lhb"]');
await page.waitForTimeout(300);
const lhbRows = await page.locator('#logTable tbody tr').count();
check('按「龙虎过滤」阶段过滤后行数收敛', lhbRows <= logRows, `${lhbRows} ≤ ${logRows}`);

await page.click('#logTabs button[data-stage=""]');
await page.waitForTimeout(300);
check('切回「全部」恢复完整行数',
  await page.locator('#logTable tbody tr').count() === logRows, `vs ${logRows}`);

// 卖出方向：口径控件应被禁用
await page.click('#btSide button[data-side="sell"]');
await page.waitForTimeout(300);
const modeDisabled = await page.locator('#btMode button:disabled').count();
check('卖出方向下数量口径控件被禁用', modeDisabled === 2, `禁用 ${modeDisabled}/2`);

// 截图留档
await page.click('#btSide button[data-side="buy"]');
await page.waitForTimeout(300);
const shot = path.join(ROOT, 'tmp_batch_log_smoke.png');
await page.locator('#zone-paper').screenshot({ path: shot });
console.log(`\n截图：${shot}`);

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n[smoke] ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) { console.log('失败项：' + failed.map((f) => f.name).join(' ; ')); process.exit(1); }
