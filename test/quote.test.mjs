// 测试：腾讯行情代码前缀映射（src/sources.js quoteSymbol）
//
// 背景：强势股列表的 close / 涨跌幅 / 换手 是用腾讯行情批量补全的（同花顺 getharden 2026-09-28 起
// 不再返回这些字段）。早期前缀判断只认 sh/sz，把北交所（9/8/4 段）整段丢掉 —— 榜单里一旦出现
// 北交所标的，请求批次就把它过滤掉，它的行情字段全部落空，前端只好显示成 0（武汉蓝电 920779 即此例）。
// 另外 B 股也不能误判：沪市 900xxx 属于 sh（实测 bj900939 返回 v_pv_none_match），深市 200xxx 属于 sz。
// 各段位已对 qt.gtimg.cn 实测确认。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteSymbol } from '../src/sources.js';

test('沪市A股：6 开头 → sh', () => {
  assert.equal(quoteSymbol('600519'), 'sh600519');
  assert.equal(quoteSymbol('601398'), 'sh601398');
  assert.equal(quoteSymbol('603103'), 'sh603103');
  assert.equal(quoteSymbol('688655'), 'sh688655');
});

test('沪市B股：900xxx → sh（不能判成 bj）', () => {
  assert.equal(quoteSymbol('900939'), 'sh900939'); // 汇丽B
  assert.equal(quoteSymbol('900925'), 'sh900925'); // 机电B股
});

test('深市A股：0/3 开头 → sz', () => {
  assert.equal(quoteSymbol('000001'), 'sz000001');
  assert.equal(quoteSymbol('002415'), 'sz002415');
  assert.equal(quoteSymbol('003816'), 'sz003816');
  assert.equal(quoteSymbol('300750'), 'sz300750');
  assert.equal(quoteSymbol('301716'), 'sz301716');
});

test('深市B股：200xxx → sz（不能判成 bj）', () => {
  assert.equal(quoteSymbol('200011'), 'sz200011'); // 深物业B
});

test('北交所：920xxx / 4xxxxx / 8xxxxx → bj', () => {
  assert.equal(quoteSymbol('920779'), 'bj920779'); // 武汉蓝电，本次事故原型
  assert.equal(quoteSymbol('430047'), 'bj430047'); // 诺思兰德
  assert.equal(quoteSymbol('830799'), 'bj830799'); // 艾融软件
  assert.equal(quoteSymbol('871981'), 'bj871981'); // 晶赛科技
});

test('数字型代码同样可映射（存档里 code 可能来自 JSON 数字）', () => {
  assert.equal(quoteSymbol(920779), 'bj920779');
  assert.equal(quoteSymbol(600519), 'sh600519');
});

test('非 6 位数字 / 空值 / 未知段位 → null（宁可不请求，也不构造错前缀）', () => {
  for (const bad of ['', null, undefined, '92077', '9207799', 'abcdef', 'SZ920779', '920-779']) {
    assert.equal(quoteSymbol(bad), null, `期望 null: ${String(bad)}`);
  }
  assert.equal(quoteSymbol('500001'), null, '5 开头（基金/老基金）无对应股票行情前缀');
});
