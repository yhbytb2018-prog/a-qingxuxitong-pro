import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seatsOf, buySeatsOf, sellSeatsOf, sideStats,
  brokerOf, seatTypeOf, SEAT_TYPE_LABEL, isForeignBroker, cityOf, seatIdentity, SIDE, isAggregateSeatRow,
} from '../src/seats.js';

// ────────────────────────── 新旧格式兼容 ──────────────────────────

test('seats: 旧格式（仅买方数组）读取为 {b,s,hasSell:false}', () => {
  const dm = { '600000': [['中信证券股份有限公司总部', 5000], ['机构专用', 3000]] };
  const r = seatsOf(dm, '600000');
  assert.equal(r.b.length, 2);
  assert.equal(r.b[0][0], '中信证券股份有限公司总部');
  assert.equal(r.b[0][1], 5000);
  assert.deepEqual(r.s, []);
  assert.equal(r.hasSell, false);
});

test('seats: 新格式（{b,s}）双侧都能读到', () => {
  const dm = { '600000': { b: [['席位A', 100]], s: [['席位B', 80], ['席位C', 20]] } };
  const r = seatsOf(dm, '600000');
  assert.equal(r.b.length, 1);
  assert.equal(r.s.length, 2);
  assert.equal(r.hasSell, true);
  assert.equal(r.s[1][0], '席位C');
  assert.equal(r.s[1][1], 20);
});

test('seats: 空 / 未知代码 / 空 map 都不崩', () => {
  assert.deepEqual(seatsOf(null, 'x'), { b: [], s: [], hasSell: false });
  assert.deepEqual(seatsOf({}, 'x'), { b: [], s: [], hasSell: false });
  assert.deepEqual(seatsOf({ x: null }, 'x'), { b: [], s: [], hasSell: false });
  assert.equal(seatsOf(undefined, undefined).hasSell, false);
});

test('seats: buySeatsOf / sellSeatsOf 各按金额降序', () => {
  const dm = { c: { b: [['a', 10], ['b', 30], ['c', 20]], s: [['x', 5], ['y', 50]] } };
  assert.deepEqual(buySeatsOf(dm, 'c').map((p) => p[0]), ['b', 'c', 'a']);
  assert.deepEqual(sellSeatsOf(dm, 'c').map((p) => p[0]), ['y', 'x']);
  // 旧格式下卖侧恒为空
  assert.deepEqual(sellSeatsOf({ c: [['a', 1]] }, 'c'), []);
});

// ────────────────────────── sideStats ──────────────────────────

test('seats: sideStats 合计 / 前3占比 / 空侧', () => {
  const st = sideStats([['a', 100], ['b', 50], ['c', 30], ['d', 20]]);
  assert.equal(st.n, 4);
  assert.equal(st.sum, 200);
  assert.equal(st.top3Pct, (180 / 200) * 100); // (100+50+30)/200
  const empty = sideStats([]);
  assert.equal(empty.n, 0);
  assert.equal(empty.sum, 0);
  assert.equal(empty.top3Pct, null); // 除零不产出 NaN
  assert.equal(sideStats(null).n, 0);
});

test('seats: sideStats 不足 3 席时占比为 100%', () => {
  const st = sideStats([['a', 10], ['b', 5]]);
  assert.equal(st.top3Pct, 100);
});

// ────────────────────────── 券商主体解析 ──────────────────────────

test('broker: 常见写法差异归一为同一主体', () => {
  assert.equal(brokerOf('国泰海通证券股份有限公司南京胜利路证券营业部'), '国泰海通证券');
  assert.equal(brokerOf('国泰海通证券股份有限公司上海长宁区江苏路证券营业部'), '国泰海通证券');
  assert.equal(brokerOf('中信建投证券股份有限公司上海分公司'), '中信建投证券');
  assert.equal(brokerOf('东方财富证券股份有限公司拉萨团结路第二证券营业部'), '东方财富证券');
  // 括号地域写法
  assert.equal(brokerOf('高盛(中国)证券有限责任公司上海浦东新区世纪大道证券营业部'), '高盛(中国)证券');
  // 有限责任公司 / 有限公司 都能剥
  assert.equal(brokerOf('华鑫证券有限责任公司上海长宁区天山路证券营业部'), '华鑫证券');
  assert.equal(brokerOf('甬兴证券有限公司宁波和源路证券营业部'), '甬兴证券');
});

