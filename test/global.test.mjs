// 外围市场观测：解析 + 阈值判定。
// 夹具是 2026-09-30 美股收盘后从新浪抓到的**真实响应**（GBK 解码后原样保存）——
// 断言里的期望值全部来自该会话的公开收盘数据，不是回填的假数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseSinaVars, normalizeQuote, buildGlobalSnapshot, evaluateGlobalWatch, fmtPct, GLOBAL_SYMBOLS,
  QUOTE_STATE, inferQuoteState, usSessionReadiness, isUSEasternDST, etMinutesOf,
  US_READY_ET_MIN, US_CLOSE_ET_MIN, US_SETTLE_BUFFER_MIN,
} from '../src/global.js';

const RAW = readFileSync(new URL('./fixtures/sina_global_20260930.txt', import.meta.url), 'utf8');
const SNAP = buildGlobalSnapshot({ raw: RAW, generatedAt: '2026-10-01T01:30:00Z', aShareTradeDate: '2026-09-30' });
const by = Object.fromEntries(SNAP.quotes.map((q) => [q.key, q]));
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}（容差 ${tol}）`);

// ── 解析 ──
test('16 个品种在真实响应里全部解析成功（漏抓会在这里暴露）', () => {
  assert.equal(SNAP.meta.quoteCount, GLOBAL_SYMBOLS.length);
  assert.equal(SNAP.meta.okCount, GLOBAL_SYMBOLS.length);
  assert.deepEqual(SNAP.meta.failed, []);
});

test('道指：现价/昨收/涨跌幅与公开收盘数据一致，且涨跌幅是算出来的而非抄字段', () => {
  near(by.dji.last, 50906.05);
  near(by.dji.prevClose, 51349.92);          // 昨收取自 [26]，不是用现价反推
  near(by.dji.chgPct, -0.8644, 0.001);
  assert.equal(by.dji.chgPctText, '-0.86%');
  near(by.dji.chgPctReported, -0.86);        // 源字段原值一并保留，可做口径漂移比对
});

test('纳指/标普 与报道一致；纳指收红、标普微跌（分化盘）', () => {
  near(by.ixic.chgPct, 0.237, 0.01);
  near(by.spx.chgPct, -0.2516, 0.01);
  assert.equal(by.ixic.chgPctText, '+0.24%');
});

test('费半收平：实际跌 0.0043%，显示必须是 0.00% 而不是 -0.00%', () => {
  assert.ok(by.sox.chgPct < 0, '费半当日确实是微跌（-0.54 点）');
  assert.ok(Math.abs(by.sox.chgPct) < 0.01);
  assert.equal(by.sox.chgPctText, '0.00%'); // 带负号会把「收平」读成「下跌」
});

test('fmtPct 抹掉负零，但不影响真正的负数', () => {
  assert.equal(fmtPct(-0.0043), '0.00%');
  assert.equal(fmtPct(-0.0043, 3), '-0.004%');
  assert.equal(fmtPct(-1.234), '-1.23%');
  assert.equal(fmtPct(0), '0.00%');
  assert.equal(fmtPct(null), '—');
});

test('港股用另一套字段布局（[6]现价 [3]昨收），解析结果自洽', () => {
  near(by.hsi.last, 24613.27);
  near(by.hsi.prevClose, 24523.57);
  near(by.hsi.chgPct, 0.3658, 0.01);
  assert.equal(by.hsi.sessionDate, '2026-09-30');
  near(by.hstech.chgPct, 0.1, 0.02);
});

test('A50 期货解析：现价取 [0]、昨收取 [7]（长假期间唯一实时锚）', () => {
  assert.ok(by.a50.ok);
  near(by.a50.prevClose, 13963, 0.01);
  assert.equal(by.a50.role, 'a_share_proxy');
  assert.equal(by.a50.dp, 1);
});

test('商品：WTI 昨收与公开报道的 90.42 精确吻合', () => {
  near(by.wti.prevClose, 90.42, 0.001);
  near(by.gold.prevClose, 4186.7, 0.01);
});

test('小数位按品种量级下发（美元指数 3 位、人民币 4 位、指数 2 位）', () => {
  assert.equal(by.dxy.lastText.split('.')[1].length, 3);
  assert.equal(by.cnh.lastText.split('.')[1].length, 4);
  assert.equal(by.dji.lastText.split('.')[1].length, 2);
});

test('人民币反号写在字段名里：USDCNH 上涨 → rmb_up_pct 为负（贬值）', () => {
  assert.ok(by.cnh.chgPct > 0, 'USDCNH 当日是上涨的（人民币贬值）');
  near(SNAP.rmb.usdcnh_chg_pct, by.cnh.chgPct, 1e-9);
  near(SNAP.rmb.rmb_up_pct, -by.cnh.chgPct, 1e-9);
  assert.ok(SNAP.rmb.rmb_up_pct < 0);
});

test('美股会话日取自 ET 时间戳，而不是北京日期', () => {
  assert.equal(SNAP.meta.usSessionDate, '2026-09-30'); // 北京已是 10-01，美股会话仍是 09-30
});

// ── 缺失与容错 ──
test('取不到的品种是 null，绝不写成 0（0 是真实行情值，缺失是缺失）', () => {
  const raw = 'var hq_str_gb_$dji="";\nvar hq_str_gb_sox="";';
  const s = buildGlobalSnapshot({ raw });
  const q = Object.fromEntries(s.quotes.map((x) => [x.key, x]));
  assert.equal(q.dji.ok, false);
  assert.equal(q.dji.last, null);
  assert.equal(q.dji.chgPct, null);
  assert.equal(q.dji.lastText, '—');
  assert.equal(s.meta.okCount, 0);
});

test('响应被截断/少了品种也能被发现：缺席的 code 同样计入 failed', () => {
  // 用一条**真实成交过**的美股序列：open/high/low 有值且 last≠prevClose，
  //   否则会被 inferQuoteState 判成"无成交"（那是另一条测试要覆盖的路径）。
  //   字段位：[1]last [2]pct [3]时间 [4]额 [5]开 [6]高 [7]低 … [25]ET收盘 [26]昨收
  const line = '道琼斯,50900,0.10,2026-10-01 04:00:00,50,50800,50950,50770,54744,45057,0,0,0,0.00,--,0,0,0,0,0,0,0.0000,0,0.0000,,Sep 30 04:00PM EDT,50850,0,1,2026';
  const s = buildGlobalSnapshot({ raw: `var hq_str_gb_$dji="${line}";` });
  assert.equal(s.meta.okCount, 1);
  assert.equal(s.quotes.find((q) => q.key === 'dji').state, 'ok');
  assert.equal(s.meta.failed.length, GLOBAL_SYMBOLS.length - 1); // 其余全是「没拿到」，不是 0
  assert.ok(!s.meta.failed.includes('dji'));
});

test('parseSinaVars 容忍空响应与缺字段，不抛错', () => {
  assert.deepEqual(parseSinaVars('var hq_str_xx="";'), { xx: [] });
  assert.deepEqual(parseSinaVars(''), {});
  const q = normalizeQuote({ key: 'foo', code: 'x', name: 'x', kind: 'us', role: 'us_index' }, []);
  assert.equal(q.ok, false);
  assert.equal(q.last, null);
});

// ── 阈值判定 ──
//   ⚠ 2026-10-01 事故后语义收紧：**未提供的品种 = 数据缺失**，会输出
//     「数据缺失 — 未参与判定」并计 0 权重；主锚缺失还会把整体结论降级为「判据不足」。
//   故测试里"只想测某条"时必须：① 用 ALL_OK 把其余品种喂成"有成交的平盘"，
//   ② 断言时按 key 取信号，而不是按下标 —— 下标会随缺失哨兵插入而错位。
const ALL_KEYS = ['a50', 'dji', 'spx', 'ixic', 'ndx', 'sox', 'hxc', 'fxi',
  'hsi', 'hstech', 'dxy', 'gold', 'wti', 'brent'];
/**
 * 构造一个"全部品种都有数据"的 quotes 数组。
 * @param over   要覆盖的 { key: chgPct }；其余品种默认 **有成交的平盘（0%）**
 * @param rmb    人民币字段
 * @param missing 显式声明为"数据缺失"的 key 列表（用于测缺失路径）
 */
const watchOf = (over = {}, rmb = {}, missing = []) => evaluateGlobalWatch({
  quotes: ALL_KEYS.map((k) => {
    const isMissing = missing.includes(k);
    if (isMissing) return { key: k, ok: false, state: 'missing', chgPct: null };
    const v = over[k] != null ? over[k] : 0;
    return { key: k, ok: true, state: 'ok', chgPct: v };
  }),
  rmb,
  meta: { aShareHoliday: true },
});
/** 取某 key 的信号（找不到返回 undefined） */
const sigOf = (w, key) => w.signals.find((s) => s.key === key);

test('费半跌超 2% → 电子链承压（warn）且整体判偏空', () => {
  const w = watchOf({ sox: -3 });
  assert.equal(sigOf(w, 'sox').level, 'warn');
  assert.match(sigOf(w, 'sox').text, /电子链/);
  assert.equal(w.verdict.key, 'negative');
  // 只统计**有方向**的信号权重（缺失哨兵恒 0 权重）
  assert.equal(w.bias, -2);
});

test('费半微跌 0.5% → 落在阈值内，只报「无明确方向」；0.004% 的抖动不应带方向', () => {
  const w = watchOf({ sox: -0.5 });
  assert.equal(sigOf(w, 'sox').level, 'info');
  assert.equal(w.bias, -0.5);
  assert.equal(w.verdict.key, 'neutral');
  const flat = watchOf({ sox: -0.0043 });
  assert.equal(sigOf(flat, 'sox').level, 'info');
  assert.equal(flat.bias, 0); // 死区：0.05% 以内视为没动
  assert.equal(flat.verdict.key, 'neutral');
});

test('费半涨超 1.5% → 支撑（ok）', () => {
  const w = watchOf({ sox: 2 });
  assert.equal(sigOf(w, 'sox').level, 'ok');
  assert.equal(w.bias, 2);
  assert.equal(w.verdict.key, 'positive');
});

test('A50 期货权重最高：-1.5% 单独就能把研判打到偏空', () => {
  const w = watchOf({ a50: -1.5 });
  assert.equal(sigOf(w, 'a50').level, 'warn');
  assert.equal(w.bias, -3);
  assert.equal(w.verdict.key, 'negative');
});

test('美元指数走强与人民币贬值各算一条，且方向都是偏空', () => {
  const w = watchOf({ dxy: 1.0 }, { rmb_up_pct: -0.8 });
  const keys = w.signals.map((s) => s.key);
  assert.ok(keys.includes('dxy') && keys.includes('cnh'));
  assert.equal(sigOf(w, 'dxy').level, 'warn');
  assert.equal(sigOf(w, 'cnh').level, 'warn');
  assert.equal(w.bias, -3);
});

test('人民币升值 0.8% → 支撑；黄金大涨只算避险（偏空但弱）', () => {
  assert.equal(sigOf(watchOf({}, { rmb_up_pct: 0.8 }), 'cnh').level, 'ok');
  const g = watchOf({ gold: 2.5 });
  assert.equal(sigOf(g, 'gold').level, 'warn');
  assert.equal(g.bias, -1);
});

test('中国金龙暴跌 3% → 外资 risk-off（-2），涨超 2% 则 +2', () => {
  assert.equal(watchOf({ hxc: -3.5 }).bias, -2);
  assert.equal(watchOf({ hxc: -3.5 }).verdict.key, 'negative');
  assert.equal(watchOf({ hxc: 2.5 }).bias, 2);
  assert.equal(watchOf({ hxc: 2.5 }).verdict.key, 'positive');
});

test('权重加总与 verdict 门槛自洽：|bias| ≥ 2 才给方向', () => {
  const w = watchOf({ sox: -2.0, a50: -0.5 });          // -2 + (-0.5) = -2.5
  assert.equal(w.bias, -2.5);
  assert.equal(w.verdict.key, 'negative');
  const n = watchOf({ a50: -0.5, sox: 0.5 });           // 两条 info，符号相抵 → 0
  assert.equal(n.bias, 0);
  assert.equal(n.verdict.key, 'neutral');
  // ★ 主锚缺失 → 无论次锚怎么动，整体结论必须是「判据不足」而非"中性"
  const miss = watchOf({ ixic: 1.8 }, {}, ['a50']);
  assert.equal(miss.mainMissing.includes('a50'), true);
  assert.equal(miss.verdict.key, 'insufficient', '主锚缺失不得冒充"中性"');
  assert.match(miss.verdict.label, /判据不足/);
});

test('主锚必报、次锚触发才报：纳指在阈值内不报，费半在阈值内必定出现', () => {
  const keys = (m, rmb) => watchOf(m, rmb).signals.map((s) => s.key);
  assert.ok(!keys({ ixic: 0.3 }).includes('ixic'), '纳指是次锚，未触发就静默');
  assert.ok(keys({ sox: 0.3 }).includes('sox'), '费半是主锚，未触发也要给出读数');
  assert.ok(keys({ a50: 0.3 }).includes('a50'), 'A50 是主锚');
  assert.ok(keys({ hxc: 0.3 }).includes('hxc'), '中国金龙是主锚');
});


// ═══════════════════════════════════════════════════════════════════════════
// 2026-10-01 外围三层故障的回归锁（永久守卫）
//
// 事故全景（用户实盘发现）：
//   ① 道指显示 7651.04「错得离谱」——但**不是字段错位**：7651 其实是标普500 的价，
//      道指 50906 也是对的。真正的错是这两个数被当成了"涨跌幅 0%"的载体，
//      而 0% 来自数据源在**盘前**回填的占位平盘（last==prevClose、open/high/low=0）。
//   ② 抓取时机错：北京 21:10 = 美东 09:10，美股 09:30 才开盘 → 抓了个盘前。
//   ③ 阈值逻辑把"缺失"当"真值"：0% 落在所有阈值中间 → 判「无明确方向」→
//      用户读成"外围没动"，实际是"我们不知道"。
//
// 下面三条分别锁住这三层，任何一层回退都会立刻变红。
// ═══════════════════════════════════════════════════════════════════════════

// ── 第一层：行情状态（未成交绝不产生 0%）──────────────────────────────────
test('★ 回归①：美股盘前占位（last==prevClose、open/high/low=0）→ chgPct 必须 null，不是 0', () => {
  // 这是事故当刻的**真实原始串**（道指那一行，原样保留）
  const line = '道琼斯,50906.0508,0.00,2026-10-01 21:10:02,0.0000,0,0,0,54744.3281,45057.2812,0,0,0,0.00,--,0.00,0.00,0.00,0.00,0,0,0.0000,0.00,0.0000,,Sep 30 05:10PM EDT,50906.0508,0,1,2026';
  const q = normalizeQuote(
    { key: 'dji', code: 'gb_$dji', name: '道琼斯', kind: 'us', role: 'us_index' },
    line.split(','),
  );
  assert.equal(q.state, QUOTE_STATE.PREOPEN, '全 0 的 open/high/low 必须判为盘前');
  assert.equal(q.chgPct, null, '★ 绝不写 0 —— 0 会被读成"没波动"，而真相是"不知道"');
  assert.equal(q.chg, null);
  assert.equal(q.ok, false, 'ok=false 才能让它从"有方向"的统计里退出');
  assert.equal(q.chgPctText, '盘前无数据');
  // 价格本身是真值，要保留供人工核对（否则用户会以为整个品种都没抓到）
  assert.equal(q.lastText, '50906.05');
  assert.equal(q.prevClose, 50906.0508);
});

test('★ 回归①：数据源自报的 0.00% 也不得采信（它同样会把缺失伪装成收平）', () => {
  const line = '标普500指数,7651.54,0.00,2026-10-01 21:10:02,0.0000,0,0,0,7816.7,6316.91,0,0,0,0.00,--,0,0,0,0,0,0,0.0000,0,0.0000,,Sep 30 05:10PM EDT,7651.54,0,1,2026';
  const q = normalizeQuote({ key: 'spx', code: 'gb_$inx', name: '标普500', kind: 'us', role: 'us_index' }, line.split(','));
  assert.equal(q.state, QUOTE_STATE.PREOPEN);
  assert.equal(q.chgPct, null);
  assert.equal(q.chgPctReported, 0, '原值仍留着供比对，但**不采信**为涨跌幅');
});

test('★ 回归①：真收平（有振幅、last==prevClose）仍算 ok，不被误杀', () => {
  // 真收平与盘前占位的区别在 open/high/low：前者有值且振幅>0
  const line = '费交所半导体股指数,12628.6238,0.00,2026-10-01 04:00:00,0.0000,12651.56,12913.40,12587.34,14655.29,6160.04,0,0,0,0.00,--,0,0,0,0,0,0,0.0000,0,0.0000,,Sep 30 04:00PM EDT,12628.6238,0,1,2026';
  const q = normalizeQuote({ key: 'sox', code: 'gb_sox', name: '费半', kind: 'us', role: 'us_sector' }, line.split(','));
  assert.equal(q.state, QUOTE_STATE.OK, '有振幅的真收平不能被误判成盘前');
  assert.equal(q.chgPct, 0);
});

test('★ 回归①：连续交易品种（期货/汇率/商品）不适用 preopen 判定', () => {
  // A50 是 24h 连续交易；数据源没给 open/high/low 不等于没开盘
  const q = inferQuoteState({ last: 13898.28, prevClose: 13861, open: 0, high: 0, low: 0, chgReported: 37.28 }, 'hf');
  assert.equal(q, QUOTE_STATE.OK, 'hf/fx 类不得套用美股会话判定');
});

// ── 第二层：抓取时机（美股收盘档）────────────────────────────────────────
test('★ 回归②：事故时刻（美东 09:12）判为未就绪，并指出"09:30 才开盘"', () => {
  const r = usSessionReadiness(new Date('2026-10-01T13:12:15Z'));
  assert.equal(r.ready, false);
  assert.match(r.reason, /盘前/);
  assert.match(r.reason, /09:30/);
});

test('★ 回归②：美东 16:30 起才就绪（收盘 16:00 + 30 分钟结算缓冲）', () => {
  assert.equal(US_CLOSE_ET_MIN, 16 * 60);
  assert.equal(US_SETTLE_BUFFER_MIN, 30);
  assert.equal(US_READY_ET_MIN, 16 * 60 + 30);
  // 16:10 ET（北京次日 04:10）→ 缓冲内，未就绪
  assert.equal(usSessionReadiness(new Date('2026-10-01T20:10:00Z')).ready, false);
  // 16:30 ET（北京次日 04:30）→ 就绪
  assert.equal(usSessionReadiness(new Date('2026-10-01T20:30:00Z')).ready, true);
});

test('★ 回归②：盘中（14:00 ET）也未就绪 —— 盘中价不是收盘价', () => {
  const r = usSessionReadiness(new Date('2026-10-01T18:00:00Z'));
  assert.equal(r.ready, false);
  assert.match(r.reason, /盘中/);
});

test('★ 回归②：冬令时（EST）自动顺延一小时，不能写死 UTC 偏移', () => {
  // 12-15 北京 04:00 = 美东 15:00（EST，UTC-5）→ 盘中
  assert.equal(usSessionReadiness(new Date('2026-12-15T20:00:00Z')).ready, false);
  // 12-15 北京 05:30 = 美东 16:30（EST）→ 就绪
  assert.equal(usSessionReadiness(new Date('2026-12-15T21:30:00Z')).ready, true);
});

test('★ 回归②：DST 判定覆盖 3 月第 2 周日 / 11 月第 1 周日边界', () => {
  assert.equal(isUSEasternDST(new Date('2026-07-01T12:00:00Z')), true, '7 月应是 EDT');
  assert.equal(isUSEasternDST(new Date('2026-12-15T12:00:00Z')), false, '12 月应是 EST');
  assert.equal(isUSEasternDST(new Date('2026-01-15T12:00:00Z')), false, '1 月应是 EST');
  // 2026-03-08 是 3 月第 2 个周日；08:00Z 已过 07:00Z 切换点 → EDT
  assert.equal(isUSEasternDST(new Date('2026-03-08T08:00:00Z')), true);
  assert.equal(isUSEasternDST(new Date('2026-03-08T06:00:00Z')), false, '切换前仍是 EST');
});

test('★ 回归②：快照 meta 必须留痕美股就绪状态（可核验、可审计）', () => {
  const bad = 'var hq_str_gb_$dji="道琼斯,50906.0508,0.00,2026-10-01 21:10:02,0.0000,0,0,0,54744.3281,45057.2812,0,0,0,0.00,--,0.00,0.00,0.00,0.00,0,0,0.0000,0.00,0.0000,,Sep 30 05:10PM EDT,50906.0508,0,1,2026";';
  const s = buildGlobalSnapshot({ raw: bad, generatedAt: '2026-10-01T13:12:15Z' });
  assert.equal(s.meta.usReadiness.ready, false);
  assert.match(s.meta.usReadiness.reason, /盘前/);
  assert.match(s.meta.usReadiness.readyAfterEt, /16:30/);
  assert.ok(s.meta.usNoSession.includes('dji'), '无成交的美股品种要单独列出来');
  assert.ok(!s.meta.failed.includes('dji'), 'dji 拿到了（有价），只是无成交 —— 与 failed 语义不同');
});

// ── 第三层：阈值逻辑（缺失 → 未参与判定，且主锚缺失降级整体结论）────────
test('★ 回归③：事故快照的结论必须是「判据不足」，不能是「外围中性」', () => {
  const bad = 'var hq_str_gb_$dji="道琼斯,50906.0508,0.00,2026-10-01 21:10:02,0.0000,0,0,0,54744.3281,45057.2812,0,0,0,0.00,--,0.00,0.00,0.00,0.00,0,0,0.0000,0.00,0.0000,,Sep 30 05:10PM EDT,50906.0508,0,1,2026";';
  const s = buildGlobalSnapshot({ raw: bad, generatedAt: '2026-10-01T13:12:15Z' });
  assert.equal(s.watch.verdict.key, 'insufficient', '修复前这里是 neutral —— 把"不知道"说成了"中性"');
  assert.equal(s.watch.bias, 0, '缺失品种不得贡献任何方向权重');
  assert.ok(s.watch.mainMissing.length > 0, '主锚缺失必须被识别出来');
  assert.match(s.watch.missingNote, /未参与判定/);
  assert.match(s.watch.verdict.hint, /无法判定|没看到/, '措辞要说清是"没看到"而非"没动静"');
});

test('★ 回归③：缺失品种输出「数据缺失 — 未参与判定」，绝不沿用「无明确方向」', () => {
  const w = watchOf({}, {}, ['sox']);
  const sox = sigOf(w, 'sox');
  assert.equal(sox.level, 'unknown');
  assert.equal(sox.missing, true);
  assert.match(sox.text, /数据缺失/);
  assert.match(sox.text, /未参与判定/);
  assert.ok(!/无明确方向/.test(sox.text), '"空数据"与"数据说没方向"是两回事，文案不得混用');
});

test('★ 回归③：主锚缺失 → 整体降级；次锚缺失不降级（避免过度保守）', () => {
  assert.equal(watchOf({}, {}, ['sox']).verdict.key, 'insufficient', '费半是主锚，缺了要降级');
  assert.equal(watchOf({}, {}, ['ixic']).verdict.key, 'neutral', '纳指是次锚，缺了不降级');
});

test('★ 回归③：missing 清单与 missingNote 都要产出（前端与守卫都能看见）', () => {
  const w = watchOf({}, {}, ['sox', 'dxy']);
  assert.deepEqual(w.missing.sort(), ['dxy', 'sox']);
  assert.match(w.missingNote, /数据缺失/);
  assert.match(w.missingNote, /缺失 ≠ 中性|缺失不等于/, '必须显式说清缺失不代表中性');
});

test('★ 回归③：全部有数据时 missing 为空、missingNote 为空串（不留噪声）', () => {
  const w = watchOf({ a50: 0.3, sox: 0.2, hxc: 0.1 });
  assert.deepEqual(w.missing, []);
  assert.deepEqual(w.mainMissing, []);
  assert.equal(w.missingNote, '');
});

test('★ 回归③：0% 是合法行情值（真收平），must 仍算"有数据"', () => {
  // 关键区分：0 是"真的没动"，null 是"不知道"。不能为了防缺失把真 0 也一起清掉。
  const w = watchOf({ sox: 0, a50: 0, hxc: 0 });
  assert.deepEqual(w.missing, [], '0% 的品种不算缺失');
  assert.equal(sigOf(w, 'sox').level, 'info');
  assert.equal(sigOf(w, 'sox').missing, undefined);
});
