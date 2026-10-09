// 数据导出（CSV / Excel）单测
//
// 本文件要守住的三件事（按重要性排序）：
//   ① 缺失**绝不**变成 0 —— 空单元格 vs 0 是"没数据"与"值就是 0"的区别，
//      导出的表格脱离了页面，读者没有任何别的线索可以分辨。
//   ② 导出的数字与屏幕**同源** —— 用同一天的数据，逐字段比对。
//   ③ CSV/XML 转义正确 —— 题材名里有全角引号、逗号，不转义会破列。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CELL, has, cellText, csvField, buildCsv, buildSpreadsheetXml, sheetName,
  datasetFileName, datasetById, DATASETS, buildDataset, exportAsCsv,
  exportAsExcel, exportManifest, datasetMeta,
} from '../src/dataset.js';

// ── 夹具：一份最小的、形态与真实档一致的 archive + signals ────────────────────
function fixture() {
  const archive = {
    meta: { tradeDate: '2026-09-30', generatedAt: '2026-09-30T13:13:24.127Z', formulaVersion: 'v5.2-pro' },
    all_days: [
      {
        trade_date: '2026-09-29',
        emotion: { value: 58.2, pct_rank: 41, s_net: 0.3, missing: ['s_brd'] },
        summary: { zt_count: 30, up_count: 1000 },
      },
      {
        trade_date: '2026-09-30',
        emotion: {
          value: 64.4, pct_rank: 55, s_net: 0.42, s_pos: 0.6, s_brd: null,
          missing: ['s_brd', 's_amt'], imputedRatio: 0.28,
        },
        summary: {
          zt_count: 44, dt_count: 3, zb_count: 12, seal_pct: 80.5,
          up_count: 1313, down_count: 1894, amount_yi: 9876.5,
          lhb_daily_net: 136.5, ind_count: 90, main_theme: 'AI算力',
        },
        hot: [
          { code: '600519', name: '贵州茅台', change_pct: 2.11, close: 1680.5, huanshou: 0.42, reason: '白酒+业绩' },
          { code: '002694', name: '*ST顾地', change_pct: 9.96, close: 2.76, huanshou: 1.72, reason: '塑料管道,智慧管网' },
        ],
        themes: { 'AI算力': 3, '白酒, 名酒': 1 },
        industry: [{ name: '生物制品', change_pct: 4.63 }, { name: '元件', change_pct: -4.03 }],
        lhb_aggr: [
          { code: '001246', name: '力勤资源', close: 65.09, change_pct: 206.59, net_buy_wan: 50412.7,
            buy_wan: 74589.1, sell_wan: 24176.4, deal_wan: 98765.4, turnover_pct: 74.93,
            caliber: 'daily', reason: '无价格涨跌幅限制的证券' },
        ],
      },
    ],
  };
  const signals = {
    meta: { tradeDate: '2026-09-30', generatedAt: '2026-09-30T13:13:24.127Z' },
    breadth: { series: [{ date: '2026-09-30', scanned: 3292, maRatio: 0.3007, newHighRatio: 0.009, newLowRatio: 0.0134, brokenRatio: null, up: 1313, down: 1894, verdict: 'narrow' }] },
    seats: { series: [{ date: '2026-09-28', instNet: 6.18, northNet: 9.4, hotNet: 14.53 }] },
    crosscheck: { flagged: [{ date: '2026-09-30', name: '生物制品', primaryPct: 4.63, secondaryPct: 3.35, devPp: 1.28, kind: 'diverge', reason: '偏离 1.28pp' }] },
    dirty: { recent: [{ date: '2026-08-18', status: 'warn', issues: [{ field: 'industry[].change_pct', rule: 'OUTLIER_INDUSTRY', severity: 'warn', reason: '数值孤立' }] }] },
  };
  const global = { quotes: [{ key: 'a50', name: '富时中国A50期货', code: 'hf_CHA50CFD', role: 'a_share_proxy', last: 13898.28, prevClose: 13861, chg: 37.28, chgPct: 0.269, sessionDate: '2026-10-01', quoteTime: '21:12:08', note: '新加坡' }] };
  return { archive, signals, global };
}