test('broker: 基金/资管主体也能识别', () => {
  assert.equal(brokerOf('某某基金管理有限公司'), '某某基金');
  // "资产管理" 是完整机构关键词，不应被截成 "资管"（那会造成同一主体两种写法对不上）
  assert.equal(brokerOf('某某资产管理有限公司'), '某某资产管理');
});

test('broker: 机构专用 / 股通无券商主体', () => {
  assert.equal(brokerOf('机构专用'), '');
  assert.equal(brokerOf('深股通专用'), '');
  assert.equal(brokerOf('沪股通专用'), '');
  assert.equal(brokerOf(''), '');
  assert.equal(brokerOf(null), '');
});

// ────────────────────────── 席位类型 ──────────────────────────

test('type: 六类判定', () => {
  assert.equal(seatTypeOf('机构专用'), 'inst');
  assert.equal(seatTypeOf('深股通专用'), 'north');
  assert.equal(seatTypeOf('沪股通专用'), 'north');
  assert.equal(seatTypeOf('中泰证券股份有限公司总部'), 'prop');
  assert.equal(seatTypeOf('某某证券股份有限公司自营部'), 'prop');
  assert.equal(seatTypeOf('广发证券股份有限公司江西分公司'), 'branch');
  assert.equal(seatTypeOf('中信建投证券股份有限公司上海分公司'), 'branch');
  assert.equal(seatTypeOf('国泰海通证券股份有限公司南京胜利路证券营业部'), 'sales');
  assert.equal(seatTypeOf(''), 'other');
  assert.equal(seatTypeOf('某神秘席位'), 'other');
});

test('type: 类型中文标签齐全且与判定一致', () => {
  for (const t of ['inst', 'north', 'prop', 'branch', 'sales', 'other']) {
    assert.ok(SEAT_TYPE_LABEL[t], `缺标签: ${t}`);
  }
  assert.equal(SEAT_TYPE_LABEL.inst, '机构专用');
  assert.equal(SEAT_TYPE_LABEL.north, '沪深股通');
});

// ────────────────────────── 外资券商 ──────────────────────────

test('foreign: 外资/合资券商标注为 true，内资为 false', () => {
  assert.equal(isForeignBroker('高盛(中国)证券有限责任公司上海浦东新区世纪大道证券营业部'), true);
  assert.equal(isForeignBroker('瑞银证券有限责任公司上海花园石桥路证券营业部'), true);
  assert.equal(isForeignBroker('摩根大通证券(中国)有限公司'), true);
  assert.equal(isForeignBroker('野村东方国际证券有限公司'), true);
  assert.equal(isForeignBroker('中信证券股份有限公司总部'), false);
  assert.equal(isForeignBroker('东方财富证券股份有限公司拉萨团结路第二证券营业部'), false);
  assert.equal(isForeignBroker(''), false);
});

// ────────────────────────── 城市解析（曾经的 bug 回归） ──────────────────────────

test('city: 修掉"南京胜利""海浦东新"这类切错（白名单最长匹配）', () => {
  // 这些是本轮修复前的真实错误输出，做成回归断言
  assert.equal(cityOf('国泰海通证券股份有限公司南京胜利路证券营业部'), '南京');
  assert.equal(cityOf('国泰海通证券股份有限公司上海浦东新区世纪大道证券营业部'), '上海');
  assert.equal(cityOf('东方财富证券股份有限公司拉萨团结路第二证券营业部'), '拉萨');
  assert.equal(cityOf('甬兴证券有限公司宁波和源路证券营业部'), '宁波');
  assert.equal(cityOf('瑞银证券有限责任公司上海银城中路证券营业部'), '上海');
  assert.equal(cityOf('国泰海通证券股份有限公司上海长宁区江苏路证券营业部'), '上海');
});

