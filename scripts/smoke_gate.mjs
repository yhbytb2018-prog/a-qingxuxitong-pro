// 真浏览器冒烟：验「龙虎榜净买入 ≤ 0 → 人工复核后才允许下单」这条规则**在真实页面上真的成立**。
//
// 为什么必须单独做一遍真浏览器验证（而不是只靠 check_frontend 的 jsdom）：
//   这条规则的核心是「门槛拦在**真正下单那一行之前**」——那是个**执行时序**属性。
//   jsdom 里断言「函数里写了 !reviewPassed(...)」只能证明代码存在，
//   证明不了点击「提交委托」时它确实先于 submitOrder 执行、且未复核时确实不产生委托。
//   所以这里走完整链路：填代码 → 提示条显形 → 未复核被拦 → 确认复核 → 放行。
//
// 用真实存档里的降级票（2026-09-30 有 33 只净买 ≤ 0），不伪造数据。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

// 2026-09-30 真实降级票：澳弘电子，当日龙虎净买 −721.8 万
const DOWN_CODE = '605058';
// 当日榜上净买为正的票（用于验「非降级票不显示提示条」）。
// ⚠ 早先误用 688137——它当日 net_buy_wan 恰为 0，会被规则**正确地**判为降级，
//   于是断言「不显示提示条」失败。这不是引擎的 bug，是样本选错了。
//   挑样本时必须真的查一眼 net_buy_wan > 0，不能凭"名字看着像好票"。
const OK_CODE = '301218';   // 华是科技，当日净买 +2.84 亿

const results = [];
const ck = (name, ok, extra = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
};

const browser = await chromium.launch({ channel: 'msedge', executablePath: EDGE });
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));

await page.goto('http://127.0.0.1:8811/', { waitUntil: 'load' });
await page.waitForTimeout(2500);
// 从干净状态开始：清掉上次跑留下的账户与复核记录，否则「未复核」前置条件不成立
await page.evaluate(() => {
  for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith('paper-acct-')) localStorage.removeItem(k); }
  if (window.__reviewGate) window.__reviewGate.clear();
});
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(2000);

// 账户持久化的 key 由 paper_ui.js 的 LS_KEY 决定（'paper-acct-' + PAPER_VERSION）。
// ⚠ 不要手抄 key 字面量去读——早先写成 'paper_account' 读不到东西，
//   于是「委托已挂单」被误判成「pending=0 → 门槛没放行」。key 从页面里问出来。
const settleState = () => page.evaluate(() => {
  // 从 localStorage 里找 paper-acct-* 那个键（版本号可能变，不硬编码）
  let acct = null;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('paper-acct-')) {
      try { acct = JSON.parse(localStorage.getItem(k) || '{}'); } catch (e) { acct = null; }
    }
  }
  return {
    hasAcct: acct !== null,
    pend: acct ? (acct.pending || []).length : -1,
    msg: (document.getElementById('paperMsg') || {}).textContent || '',
  };
});
const settled = settleState;
// 「一笔委托都没有」的判定：**账户还不存在**（尚未有过任何成功委托，故从未落盘）
// 与「账户存在但 pending 为空」是同一件事的两种表现，不能只认后者。
// 早先断言 pend === 0 会误判：未复核被拦时账户根本没落盘，pend 取到 -1。
const noOrders = (s) => s.pend === 0 || (s.pend === -1 && !s.hasAcct);

// ① 填入降级票 → 复核提示条必须显形，并带上规则引擎给的标签与扣分明细
await page.fill('#poCode', DOWN_CODE);
await page.waitForTimeout(700);
const s1 = await page.evaluate(() => {
  const g = document.getElementById('poGate');
  return {
    hidden: g.hidden, txt: g.textContent, cls: g.className,
    hasBtn: !!g.querySelector('[data-act="review-ok"]'),
  };
});
ck('端到端①：填入降级票后复核提示条显形', s1.hidden === false, `hidden=${s1.hidden}`);
ck('端到端②：提示条含规则引擎给出的告警标签', s1.txt.includes('⚠龙虎当日资金净流出，谨慎开仓'));
ck('端到端③：提示条给出扣分明细（综合分 10 分 / 上涨概率 8 个百分点）',
  s1.txt.includes('10 分') && s1.txt.includes('8 个百分点'));
ck('端到端④：提示条给出当日净额（亿元）', /净买\s*−?\d/.test(s1.txt), s1.txt.match(/净买[^。]*/)?.[0] || '');
ck('端到端⑤：未复核状态下渲染出「确认复核」按钮', s1.hasBtn);

// ② 未复核直接提交 → 必须被拦下，且不得产生任何委托
await page.fill('#poQty', '100');
await page.click('#poSubmit');
await page.waitForTimeout(900);
const s2 = await settled();
ck('端到端⑥：未复核提交被拦住，未生成任何委托', noOrders(s2), `pending=${s2.pend} hasAcct=${s2.hasAcct}`);
ck('端到端⑦：给出可读的拦截说明（含「人工复核」）', /人工复核/.test(s2.msg), s2.msg.slice(0, 70));

// ③ 点「确认复核」→ 只授权，不自动下单（「复核」与「下单」必须仍是两个动作）
await page.click('[data-act="review-ok"]');
await page.waitForTimeout(600);
const s3 = await page.evaluate(() => {
  let acct = null;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('paper-acct-')) { try { acct = JSON.parse(localStorage.getItem(k) || '{}'); } catch (e) { acct = null; } }
  }
  return {
    hasAcct: acct !== null,
    pend: acct ? (acct.pending || []).length : -1,
    passed: window.__reviewGate.passed('605058'),
    gateCls: document.getElementById('poGate').className,
  };
});
ck('端到端⑧：确认复核后该票标记为已放行', s3.passed === true);
ck('端到端⑨：确认复核**不会**自动下单（仍 0 笔委托）', noOrders(s3), `pending=${s3.pend}`);
ck('端到端⑩：提示条转为已复核态（样式类含 ok）', /\bok\b/.test(s3.gateCls), s3.gateCls);

// ④ 复核后再提交 → 才允许进入待撮合
await page.click('#poSubmit');
await page.waitForTimeout(1200);
const s4 = await settled();
ck('端到端⑪：复核后提交被放行，委托进入待撮合', s4.pend === 1, `pending=${s4.pend}`);

// ⑤ 换票 → 复核记录必须作废（确认是「针对这只票」，不得跨票顺延）
await page.fill('#poCode', OK_CODE);
await page.waitForTimeout(500);
const s5 = await page.evaluate(() => window.__reviewGate.passed('605058'));
ck('端到端⑫：换代码后复核标记作废（不跨票顺延）', s5 === false);

// ⑥ 非降级票不应出现提示条
const s6 = await page.evaluate((okCode) => ({
  hidden: document.getElementById('poGate').hidden,
  notOutflow: window.__reviewGate.outflowOf(okCode) === null,
}), OK_CODE);
ck('端到端⑬：无净流出的票不显示复核提示条', s6.hidden === true && s6.notOutflow === true,
  `hidden=${s6.hidden} notOutflow=${s6.notOutflow}`);

ck('端到端：全程页面无 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '));

await page.screenshot({ path: 'shots/smoke_gate.png' });
await browser.close();

const pass = results.filter((r) => r.ok).length;
console.log(`\n[smoke-gate] ${pass}/${results.length} 通过`);
console.log('截图：' + process.cwd() + '/shots/smoke_gate.png');
process.exit(pass === results.length ? 0 : 1);