// ════════════════════════════════════════════════════════════════════════════
// ① 缺失 ≠ 0（本文件最重要的一组）
// ════════════════════════════════════════════════════════════════════════════
test('has: 拒绝 null/undefined/空串/空数组/NaN，接受 0 与 false', () => {
  for (const v of [null, undefined, '', NaN, []]) assert.equal(has(v), false, `应拒绝 ${JSON.stringify(v)}`);
  assert.equal(has(0), true, '0 是有意义的值，必须保留');
  assert.equal(has(false), true, 'false 是有意义的值');
  assert.equal(has(-1.5), true);
  assert.equal(has('0'), true);
});

test('★ num 陷阱：+[] / +{} / +null 经 cellText 后不得变成 0', () => {
  // 若实现写成 Number(v) || 0 或 String(+v)，下面四个会全部变成 "0"
  assert.equal(cellText([], CELL.NUM), '', '+[] 必须为空，不是 0');
  assert.equal(cellText({}, CELL.NUM), '', '+{} 必须为空（NaN）');
  assert.equal(cellText(null, CELL.NUM), '', '+null 必须为空');
  assert.equal(cellText('', CELL.NUM), '', '+"" 必须为空');
  assert.equal(cellText(undefined, CELL.NUM), '');
});

test('cellText: 0 保留为 "0"（不是空）', () => {
  assert.equal(cellText(0, CELL.NUM), '0');
  assert.equal(cellText(-0, CELL.NUM), '0');
});

test('cellText: 布尔导出「是/否」，不导出 true/false', () => {
  assert.equal(cellText(true), '是');
  assert.equal(cellText(false), '否');
  assert.equal(cellText(null), '');
});

test('★ 情绪分·逐日：s_brd 为 null 的那天导出空单元格，不写 0', () => {
  const { archive, signals } = fixture();
  const ds = buildDataset('daily', { archive, signals });
  const last = ds.rows.find((r) => r.trade_date === '2026-09-30');
  assert.equal(last.s_brd, null);
  const csv = buildCsv(ds.columns, ds.rows, { meta: {} });
  const cols = ds.columns.map((c) => c.label);
  const iSbrd = cols.indexOf('s_brd 广度');
  const line = csv.split('\r\n').find((l) => l.startsWith('2026-09-30'));
  const cells = line.split(',');
  assert.equal(cells[iSbrd], '', 's_brd 缺失应导出空单元格');
  assert.notEqual(cells[iSbrd], '0');
});

// ════════════════════════════════════════════════════════════════════════════
// ② 与屏幕同源
// ════════════════════════════════════════════════════════════════════════════
test('daily: 行数 = all_days 长度，且逐字段取自同一份档', () => {
  const { archive, signals } = fixture();
  const ds = buildDataset('daily', { archive, signals });
  assert.equal(ds.count, archive.all_days.length);
  const last = ds.rows[ds.rows.length - 1];
  assert.equal(last.value, archive.all_days[1].emotion.value);
  assert.equal(last.zt_count, archive.all_days[1].summary.zt_count);
  assert.equal(last.main_theme, 'AI算力');
  // missing 数组长度导出成 missing_count（导出一个数组没法在 Excel 里筛选）
  assert.equal(last.missing_count, 2);
});

test('daily: 回填日必须被 isBackfill 列标记（否则按情绪分排会把占位值排到前面）', () => {
  const { archive, signals } = fixture();
  archive.all_days[0].emotion._backfill = true;
  const ds = buildDataset('daily', { archive, signals });
  assert.equal(ds.rows[0].isBackfill, true);
  assert.equal(ds.rows[1].isBackfill, false);
  const csv = buildCsv(ds.columns, ds.rows, { meta: {} });
  assert.ok(csv.includes('回填日'), '列头必须在');
});

test('hot / industry / themes / lhb: 取最新一天，且带 trade_date 列', () => {
  const { archive, signals } = fixture();
  for (const id of ['hot', 'industry', 'themes', 'lhb']) {
    const ds = buildDataset(id, { archive, signals });
    assert.ok(ds.count > 0, `${id} 应有行`);
    assert.ok(ds.rows.every((r) => r.trade_date === '2026-09-30'), `${id} 每行都应带正确交易日`);
  }
  assert.equal(buildDataset('hot', { archive, signals }).count, 2);
  assert.equal(buildDataset('industry', { archive, signals }).count, 2);
  assert.equal(buildDataset('themes', { archive, signals }).count, 2);
  assert.equal(buildDataset('lhb', { archive, signals }).count, 1);
});