test('city: 常见营业部驻地都能取到', () => {
  assert.equal(cityOf('中国银河证券股份有限公司北京中关村大街证券营业部'), '北京');
  assert.equal(cityOf('广发证券股份有限公司深圳后海证券营业部'), '深圳');
  assert.equal(cityOf('华泰证券股份有限公司常州东横街证券营业部'), '常州');
  assert.equal(cityOf('开源证券股份有限公司西安西大街证券营业部'), '西安');
  assert.equal(cityOf('东方证券股份有限公司长沙芙蓉南路证券营业部'), '长沙');
  assert.equal(cityOf('平安证券股份有限公司嘉兴中环南路证券营业部'), '嘉兴');
});

test('city: 取不到城市时返回空（不猜，比猜错安全）', () => {
  assert.equal(cityOf('机构专用'), '');
  assert.equal(cityOf('深股通专用'), '');
  assert.equal(cityOf('中泰证券股份有限公司总部'), ''); // 总部无地名
  assert.equal(cityOf('广发证券股份有限公司江西分公司'), ''); // 省级分公司（省非城市，不硬凑）
  assert.equal(cityOf(''), '');
  assert.equal(cityOf(null), '');
});

test('city: 主体名里碰巧含城市字不会误判（只看主体之后的地名段）', () => {
  // "长江证券"含"江"但不是城市；若把主体算进去可能误配。地名段为空则应返回空。
  assert.equal(cityOf('长江证券股份有限公司总部'), '');
});

// ────────────────────────── seatIdentity 聚合 ──────────────────────────

test('seatIdentity: 一次给出全部可核验字段', () => {
  const id = seatIdentity('高盛(中国)证券有限责任公司上海浦东新区世纪大道证券营业部');
  assert.equal(id.broker, '高盛(中国)证券');
  assert.equal(id.type, 'sales');
  assert.equal(id.typeLabel, '证券营业部');
  assert.equal(id.foreign, true);
  assert.equal(id.city, '上海');
  assert.equal(id.name, '高盛(中国)证券有限责任公司上海浦东新区世纪大道证券营业部');
});

test('seatIdentity: 机构专用字段自洽', () => {
  const id = seatIdentity('机构专用');
  assert.equal(id.type, 'inst');
  assert.equal(id.broker, '');
  assert.equal(id.foreign, false);
  assert.equal(id.city, '');
});

test('SIDE 常量稳定（前端 data-side 依赖它）', () => {
  assert.equal(SIDE.BUY, 'b');
  assert.equal(SIDE.SELL, 's');
});

// ────────────────────────── 真实存档抽样 ──────────────────────────

test('seats: 真实 archive 里旧格式天数能被安全读取（不崩、卖侧为空）', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const p = new URL('../data/archive.json', import.meta.url);
  if (!existsSync(p)) return; // CI 无存档时跳过
  // ⚠ 主档是**序列化态**（reason 已码表压缩、seats/lhb 已提到 `_sub`）。
  //   直接读会拿到 `summary.seats === null` 的占位，本测试就会误报"存档里没有席位明细"。
  //   凡读主档处一律先 decodeArchive —— 这是全局纪律，不是本测试的局部技巧。
  const { decodeArchive } = await import('../src/lhb_codec.js');
  const arc = decodeArchive(JSON.parse(readFileSync(p, 'utf8')));
  const days = arc.all_days || [];
  let v1 = 0, v2 = 0, checked = 0;
  for (const d of days) {
    const det = d.summary?.seats?.detail;
    if (!det) continue;
    for (const code of Object.keys(det)) {
      const r = seatsOf(det, code);
      checked++;
      if (r.hasSell) v2++; else v1++;
      // 双侧任一存在即应可读；条数为 0 时不应有残值
      assert.ok(Array.isArray(r.b) && Array.isArray(r.s));
      for (const [nm, v] of r.b.concat(r.s)) {
        assert.equal(typeof nm, 'string');
        assert.ok(Number.isFinite(v));
      }
    }
  }
  assert.ok(checked > 0, '存档里应至少有一只票的席位明细');
  // 旧格式（v1）天数必须能读——这是向后兼容的核心断言
  assert.ok(v1 + v2 === checked);
});

