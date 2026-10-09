import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuoteLine, parseQuoteText, priceKind, inTradingSession, normalizeCodes } from '../src/quote.js';

const LINE = 'v_sz300893="51~松原安全~300893~15.13~12.61~12.76~225226~89520~135706~15.13~15335~15.12~1567~15.10~14~15.09~1~15.08~1~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~~20260930161445~2.52~19.98~15.13~12.76~15.13/225226/323471626~225226~32347~8.95~21.78~~15.13~12.76~18.79~38.08~71.71~3.37~15.13~10.09~5.22"';

test('quote: 解析腾讯行情行（真实字段布局）', () => {
  const q = parseQuoteLine(LINE);
  assert.equal(q.code, '300893');
  assert.equal(q.symbol, 'sz300893');
  assert.equal(q.price, 15.13);
  assert.equal(q.prevClose, 12.61);
  assert.equal(q.changePct, 19.98);
  assert.equal(q.turnover, 8.95);
  assert.equal(q.tickTime, '2026-09-30 16:14:45');
  assert.equal(q.tickDate, '2026-09-30');
});

test('quote: 停牌/无价一律返回 null（绝不用 0 或历史价冒充）', () => {
  assert.equal(parseQuoteLine('v_sz300893="51~停牌股~300893~0.00~12.61~0~0~0~0"'), null);
  assert.equal(parseQuoteLine('v_sz300893="51~无价股~300893~~12.61~0"'), null);
  assert.equal(parseQuoteLine('v_pv_none_match="1";'), null);
  assert.equal(parseQuoteLine(''), null);
  assert.equal(parseQuoteLine(null), null);
});

test('quote: 解析整段文本，丢弃无价行', () => {
  const txt = `v_sz300893="${LINE.split('"')[1]}"\nv_sz300006="1~莱美药业~300006~0.00~5.94~0";`;
  const out = parseQuoteText(txt);
  assert.deepEqual(Object.keys(out), ['300893']);
  assert.equal(out['300893'].price, 15.13);
});

test('quote: changePct 缺省时用昨收现算（仍是真实数据）', () => {
  const q = parseQuoteLine('v_sh600519="1~贵州茅台~600519~1100.00~1000.00~1000.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~~20260930150000~~0~0"');
  assert.equal(q.changePct, 10);
  // 源给了 0（真平盘）→ 必须用源的 0，不能因为 falsy 就重算
  const flat = parseQuoteLine('v_sh600519="1~贵州茅台~600519~1000.00~1000.00~1000.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~~20260930150000~0~0~0~0"');
  assert.equal(flat.changePct, 0);
});

test('quote: 交易时段判定', () => {
  assert.equal(inTradingSession(new Date('2026-10-01T09:20:00')), true);  // 集合竞价
  assert.equal(inTradingSession(new Date('2026-10-01T10:00:00')), true);  // 早盘
  assert.equal(inTradingSession(new Date('2026-10-01T12:00:00')), false); // 午休
  assert.equal(inTradingSession(new Date('2026-10-01T14:00:00')), true);  // 午盘
  assert.equal(inTradingSession(new Date('2026-10-01T16:00:00')), false); // 收盘后
  assert.equal(inTradingSession(new Date('2026-10-01T08:00:00')), false); // 开盘前
});

test('quote: priceKind 区分实时价与最近收盘价', () => {
  const q = parseQuoteLine(LINE);
  assert.equal(priceKind(q, new Date('2026-09-30T10:00:00')).kind, 'live');
  assert.equal(priceKind(q, new Date('2026-09-30T16:00:00')).kind, 'close');
  assert.equal(priceKind(null).kind, 'close');
  assert.equal(priceKind(q, new Date('2026-10-01T10:00:00')).kind, 'close'); // 时间戳不是今天
});

test('quote: normalizeCodes 去重过滤', () => {
  assert.deepEqual(normalizeCodes(['600519', '600519', 'abc', '', null, '000001']), ['600519', '000001']);
});