test('lhb: 缺 lhb_aggr 时回退原始 lhb（与前端同款回退，不是静默空表）', () => {
  const { archive, signals } = fixture();
  const d = archive.all_days[1];
  d.lhb = d.lhb_aggr;
  delete d.lhb_aggr;
  const ds = buildDataset('lhb', { archive, signals });
  assert.equal(ds.count, 1, '应回退到 day.lhb 而不是空');
});

test('breadth / seats / crosscheck / dirty / global: 取自 signals / global', () => {
  const { archive, signals, global } = fixture();
  assert.equal(buildDataset('breadth', { archive, signals }).count, 1);
  assert.equal(buildDataset('seats', { archive, signals }).count, 1);
  assert.equal(buildDataset('crosscheck', { archive, signals }).count, 1);
  assert.equal(buildDataset('global', { archive, signals, global }).count, 1);
  // dirty 把 issues 数组摊平成行（一天多问题 → 多行），否则导出件里看不到具体原因
  assert.equal(buildDataset('dirty', { archive, signals }).count, 1);
  const dirtyRow = buildDataset('dirty', { archive, signals }).rows[0];
  assert.equal(dirtyRow.field, 'industry[].change_pct');
  assert.equal(dirtyRow.status, 'warn');
});

test('★ 缺段时返回空表而非抛错（"导出一整份但有一块暂时没有"不该变成"什么都导不出"）', () => {
  for (const id of DATASETS.map((d) => d.id)) {
    const ds = buildDataset(id, { archive: null, signals: null, global: null });
    assert.ok(ds, `${id} 应返回对象`);
    assert.equal(ds.empty, true, `${id} 应为空表`);
    assert.equal(ds.count, 0);
  }
});

test('buildDataset: 未知 id 返回 null（调用方据此报"未知数据集"）', () => {
  assert.equal(buildDataset('nope', {}), null);
  assert.equal(datasetById('nope'), null);
});

test('buildDataset: 行内字段抛错不炸整表（如 signals 段是字符串）', () => {
  const ds = buildDataset('breadth', { archive: null, signals: { breadth: 'not-an-object' } });
  assert.ok(ds);
  assert.equal(ds.empty, true);
});

// ════════════════════════════════════════════════════════════════════════════
// ③ CSV 序列化
// ════════════════════════════════════════════════════════════════════════════
test('csvField: 含逗号/引号/换行/首尾空白 时加引号，内部引号双写', () => {
  assert.equal(csvField('abc'), 'abc');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('a"b'), '"a""b"');
  assert.equal(csvField('a\nb'), '"a\nb"');
  assert.equal(csvField(' a'), '" a"');
  assert.equal(csvField('a '), '"a "');
  assert.equal(csvField(null), '');
});

test('buildCsv: 用 CRLF 行尾（Excel 对 LF-only 的兼容性不稳）', () => {
  const csv = buildCsv([{ key: 'a', label: 'A' }], [{ a: 1 }, { a: 2 }], { meta: {} });
  assert.ok(csv.includes('\r\n'));
  assert.equal(csv.split('\r\n').filter(Boolean).length, 3); // 表头 + 2 行
});

test('buildCsv: 默认带 UTF-8 BOM（无 BOM 的 CSV 在 Excel 里中文必乱码）', () => {
  const csv = buildCsv([{ key: 'a', label: 'A' }], [{ a: 1 }], { meta: {} });
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const noBom = buildCsv([{ key: 'a', label: 'A' }], [{ a: 1 }], { meta: {}, bom: false });
  assert.notEqual(noBom.charCodeAt(0), 0xfeff);
});