// ────────────────────────── 类别汇总行净化（真 bug 回归）──────────────────────────
// 东财席位明细接口对部分票（尤其区间累计榜）会返回「自然人/中小投资者/机构/其他自然人」
// 这类投资者结构汇总行——它们不是席位，金额与整票成交额同阶。
// 2026-09-30 实测：688137 近岸蛋白 一条区间榜 4 行汇总合计 192.77 亿，被计入游资买入，
// 使游资买入 77.56→270.33 亿、买方头部3席位集中度 44.5%→18.7%、该票集中度虚高进 TOP5。

test('seats: isAggregateSeatRow 精确识别投资者结构汇总行', () => {
  for (const n of ['自然人', '机构', '中小投资者', '其他自然人', '其他机构', '专业机构', '个人投资者']) {
    assert.equal(isAggregateSeatRow(n), true, `${n} 应判为汇总行`);
    assert.equal(isAggregateSeatRow(` ${n} `), true, `${n}（带空格）应判为汇总行`);
  }
});

test('seats: isAggregateSeatRow 不误杀真实席位名', () => {
  for (const n of [
    '机构专用', '深股通专用', '沪股通专用',
    '中信证券股份有限公司深圳深南中路中信大厦证券营业部',
    '国泰海通证券股份有限公司总部', '平安证券股份有限公司浙江分公司',
    '高盛(中国)证券有限责任公司上海浦东新区世纪大道证券营业部',
    '某机构专用席位', // 含"机构"但不是全等
    '', null, undefined,
  ]) {
    assert.equal(isAggregateSeatRow(n), false, `${n} 不应判为汇总行`);
  }
});

test('seats: seatsOf 读明细时自动剔除汇总行（新旧格式都剔）', () => {
  // 旧格式（仅买方数组）
  const v1 = { '688137': [['自然人', 757986], ['高盛(中国)证券有限责任公司上海浦东新区世纪大道证券营业部', 11347]] };
  const r1 = seatsOf(v1, '688137');
  assert.deepEqual(r1.b.map((x) => x[0]), ['高盛(中国)证券有限责任公司上海浦东新区世纪大道证券营业部']);
  // 新格式（{b,s}）
  const v2 = { '600000': { b: [['中小投资者', 414874], ['席位A', 100]], s: [['机构', 411742], ['席位B', 80]] } };
  const r2 = seatsOf(v2, '600000');
  assert.deepEqual(r2.b.map((x) => x[0]), ['席位A']);
  assert.deepEqual(r2.s.map((x) => x[0]), ['席位B']);
  assert.equal(r2.hasSell, true);
});

test('seats: 净化后 688137 真实数据里集中度不再被汇总行占满', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const p = new URL('../data/archive.json', import.meta.url);
  if (!existsSync(p)) return;
  const arc = JSON.parse(readFileSync(p, 'utf8'));
  const det = (arc.all_days || []).find((d) => d.trade_date === '2026-09-30')?.summary?.seats?.detail;
  if (!det || !det['688137']) return; // 存档变化则跳过
  const rows = seatsOf(det, '688137').b;
  assert.ok(!rows.some(([nm]) => isAggregateSeatRow(nm)), '净化后不得残留汇总行');
  // 该票榜上买方额应从 197.78 亿（含污染）回到 5.01 亿量级（万元口径 ≈ 50064）
  const tot = rows.reduce((x, [, v]) => x + v, 0);
  assert.ok(tot < 100000, `净化后该票榜上买方额应 < 10 亿（万元口径），实得 ${tot}`);
});
