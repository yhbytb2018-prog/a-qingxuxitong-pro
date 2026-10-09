// ★ 席位桥接一致性守卫（H-3，2026-10-07）────────────────────────────────────
// app.js 的 seatsMod() 在 window.Seats 未就绪的窗口期用**内联降级副本**顶上（模块脚本是
// 异步加载的，首屏竞态真实存在）。此前副本漏了 keepSeat 过滤——污染行（交易所投资者结构
// 统计行）顶着 23 倍虚增的金额直接上屏，而主模块一直有过滤。两边"各改各的"就是这类分叉
// 的成因，与 test/offline.test.mjs ⑤（sw.js ↔ src/offline.js）同款问题、同款守卫：
// 提取 app.js 的**真实函数文本**（非复制品）在 vm 里执行，与 src/seats.js 喂同一份数据，
// 读取口径必须逐字一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { seatsOf, sideStats, seatTypeOf } from '../src/seats.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRaw = readFileSync(path.join(ROOT, 'app.js'), 'utf8');

// vm 跨 realm：副本返回的对象原型属于 vm 的 realm，deepStrictEqual 会因 [[Prototype]]
// 不同而报"结构相同但引用不等"（与逻辑分叉无关）。round-trip 成本进程对象再比，
// 深度语义不丢，只剥掉跨 realm 的原型干扰。
const j = (x) => JSON.parse(JSON.stringify(x));

// 提取 app.js 的 seatsMod 函数文本（顶格 } 结束；函数体内嵌套块均有缩进，不会提前截断）
const fnStart = appRaw.indexOf('function seatsMod()');
const fnEnd = appRaw.indexOf('\n}', fnStart) + 2;
assert.ok(fnStart > 0 && fnEnd > fnStart, 'app.js 必须有 seatsMod 桥接函数');
const fnText = appRaw.slice(fnStart, fnEnd);

// vm 执行：window.Seats 缺位 → 走降级副本分支（正是要测的那条路径）
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fnText + '\nwindow.__seatsFallback = seatsMod();', ctx);
const FB = ctx.window.__seatsFallback;

// 污染数据：模拟东财区间榜形态——真实席位行 + 类别汇总行混杂（数值参照 2026-09-30
// 688137 近岸蛋白实录），覆盖新格式 {b,s}（含对象元素）与旧格式（仅买方数组）。
const POLLUTED = {
  NEW: {
    b: [
      ['自然人', 7580000], ['中信证券股份有限公司上海分公司', 50010],
      ['机构专用', 30000], { name: '中小投资者', v: 414900 },
    ],
    s: [['机构', 411700], ['国泰海通证券股份有限公司南京胜利路证券营业部', 8000]],
  },
  OLD: [['自然人', 100], ['高盛(中国)证券有限责任公司上海浦东新区世纪大道证券营业部', 9000]],
};
const AGG_NAMES = ['自然人', '机构', '中小投资者', '其他自然人', '其他机构', '专业机构', '个人投资者', '非金融类上市公司'];

test('★ 副本 seatsOf 与主模块逐字一致（新/旧格式 + 污染行剔除）', () => {
  for (const code of ['NEW', 'OLD']) {
    const fromMain = seatsOf(POLLUTED, code);
    const fromCopy = j(FB.seatsOf(POLLUTED, code));
    assert.deepEqual(fromCopy, fromMain, `${code}：降级副本与 src/seats.js 分叉`);
  }
});

test('★ keepSeat 过滤真的在起作用（绝对断言，防“两边同错”的假绿）', () => {
  // 若两边都丢了这个过滤，上面的 deepEqual 依旧全绿（H-5 的教训）——所以必须独立断言
  // “污染行确实被剔除了”：构造数据里 NEW.b 有 2 个污染行、NEW.s 有 1 个、OLD 有 1 个。
  const { b, s } = seatsOf(POLLUTED, 'NEW');
  assert.equal(b.filter((x) => AGG_NAMES.includes(x[0])).length, 0, 'NEW.b 污染行必须被剔除');
  assert.equal(s.filter((x) => AGG_NAMES.includes(x[0])).length, 0, 'NEW.s 污染行必须被剔除');
  assert.equal(b.length, 2, 'NEW.b 剩真实席位 2 行（机构专用 + 分公司）');
  assert.equal(seatsOf(POLLUTED, 'OLD').b.length, 1, 'OLD 旧格式剩营业部 1 行');
  // 副本同样过这道绝对断言（修复前命中率 0，现在与主模块同为 4/4）
  const fbNew = FB.seatsOf(POLLUTED, 'NEW');
  assert.equal(fbNew.b.filter((x) => AGG_NAMES.includes(x[0])).length + fbNew.s.filter((x) => AGG_NAMES.includes(x[0])).length, 0,
    '降级副本的污染行剔除率必须恢复为 100%（H-3 修复前为 0）');
});

test('★ 副本 sideStats / seatTypeOf 与主模块一致', () => {
  const { b, s } = seatsOf(POLLUTED, 'NEW');
  assert.deepEqual(j(FB.sideStats(b)), sideStats(b));
  assert.deepEqual(j(FB.sideStats(s)), sideStats(s));
  const names = [...b.map((x) => x[0]), '国泰海通证券股份有限公司南京胜利路证券营业部', '高盛(中国)证券有限责任公司上海浦东新区世纪大道证券营业部'];
  for (const n of names) assert.equal(FB.seatIdentity(n).type, seatTypeOf(n), `席位类型分叉：${n}`);
});

test('★ 边界一致：空档 / 缺 code / 空行', () => {
  assert.deepEqual(j(FB.seatsOf({}, 'X')), seatsOf({}, 'X'));
  assert.deepEqual(j(FB.seatsOf(POLLUTED, null)), seatsOf(POLLUTED, null));
  assert.deepEqual(j(FB.seatsOf({ E: { b: null, s: [] } }, 'E')), seatsOf({ E: { b: null, s: [] } }, 'E'));
  assert.deepEqual(j(FB.seatsOf(null, 'X')), seatsOf(null, 'X'));
});