test('buildCsv: 元信息写进 # 注释行，且缺值不写空注释', () => {
  const csv = buildCsv([{ key: 'a', label: 'A' }], [{ a: 1 }], {
    meta: { 数据日期: '2026-09-30', 公式版本: '', 空白项: null },
  });
  const head = csv.slice(1).split('\r\n');
  assert.ok(head[0].startsWith('# 数据日期：2026-09-30'));
  assert.ok(!csv.includes('公式版本'), '空值不应产生注释行');
  assert.ok(!csv.includes('空白项'));
});

test('★ 题材名里的逗号不破列（真实数据里就有「白酒, 名酒」这种）', () => {
  const { archive, signals } = fixture();
  const ds = buildDataset('themes', { archive, signals });
  const csv = buildCsv(ds.columns, ds.rows, { meta: {} });
  const dataLines = csv.replace(/^\uFEFF/, '').split('\r\n').filter((l) => l.startsWith('2026-'));
  assert.equal(dataLines.length, 2);
  // 逐行按 RFC4180 解析回来，必须恰好 3 列（交易日/题材/个股数）
  for (const l of dataLines) {
    const cells = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).filter((x, i, a) => i < a.length - 0);
    const parsed = [];
    let cur = '', inQ = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (inQ) {
        if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { parsed.push(cur); cur = ''; }
      else cur += c;
    }
    parsed.push(cur);
    assert.equal(parsed.length, 3, `列数应为 3，实际 ${parsed.length}（${l}）`);
  }
  assert.ok(csv.includes('"白酒, 名酒"'), '含逗号的题材名应被引号包裹');
});

test('datasetMeta: 缺失语义必须写明（导出件脱离页面后唯一的线索）', () => {
  const { archive, signals } = fixture();
  const m = datasetMeta({ archive, signals });
  assert.equal(m.数据日期, '2026-09-30');
  assert.ok(/空单元格/.test(m.缺失语义) && /不等于 0/.test(m.缺失语义));
});

test('datasetFileName: 冒号/空格等非法字符被剔除（Windows 下载会失败）', () => {
  const n = datasetFileName('daily', 'csv', '2026-09-30 13:13:24');
  assert.equal(n, 'daily-2026-09-30131324.csv');
  assert.ok(datasetFileName('x', 'csv', null).endsWith('-unknown.csv'));
});

test('exportAsCsv: 返回 text / mime / fileName，且 text 与 buildCsv 同源', () => {
  const { archive, signals } = fixture();
  const out = exportAsCsv('daily', { archive, signals });
  assert.equal(out.ext, 'csv');
  assert.equal(out.mime, 'text/csv');
  assert.ok(out.fileName.startsWith('sentiment-daily-2026-09-30'));
  assert.ok(out.text.startsWith('\uFEFF# '));
  assert.ok(out.text.includes('交易日'));
});

// ════════════════════════════════════════════════════════════════════════════
// ④ Excel（SpreadsheetML 2003）
// ════════════════════════════════════════════════════════════════════════════
test('sheetName: 剔非法字符并截到 31 字符（超长/非法都会让 Excel 打不开）', () => {
  assert.equal(sheetName('a/b\\c:d?e*f[g]h'), 'a_b_c_d_e_f_g_h');
  assert.equal(sheetName('x'.repeat(50)).length, 31);
  assert.equal(sheetName(''), 'Sheet1');
});

test('buildSpreadsheetXml: 结构完整（声明 + Workbook + Worksheet + Table + 行）', () => {
  const xml = buildSpreadsheetXml([{ name: 'A', columns: [{ key: 'a', label: 'A' }], rows: [{ a: 1 }] }]);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<Workbook'));
  assert.ok(xml.includes('<Worksheet ss:Name="A">'));
  assert.ok(xml.includes('</Workbook>'));
  // 行数：表头 1 + 数据 1
  assert.equal((xml.match(/<Row/g) || []).length, 2);
});

test('buildSpreadsheetXml: 数值列用 Number 类型，文本列用 String + Excel 的 @ 格式', () => {
  const xml = buildSpreadsheetXml([{
    name: 'A',
    columns: [{ key: 'n', label: '数', type: CELL.NUM }, { key: 's', label: '文' }],
    rows: [{ n: 12.5, s: '001246' }],
  }]);
  assert.ok(xml.includes('<Data ss:Type="Number">12.5</Data>'));
  assert.ok(xml.includes('<Data ss:Type="String">001246</Data>'));
  assert.ok(xml.includes('ss:StyleID="txt"'), '文本列需带 @ 格式，否则 001246 会被吃掉前导零');
});

