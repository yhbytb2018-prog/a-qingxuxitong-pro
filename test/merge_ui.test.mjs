// 合并方案守卫（merge/pro-into-ui · 2026-10-02）：端到端集成测——真 archive 跑合并构建，
// 从产物 HTML 抽出页面 JSON，按「UI 消费字段总表」逐项断言存在。
//
// 这是合并方案 §4 点名的最大风险缓解：「schema 映射漏字段 → UI 白屏」。
// UI（ui/template.html + ui/src/lab-*.js）读的每一个字段都在这里锁死——
// 改 PRO schema 或改 UI 读取路径而漏改对侧，本测试立刻红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, 'dist', 'merge-test');
const OUT = path.join(OUT_DIR, 'index.html');

// ── 构建（跳过 kline 拷贝，测试只要页面 JSON）──
const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build_ui.mjs'), '--out', OUT], {
  env: { ...process.env, SENT_SKIP_KLINE: '1', SENT_NO_WRITEBACK: '1' },
  encoding: 'utf8', cwd: ROOT,
});
assert.equal(res.status, 0, `build_ui 失败:\n${res.stderr || res.stdout}`);
const html = readFileSync(OUT, 'utf8');

// ── 抽取页面 JSON（build 对 </ 做了 <\/ 转义，抽出后还原）──
function extractPageData(doc) {
  const m = doc.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(m, '产物中找不到 report-data script 标签（占位符替换失败 = 白屏）');
  return JSON.parse(m[1].replace(/<\\\//g, '</'));
}
const D = extractPageData(html);
const DAYS = D.all_days;
const CUR = DAYS[DAYS.length - 1];

test('merge: 构建产物结构完整（占位符全替换 · 实验室模块全拼接）', () => {
  for (const leftover of ['__REPORT_DATA__', '/*__LAB_MODULES__*/', '__BUILD_AT__']) {
    assert.ok(!html.includes(leftover), `占位符 ${leftover} 未替换`);
  }
  for (const mod of ['lab-core.js', 'lab-kline.js', 'lab-realtime.js', 'lab-s11.js', 'vendor/qrcode.min.js']) {
    assert.ok(html.includes(`ui/src/${mod}`), `实验室模块 ${mod} 未拼接`);
  }
});

test('merge: 产物内联脚本全部可编译（模板拼接零语法错误——语法错=整页白屏）', () => {
  // 不执行（无 DOM/网络），只 vm.Script 编译：15 个 lab 模块拼接处最易出括号/逗号错
  const scripts = [...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1 && scripts[0].includes('const D = JSON.parse'), '主脚本块缺失（模板结构损坏）');
  for (let i = 0; i < scripts.length; i++) {
    assert.doesNotThrow(() => new vm.Script(scripts[i], { filename: `dist-inline-${i}.js` }),
      `第 ${i + 1} 个内联脚本编译失败（白屏级）`);
  }
});

test('merge: all_days 全部为真实交易日（回填占位日绝不入页面）', () => {
  assert.ok(DAYS.length >= 5, '真实交易日过少');
  for (const d of DAYS) {
    assert.ok(!d.emotion?._backfill, `${d.trade_date} 是回填占位日——s_net 单因子占位值混入页面会污染每个模块`);
    assert.match(d.trade_date, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('merge: day 核心字段（情绪/汇总/龙虎榜/行业——UI KPI 卡与表格直读）', () => {
  // 六因子回填（2026-10-02）+ 指数收益回填（2026-10-05）后页面纳入 241 个七因子真分天，
  // 按指数快照的口径分三类日：
  //   · EM 采集天（indexes 有值且无 indexes_caliber 留痕）：hot[]/indexes/hot_count 齐全；
  //   · 指数K线回填天（summary.indexes_caliber='kline-backfill'）：indexes 由指数日K回填、
  //     可直读（回测/回归的次日收益原料），但 hot 仍是裁剪空壳——题材榜走既有空态；
  //   · 无指数日（两轮回填后应绝迹）：indexes 显式 null（而非 undefined），UI 判据 `d.indexes &&` 才稳。
  const RANK_MIN = 20; // 分位窗口：前 20 天 pct_rank 为 null 是算法事实，不是缺字段
  DAYS.forEach((d, idx) => {
    assert.equal(typeof d.emotion?.value, 'number', `${d.trade_date} emotion.value`);
    if (idx >= RANK_MIN) assert.ok(d.emotion?.pct_rank != null, `${d.trade_date} emotion.pct_rank`);
    assert.ok(d.emotion?.lhb_daily_net != null, `${d.trade_date} emotion.lhb_daily_net（Tab2 净买柱/S7/S9）`);
    assert.ok(Array.isArray(d.lhb) && d.lhb.length, `${d.trade_date} lhb[]`);
    assert.ok(Array.isArray(d.industry) && d.industry.length, `${d.trade_date} industry[]`);
    const s = d.summary || {};
    const idxBackfilled = s.indexes_caliber === 'kline-backfill';
    const emCaptured = !!(d.indexes && d.indexes['上证指数'] != null) && !idxBackfilled;
    if (emCaptured) {
      assert.ok(Array.isArray(d.hot) && d.hot.length, `${d.trade_date} hot[]（EM 采集天必填）`);
    } else if (idxBackfilled) {
      // 留痕与值必须成对出现：有痕无值 = 半缺，UI 判据 `d.indexes &&` 会把它当无数据
      assert.ok(d.indexes && ['上证指数', '深证成指', '创业板指'].every((a) => Number.isFinite(d.indexes[a])),
        `${d.trade_date} 指数回填留痕但三指数值缺失（半缺）`);
    } else {
      assert.ok(!d.indexes || d.indexes['上证指数'] == null, `${d.trade_date} 无留痕不应有指数快照`);
    }
    for (const k of ['lhb_daily_net', 'lhb_all_net', 'lhb_count', 'lhb_stocks', 'net_pos', 'net_neg',
      'lhb_daily_stocks', 'lhb_range_count', 'ind_up', 'ind_down', 'amount_yi']) {
      assert.ok(s[k] != null, `${d.trade_date} summary.${k} 缺失（KPI 卡会显示 undefined）`);
    }
    if (emCaptured) assert.ok(s.hot_count != null, `${d.trade_date} summary.hot_count（EM 采集天必填）`);
    // 涨跌停池组：整组一致——半缺（如有 zt_count 无 zbl_pct）会让降级判断失效、渲染出 undefined。
    const poolKeys = ['zt_count', 'dt_count', 'zbl_pct', 'max_lb'];
    const present = poolKeys.filter((k) => s[k] != null);
    assert.ok(present.length === 0 || present.length === poolKeys.length,
      `${d.trade_date} 涨跌停池字段半缺（${present.join(',')}）——UI 按组降级会漏`);
  });
});

test('merge: lhb[]/hot[] 行级字段（全榜表/强势股归因表/个股弹窗直读）', () => {
  for (const r of CUR.lhb.slice(0, 5)) {
    for (const k of ['code', 'name', 'close', 'change_pct', 'net_buy_wan', 'buy_wan', 'sell_wan', 'turnover_pct', 'reason']) {
      assert.ok(r[k] != null, `lhb 行缺 ${k}`);
    }
  }
  for (const r of CUR.hot.slice(0, 5)) {
    for (const k of ['code', 'name', 'reason', 'close', 'change_pct', 'huanshou']) {
      assert.ok(r[k] != null, `hot 行缺 ${k}`);
    }
  }
});

test('merge: themeList（题材热度/强度榜/成分股下钻/S4 族谱——引擎端去噪+强度分）', () => {
  assert.ok(Array.isArray(CUR.themeList) && CUR.themeList.length >= 3, 'themeList 过少');
  for (const t of CUR.themeList.slice(0, 5)) {
    for (const k of ['tag', 'count', 'codes', 'avg_zf', 'avg_hs', 'net', 'streak', 'score']) {
      assert.ok(t[k] != null, `themeList 元素缺 ${k}（强度榜列直接渲染 undefined）`);
    }
    assert.ok(Array.isArray(t.codes) && t.codes.length >= 1, 'codes 非空数组（成分股下钻依赖）');
  }
  const scores = CUR.themeList.map((t) => t.score);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores, 'themeList 应按 score 降序');
});

test('merge: signals.momentum 三态对象形态（信号中心直读）+ signals.industry 动量', () => {
  const mom = D.signals?.momentum;
  assert.ok(mom, 'signals.momentum 缺失');
  for (const k of ['fresh', 'continuing', 'fading']) {
    assert.ok(Array.isArray(mom[k]), `momentum.${k} 应为数组`);
    for (const el of mom[k]) {
      assert.equal(typeof el?.theme, 'string', `momentum.${k} 元素 theme`);
      assert.equal(typeof el?.stocks, 'number', `momentum.${k} 元素 stocks`);
    }
  }
  const ind = D.signals?.industry;
  assert.ok(Array.isArray(ind?.top) && Array.isArray(ind?.bottom), 'signals.industry top/bottom');
});

test('merge: briefs / stocks / board_rank（实验室 S3/S5/S8/S11 与 Tab4 板块排行）', () => {
  assert.ok(Object.keys(D.briefs || {}).length >= 5, 'briefs 至少 5 期');
  assert.ok(D.briefs[CUR.trade_date], '最新日必有简报');
  const codes = Object.keys(D.stocks || {});
  assert.ok(codes.length >= 100, `stocks 过少（${codes.length}）`);
  const st = D.stocks[codes[0]];
  assert.ok(st.name && Array.isArray(st.closes) && st.closes.length >= 2, 'stocks 元素 {name, closes}');
  const brDates = Object.keys(D.board_rank || {});
  assert.ok(brDates.length >= 100, `board_rank 应含老系统一年种子（${brDates.length}）`);
  const br = D.board_rank[brDates[0]];
  assert.ok(Array.isArray(br) && br[0].length === 2, 'board_rank 行 [name, pct]');
});

test('merge: meta（holidays 徽章 / dataQuality / freshness——今日状态与页头徽章）', () => {
  assert.ok(Array.isArray(D.meta?.holidays) && D.meta.holidays.length >= 10, 'holidays 来自 PRO 交易日历休市清单');
  assert.equal(typeof D.meta?.dataQuality?.industrySourceOk, 'boolean');
  assert.ok(D.meta?.freshness?.state, 'freshness 存在');
  assert.equal(typeof D.generated, 'string');
});

test('merge: yzt_chg 派生字段（KPI 昨涨停效应卡——缺数据日应为缺失而非编数）', () => {
  // K 线分片能覆盖的日期必有值；覆盖不到的日期允许 null（UI 条件渲染隐藏卡片），绝不允许出现编造值
  const withYzt = DAYS.filter((d) => d.summary?.yzt_chg != null);
  assert.ok(withYzt.length >= 1, '至少一天有 yzt_chg（K 线分片可派生）');
  for (const d of withYzt) {
    assert.ok(Number.isFinite(d.summary.yzt_chg), `${d.trade_date} yzt_chg 非有限数`);
  }
});

// 清理测试产物
test('merge: 清理测试产物目录', () => {
  rmSync(OUT_DIR, { recursive: true, force: true });
});