test('★ 缺失单元格在 XML 里是自闭合 <Cell/>，不是 <Cell><Data>0</Data></Cell>', () => {
  const xml = buildSpreadsheetXml([{
    name: 'A',
    columns: [{ key: 'n', label: '数', type: CELL.NUM }],
    rows: [{ n: null }, { n: 0 }],
  }]);
  // 第一行应为空单元
  const rows = xml.split('<Row>').slice(1);
  assert.ok(rows[0].includes('<Cell/>'), 'null 应为空单元');
  assert.ok(!rows[0].includes('>0<'), 'null 绝不能被写成 0');
  assert.ok(rows[1].includes('>0</Data>'), '真实的 0 必须保留');
});

test('★ XML 转义 + 控制字符剔除（不剔会让整份文件打不开）', () => {
  const xml = buildSpreadsheetXml([{
    name: 'A&B<C>',
    columns: [{ key: 's', label: '标<签>' }],
    rows: [{ s: '<&>"\'' }, { s: 'ctrl\u0007char' }],
  }]);
  assert.ok(xml.includes('A&amp;B&lt;C&gt;'));
  assert.ok(xml.includes('标&lt;签&gt;'));
  assert.ok(xml.includes('&lt;&amp;&gt;&quot;&apos;'));
  assert.ok(!xml.includes('\u0007'), 'XML 1.0 不允许的控制字符必须剔除');
});

test('exportAsExcel: 多数据集 → 多 Worksheet；单数据集 → 文件名用其 fileBase', () => {
  const { archive, signals, global } = fixture();
  const multi = exportAsExcel(['daily', 'hot', 'breadth'], { archive, signals, global });
  assert.equal((multi.text.match(/<Worksheet /g) || []).length, 3);
  assert.ok(multi.fileName.startsWith('sentiment-all-'));
  const one = exportAsExcel('hot', { archive, signals, global });
  assert.equal((one.text.match(/<Worksheet /g) || []).length, 1);
  assert.ok(one.fileName.startsWith('stock-detail-'));
});

test('exportAsExcel: 未知 id 全被过滤时返回 null（调用方报"无数据可导出"）', () => {
  assert.equal(exportAsExcel(['nope'], {}), null);
  assert.equal(exportAsExcel([], {}), null);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑤ 目录与清单
// ════════════════════════════════════════════════════════════════════════════
test('DATASETS: 冻结、id 唯一、每项都有必需的元数据', () => {
  assert.ok(Object.isFrozen(DATASETS));
  const ids = DATASETS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一');
  for (const d of DATASETS) {
    assert.ok(d.id && d.label && d.fileBase && Array.isArray(d.columns) && d.columns.length);
    assert.ok(typeof d.rows === 'function');
    // 每列必须有 key 与 label（label 就是 CSV 表头）
    for (const c of d.columns) assert.ok(c.key && c.label, `${d.id} 的列缺 key/label`);
  }
});

test('datasetMeta/exportManifest: 清单含全部数据集与行数，空表被标记', () => {
  const { archive, signals } = fixture();
  const m = exportManifest({ archive, signals });
  assert.equal(m.length, DATASETS.length);
  const daily = m.find((x) => x.id === 'daily');
  assert.equal(daily.count, 2);
  assert.equal(daily.empty, false);
  const empty = exportManifest({ archive: null, signals: null });
  assert.ok(empty.every((x) => x.empty));
});

test('每个数据集都能生成非空 CSV 且列数与 columns 一致', () => {
  const { archive, signals, global } = fixture();
  for (const d of DATASETS) {
    const ds = buildDataset(d.id, { archive, signals, global });
    const csv = buildCsv(ds.columns, ds.rows, { meta: {} });
    const head = csv.replace(/^\uFEFF/, '').split('\r\n')[0];
    assert.equal(head.split(',').length, d.columns.length, `${d.id} 表头列数不符`);
  }
});
