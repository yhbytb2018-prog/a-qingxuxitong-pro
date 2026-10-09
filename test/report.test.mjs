// 报告导出引擎单测：解析、三种输出形态、文件命名。
//
// jsdom 是**可选**依赖（CI 只跑 `node --test`，不装 jsdom），所以：
//   · 依赖 DOM 解析的用例在缺 jsdom 时自动跳过，不让 CI 变红
//   · 输出形态（纯文本/Markdown/HTML/命名/样式）全部基于**纯数据结构**，无需 DOM，
//     这些用例任何环境下都必须真跑——它们是这个模块的主契约。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  parseReport, toPlainText, toMarkdown, toStandaloneHtml, reportFileName,
  REPORT_TITLE, REPORT_ORG, STANDALONE_CSS, CALIBER_SUMMARY, CALIBER_SUMMARY_DOC, MARKERS,
  DOC_SPEC, h1Mark, h2Mark, h3Mark, h4Mark, sectionNo, sectionTitle, foldTitle,
  briefSerial, cnBracket, docDate,
} from '../src/report.js';

// 可选依赖：解析不出来就跳过解析类用例
let JSDOM = null;
try { JSDOM = createRequire(import.meta.url)('jsdom').JSDOM; } catch (e) { JSDOM = null; }
const needDom = JSDOM ? false : 'jsdom 未安装（可选依赖），跳过 DOM 解析用例';
const dom = (html) => new JSDOM(html).window.document;

/** 造一个与 buildBrief 输出同构的 #briefBody */
function fixture() {
  const html = `
<div class="bf-meta">数据日期 <b>2026-09-30</b> · 抓取状态 <b>最新</b> · 样本 33 个交易日</div>
<div class="bf-abstract"><span class="bf-ab-tag">极简摘要</span><span class="bf-ab-text">中性震荡，控制仓位做结构｜半仓</span></div>
<div class="bf-sec" id="bfsec1">
  <div class="bf-h">① 情绪定位（核心因子·25%）</div>
  <div class="bf-body">
    <div class="bf-li">情绪 <b>68.6</b>（历史分位 <b>68.8%</b>），较昨日 <b>-8.1</b>，落于<b>中性区</b>。</div>
    <div class="bf-li"><span class="bf-warn">⚠ 因子缺失：北向，今日分可信度降权</span></div>
    <table class="bf-table" data-caption="连板天梯（当日涨停股连板数映射 zt_lb，逐只可核）">
      <thead><tr><th>板数</th><th>只数</th><th>个股</th></tr></thead>
      <tbody><tr><td>7 板</td><td>1 只</td><td>某某股份(600001)</td></tr>
      <tr><td>2 板</td><td>4 只</td><td>甲(600002)、乙(600003)</td></tr></tbody>
    </table>
  </div>
  <details class="bf-caliber"><summary>🔍 点击展开查看口径</summary><div class="bf-cal-body">情绪分为七因子加权合成（龙虎净额20%／涨跌家数10%）；历史分位＝该分在样本窗口内的百分位排名。</div></details>
</div>
<div class="bf-sec" id="bfsec2">
  <div class="bf-h">② 资金面（龙虎榜）</div>
  <div class="bf-body">
    <div class="bf-li">近5日当日龙虎净买（亿）: <span class="bf-up">+6.0</span> → <span class="bf-dn">-1.8</span></div>
    <div class="bf-h bf-h2">明日跟踪项（引擎动态生成）</div>
    <div class="bf-todo">能否守住正轴（0 亿上方）</div>
    <div class="bf-todo">新晋题材明日存活率（≥50% = 聚焦）</div>
  </div>
  <details class="bf-caliber"><summary>🔍 点击展开查看口径</summary><div class="bf-cal-body">席位分项之和与「当日榜净买」不必相等，二者不可相互校验。</div></details>
</div>
<details class="bf-caliber bf-appendix" open><summary>📚 口径附录（全报告统一口径汇总）</summary><div class="bf-cal-body">口径备注：涨跌家数为沪深两市（不含北交所）；本报告由规则引擎自动生成，非投资建议。</div></details>
<div class="bf-foot">口径备注：涨跌家数为沪深两市（不含北交所）；本报告由规则引擎自动生成，非投资建议。</div>`;
  return dom(`<div id="briefBody">${html}</div>`).getElementById('briefBody');
}

/**
 * 与 fixture() 等价的**纯数据**版本：不依赖 DOM，供输出形态用例使用。
 * 刻意手写（而非从 DOM 解析），这样即使没有 jsdom，输出契约也照样被守住。
 */
const REP_DATA = {
  meta: '数据日期 2026-09-30 · 抓取状态 最新 · 样本 33 个交易日',
  abstract: '中性震荡，控制仓位做结构｜半仓（建议仓位 40%~60%）｜情绪 68.6 落于中性区｜🔴 短板在广度量能',
  sections: [
    {
      id: 'bfsec1', title: '① 情绪定位（核心因子·25%）',
      lines: [
        { kind: 'li', text: '情绪 **68.6**（历史分位 **68.8%**），较昨日 **-8.1**，落于**中性区**。' },
        { kind: 'li', text: '⚠ 因子缺失：北向，今日分可信度降权' },
      ],
      caliber: '情绪分为七因子加权合成（龙虎净额20%／涨跌家数10%）；历史分位＝该分在样本窗口内的百分位排名。',
    },
    {
      id: 'bfsec2', title: '② 资金面（龙虎榜）',
      lines: [
        { kind: 'li', text: '近5日当日龙虎净买（亿）: 【涨】+6.0 → 【跌】-1.8' },
        { kind: 'sub', text: '明日跟踪项（引擎动态生成）' },
        { kind: 'todo', text: '能否守住正轴（0 亿上方）' },
        { kind: 'todo', text: '新晋题材明日存活率（≥50% = 聚焦）' },
      ],
      caliber: '席位分项之和与「当日榜净买」不必相等，二者不可相互校验。',
    },
    {
      id: 'bfsec3', title: '③ 盈亏效应（核心因子·25%）',
      lines: [
        { kind: 'li', text: '封板率 **81.3%**' },
        {
          kind: 'table',
          caption: '连板天梯（当日涨停股连板数映射 zt_lb，逐只可核）',
          head: ['板数', '只数', '个股'],
          rows: [['7 板', '1 只', '某某股份(600001)'], ['2 板', '4 只', '甲(600002)、乙(600003)']],
        },
      ],
      caliber: '封板率＝收盘涨停 ÷ 盘中触板个股（＝涨停+炸板）。',
    },
  ],
  appendix: { title: '📚 口径附录（全报告统一口径汇总）', body: '口径备注：涨跌家数为沪深两市（不含北交所）；本报告由规则引擎自动生成，非投资建议。' },
  foot: null,
};

test('report: 解析出段落/标题/行/落款/口径附注', { skip: needDom }, () => {
  const rep = parseReport(fixture());
  assert.equal(rep.sections.length, 2);
  // 第①段正文 = 2 条 li + 1 张连板天梯表（表格也是"一行"，但不混进 li）
  assert.equal(rep.sections[0].lines.length, 3);
  assert.equal(rep.sections[0].lines.filter((l) => l.kind === 'li').length, 2);
  assert.ok(rep.sections[0].title.includes('情绪定位'));
  assert.ok(rep.meta.includes('数据日期 2026-09-30'));
  assert.ok(rep.meta.includes('抓取状态 最新'));
  assert.ok(rep.foot.includes('口径备注'));
});

test('report: 极简摘要被解析为 abstract（模板①）', { skip: needDom }, () => {
  const rep = parseReport(fixture());
  assert.equal(rep.abstract, '中性震荡，控制仓位做结构｜半仓');
});

test('report: 口径折叠件从段落里摘出解析为 caliber（模板③，且不混进正文行）', { skip: needDom }, () => {
  const rep = parseReport(fixture());
  assert.ok(rep.sections[0].caliber.includes('七因子加权合成'), '段落口径未解析出');
  assert.equal(rep.sections[0].lines.some((l) => /七因子/.test(l.text)), false,
    '口径内容泄漏进了正文行——读者会在正文里看到本该收起的内容');
});

test('report: 文末独立折叠附录被解析为 appendix（模板③）', { skip: needDom }, () => {
  const rep = parseReport(fixture());
  assert.ok(rep.appendix, '未解析出独立附录');
  assert.ok(rep.appendix.title.includes('口径附录'));
  assert.ok(rep.appendix.body.includes('涨跌家数为沪深两市'));
});

test('report: 连板天梯解析为表格结构（模板②，不摊平成一行文字）', { skip: needDom }, () => {
  const rep = parseReport(fixture());
  const tbl = rep.sections[0].lines.find((l) => l.kind === 'table');
  assert.ok(tbl, '未解析出表格节点');
  assert.deepEqual(tbl.head, ['板数', '只数', '个股']);
  assert.equal(tbl.rows.length, 2);
  assert.equal(tbl.rows[0][0], '7 板');
  assert.ok(tbl.caption.includes('连板天梯'));
});

test('report: 明日跟踪项解析为 todo（模板④，与普通 li 区分）', { skip: needDom }, () => {
  const rep = parseReport(fixture());
  const kinds = rep.sections[1].lines.map((l) => l.kind);
  assert.deepEqual(kinds, ['li', 'sub', 'todo', 'todo']);
  assert.ok(rep.sections[1].lines[2].text.includes('守住正轴'));
});

// ★ 回归：表格被 .bf-li 包住时也必须解析为表格（不许摊平成一行文字）
//   真实 bug：报告 §4「板块相对强弱」原先把 <table> 放进 li() 里（.bf-li > .bf-table），
//   而 extractLines 只认 .bf-body 的**直接子**表格 → 该表掉进 kind:'li' → 被 inline() 摊平，
//   导出的 Markdown/HTML 里只剩「超额进攻（前 5）涨跌幅超额攻0↑+1.00%…」一坨无结构文本，
//   表格在文档里整块消失（用户报的"表格有缺失"）。
test('report: .bf-li 内嵌的表格仍解析为表格（★ 不许摊平成文字）', { skip: needDom }, () => {
  const html = '<div class="bf-body">'
    + '<div class="bf-li">板块相对强弱（基准 上证指数 +0.31%）</div>'
    + '<div class="bf-li"><table class="bf-table rel-table" data-caption="板块相对强弱（基准 上证指数 +0.31%） · 超额进攻（前 5）">'
    + '<thead><tr><th>超额进攻（前 5）</th><th>涨跌幅</th><th>超额</th></tr></thead>'
    + '<tbody><tr><td>生物制品</td><td class="bf-up">+4.63%</td><td class="bf-up"><b>+4.32</b></td></tr>'
    + '<tr><td>医疗服务</td><td class="bf-up">+3.11%</td><td class="bf-up"><b>+2.80</b></td></tr></tbody>'
    + '</table></div></div>';
  const d = new JSDOM(`<div id="b"><div class="bf-sec" id="s4"><div class="bf-h">'
    + '<span class="bf-sec-no">四、</span><span class="bf-sec-t">广度与量能</span></div>${html}</div></div>`);
  const rep = parseReport(d.window.document.querySelector('#b'));
  const lines = rep.sections[0].lines;
  const tbl = lines.find((l) => l.kind === 'table');
  assert.ok(tbl, '内嵌 .bf-li 的表格未被识别为表格（会退化成一行摊平文字）');
  assert.deepEqual(tbl.head, ['超额进攻（前 5）', '涨跌幅', '超额'], '表头解析错误');
  assert.equal(tbl.rows.length, 2, '数据行数应为 2');
  assert.equal(tbl.rows[0][0], '生物制品');
  assert.ok(tbl.caption.includes('超额进攻'), 'data-caption 未解析');
  // 反面：绝不允许这一行被摊平成 li 文本
  const flat = lines.find((l) => l.kind === 'li' && /涨跌幅超额/.test(l.text));
  assert.equal(flat, undefined, '表格被摊平成了 li 文本（正是要修的那条 bug）');
});

test('report: 段内小标题（.bf-h2）识别为 sub 而非 li', { skip: needDom }, () => {
  const rep = parseReport(fixture());
  const kinds = rep.sections[1].lines.map((l) => l.kind);
  assert.equal(kinds[1], 'sub');
  assert.equal(rep.sections[1].lines[1].text, '明日跟踪项（引擎动态生成）');
});

test('report: 空输入不抛异常（报告未渲染时调用）', () => {
  const rep = parseReport(null);
  assert.deepEqual(rep, { meta: null, abstract: null, sections: [], appendix: null, foot: null });
  assert.equal(toPlainText(rep).includes(REPORT_TITLE), true); // 仍能输出一个空壳文档
});

test('report: 纯文本不含任何 HTML 标签', () => {
  const txt = toPlainText(REP_DATA, { dataDate: '2026-09-30', generatedAt: '2026-10-01 10:00' });
  assert.equal(/<[a-zA-Z/][^>]*>/.test(txt), false, '出现 HTML 残留：' + txt.match(/<[^>]*>/)?.[0]);
  assert.ok(txt.includes('情绪定位'));
  assert.ok(txt.includes('68.6'));
  assert.ok(txt.includes('2026-09-30'));
});

test('report: 纯文本保留涨跌可读性（数字在，标记不残留）', () => {
  const txt = toPlainText(REP_DATA);
  assert.ok(txt.includes('+6.0') && txt.includes('-1.8'));
  assert.equal(txt.includes('【涨】'), false, '纯文本不该带标记词');
  assert.equal(txt.includes('**'), false, '纯文本不该带 Markdown 粗体');
});

test('report: 警告标记规范化为单个 ⚠（连续/贴边都不会重复堆叠）', { skip: needDom }, () => {
  const doc = dom(`<div id="b"><div class="bf-sec"><div class="bf-h">段</div><div class="bf-body">
    <div class="bf-li"><span class="bf-warn">⚠ 甲</span></div>
    <div class="bf-li"><span class="bf-warn">⚠ ⚠ 乙</span></div>
    <div class="bf-li">+5.04亿<span class="bf-warn">⚠</span> （独立新股）</div>
  </div></div></div>`).getElementById('b');
  const rep = parseReport(doc);
  for (const l of rep.sections[0].lines) {
    const n = (l.text.match(/⚠/g) || []).length;
    assert.equal(n, 1, `「${l.text}」里 ⚠ 出现了 ${n} 次`);
  }
});

test('report: Markdown 结构合法（标题层级 + 列表，序号为公文「一、」体系）', () => {
  const md = toMarkdown(REP_DATA, { dataDate: '2026-09-30' });
  assert.ok(md.startsWith(`# ${REPORT_TITLE}`));
  assert.ok(md.includes('**数据日期**：2026-09-30'));
  // 一级标题用「一、」（不是 ①），二级用「（一）」
  assert.ok(/^## 一、情绪定位/m.test(md), '一级标题应为 ## 一、…');
  assert.ok(/^### （一）明日跟踪项/m.test(md), '段内小标题应为 ### （一）…');
  assert.ok(/^- 情绪/m.test(md), '正文行应为无序列表');
  assert.ok(md.includes('> '), '应有引用块（摘要/数据落款/免责）');
  assert.ok(md.includes('非投资建议'));
});

test('report: 独立 HTML 自包含——无脚本、无外部依赖', () => {
  const html = toStandaloneHtml(REP_DATA, { dataDate: '2026-09-30', generatedAt: '2026-10-01 10:00' });
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.equal(/<script/i.test(html), false, '导出文档不该带脚本');
  assert.equal(/<link[^>]+href=/i.test(html), false, '不该引用外部样式表');
  assert.equal(/(src|href)=["']https?:/i.test(html), false, '不该引用任何外部资源');
  assert.ok(html.includes('<style>'), '样式必须内联');
  assert.ok(html.includes('@page'), '必须有打印页面设置');
  assert.ok(html.includes('lang="zh-CN"'));
});

test('report: 独立 HTML 是公文体例的正式文档（报头/落款/编号章节/附注/免责）', () => {
  const html = toStandaloneHtml(REP_DATA, { dataDate: '2026-09-30' });
  assert.ok(html.includes('class="doc-head"'), '缺报头');
  assert.ok(html.includes('class="masthead"'), '缺简报名称');
  assert.ok(html.includes('<h1 class="doc-title"'), '缺主标题');
  assert.ok(html.includes(REPORT_ORG));
  assert.ok(html.includes('数据日期'));
  assert.ok(html.includes('class="serial"'), '缺简报编号');
  assert.ok(/<h2 class="h1">一、/.test(html), '章节序号应为公文「一、」');
  assert.ok(html.includes('class="sign-date"'), '缺生成日期落款');
  assert.ok(html.includes('口径备注'), '应含口径附注');
  assert.ok(html.includes('免责声明'), '应含免责声明');
});

test('report: HTML 转义——报告文本里的尖括号不会变成标签（防注入）', { skip: needDom }, () => {
  const doc = dom(`<div id="b"><div class="bf-sec"><div class="bf-h">段</div><div class="bf-body">
    <div class="bf-li">某票 &lt;script&gt;alert(1)&lt;/script&gt; 与 a &amp; b</div>
  </div></div></div>`).getElementById('b');
  const html = toStandaloneHtml(parseReport(doc), { dataDate: '2026-09-30' });
  assert.equal(/<script>alert/.test(html), false, '未转义导致注入');
  assert.ok(html.includes('&lt;script&gt;'), '应保留转义后的原文');
  assert.ok(html.includes('a &amp; b'));
});

test('report: 涨跌/警示在 HTML 里用语义标签且**成对闭合**', () => {
  const html = toStandaloneHtml(REP_DATA, { dataDate: '2026-09-30' });
  assert.ok(html.includes('class="chg"'), '涨应带 .chg');
  assert.ok(html.includes('class="chg chg-dn"'), '跌应带 .chg-dn');
  assert.ok(html.includes('class="warn"'), '警示应带 .warn');
  // 标签配对：任何 <span 必须有等量 </span>
  const open = (html.match(/<span\b/g) || []).length;
  const close = (html.match(/<\/span>/g) || []).length;
  assert.equal(open, close, `span 未配对：开 ${open} 闭 ${close}`);
});

test('report: 涨跌着色只覆盖数字，不吃掉后文', () => {
  const html = toStandaloneHtml(REP_DATA, {});
  // 【涨】+6.0 → 着色 span 必须恰好在 +6.0 后闭合，紧随其后的「 → 」不能被裹进去
  assert.ok(/<span class="chg"><i>▲<\/i> \+6\.0<\/span>/.test(html),
    '着色范围不对：' + (html.match(/<span class="chg">[\s\S]{0,60}/) || [''])[0]);
});

test('report: 粗体正确映射为 <b>，且不残留 ** 标记', () => {
  const html = toStandaloneHtml(REP_DATA, {});
  assert.ok(html.includes('<b>68.6</b>'));
  // 只看 <style> 之后的正文：CSS 注释里的 ** 是文档说明，不是泄漏到成品的标记
  const bodyPart = html.slice(html.indexOf('</style>'));
  assert.equal(bodyPart.includes('**'), false, 'HTML 正文里不该残留 Markdown 标记');
});

test('report: 文件名按日期命名（便于排序），非法日期有兜底', () => {
  assert.equal(reportFileName('2026-09-30', 'html'), 'A股研判报告_2026-09-30.html');
  assert.equal(reportFileName('2026-09-30', 'md'), 'A股研判报告_2026-09-30.md');
  assert.equal(reportFileName('', 'txt'), 'A股研判报告_unknown.txt');
  assert.equal(reportFileName(null, 'txt'), 'A股研判报告_unknown.txt');
});

test('report: 样式表是白底黑字（导出/打印的文档不能是深色底）', () => {
  assert.ok(/html,\s*body\s*\{[^}]*background:\s*#fff/i.test(STANDALONE_CSS), 'body 应为白底');
  // 公文正文是纯黑（#000）；这里刻意不用 #1a1a1a——打印稿要求的就是墨色足
  assert.ok(/body\s*\{[^}]*color:\s*#000/i.test(STANDALONE_CSS), '正文应为纯黑字');
  assert.equal(/#0d1117|#161b22/i.test(STANDALONE_CSS), false, '不该出现站点深色主题色');
  assert.ok(/@media print/.test(STANDALONE_CSS));
  // 涨红跌绿（中文惯例）在导出文档里同样成立
  assert.ok(/\.chg\s*\{[^}]*#c0392b/i.test(STANDALONE_CSS));
  assert.ok(/\.chg-dn\s*\{[^}]*#1e7e34/i.test(STANDALONE_CSS));
});

// ────────────────────────────────────────────────────────────────────────────
// 模板契约（用户给定的「A 股研判报告输出模板」五条）。
// 这一组用例的意义：模板是**排版层**的硬约束，不是"最好做到"的建议。
// 一旦有人重构导出引擎时把摘要/折叠/表格/复选框弄丢，这里会立刻变红。
// 同时它们守住另一条更重要的纪律——**导出只翻译屏幕 DOM，不重算任何指标**
// （见文件头的说明；report.js 里不应出现 tanh/加权/阈值之类的计算）。
// ────────────────────────────────────────────────────────────────────────────

test('模板①：报告开头有摘要栏，且排在首个章节之前', () => {
  const md = toMarkdown(REP_DATA, { dataDate: '2026-09-30' });
  assert.ok(md.includes('【摘要】'), 'Markdown 缺摘要栏');
  assert.ok(md.indexOf('【摘要】') < md.indexOf('## 一、'), '摘要没有排在报告开头');
  const html = toStandaloneHtml(REP_DATA, { dataDate: '2026-09-30' });
  assert.ok(html.includes('class="doc-abstract"'), 'HTML 缺摘要栏');
  assert.ok(html.indexOf('doc-abstract') < html.indexOf('class="sec"'), '摘要没有排在首个章节前');
});

test('模板②：固定 7 大章节时输出 7 个「一、」级标题，连板天梯是 Markdown 表格而非一行文字', () => {
  const md = toMarkdown(REP_DATA, {});
  // 公文体例的一级序号是「一、二、三、…」（不再是 ①②③）
  assert.ok(/^## 一、/m.test(md) && /^## 二、/m.test(md) && /^## 三、/m.test(md));
  // 天梯表格：表头 + 分隔行 + 数据行，三者缺一不可
  assert.ok(/\|\s*板数\s*\|\s*只数\s*\|\s*个股\s*\|/.test(md), '天梯表头缺失');
  assert.ok(/\|\s*---\s*\|\s*---\s*\|\s*---\s*\|/.test(md), '表格缺分隔行（Markdown 不会渲染成表）');
  assert.ok(/\|\s*7 板\s*\|/.test(md), '天梯数据行缺失');
});

test('模板③：每个章节口径收进 <details>，文末有独立折叠附录', () => {
  const md = toMarkdown(REP_DATA, {});
  const open = (md.match(/<details>/g) || []).length;
  const close = (md.match(/<\/details>/g) || []).length;
  assert.equal(open, close, `<details> 未配对：开 ${open} 闭 ${close}`);
  // 三个章节各一个折叠件 + 1 个文末附录
  assert.ok(open >= 4, `折叠件数量不足：${open}`);
  assert.ok(md.includes(`<summary>${CALIBER_SUMMARY_DOC}</summary>`), '章节折叠件标题必须与约定一致');
  // ★ 导出文档不得出现"点击展开"字样：静态文档里"点击"是一句做不到的邀请
  assert.ok(!md.includes('点击展开'), '导出 Markdown 不应出现「点击展开」字样（读者无从点击）');
  assert.ok(md.includes('口径附录'), '缺文末独立口径附录');
  // 默认收起 = 每处口径都必须落在 <details>…</details> 之间，而不是裸露在正文里
  for (const cal of REP_DATA.sections.map((s) => s.caliber).filter(Boolean)) {
    const i = md.indexOf(cal);
    assert.ok(i > 0, `口径内容整段丢失：${cal.slice(0, 12)}…`);
    const before = md.slice(0, i);
    const lastOpen = before.lastIndexOf('<details>');
    const lastClose = before.lastIndexOf('</details>');
    assert.ok(lastOpen > lastClose, `口径未包在 <details> 内（等于默认展开）：${cal.slice(0, 12)}…`);
  }
});

test('模板④：关键数值加粗 / 风险带 ⚠ / 跟踪项为 GFM 复选框 / 三档配色标记齐备', () => {
  const md = toMarkdown(REP_DATA, {});
  assert.ok(md.includes('**68.6**'), '关键数值未加粗');
  assert.ok(md.includes('⚠'), '风险提示未带 ⚠');
  assert.ok(/^- \[ \] 能否守住正轴/m.test(md), '跟踪项未输出 GFM 复选框语法');
  // 三档配色标记：risk/pos/neutral 各对应一个 emoji，且常量与实现一致
  assert.equal(MARKERS.risk, '🔴'); assert.equal(MARKERS.pos, '🟢'); assert.equal(MARKERS.neutral, '⚫');
  const withMark = { ...REP_DATA, abstract: '[[risk:短板在广度量能]]｜[[pos:资金进场]]｜[[neutral:中性震荡]]' };
  const md2 = toMarkdown(withMark, {});
  assert.ok(md2.includes('🔴短板在广度量能'), 'risk 标记未落地');
  assert.ok(md2.includes('🟢资金进场'), 'pos 标记未落地');
  assert.ok(md2.includes('⚫中性震荡'), 'neutral 标记未落地');
  assert.equal(md2.includes('[['), false, '标记语法泄漏到了成品');
  const html2 = toStandaloneHtml(withMark, {});
  assert.ok(html2.includes('class="ico ico-risk"') && html2.includes('class="ico ico-pos"')
    && html2.includes('class="ico ico-neutral"'), 'HTML 未渲染三档配色类');
  assert.equal(/\[\[/.test(html2), false, 'HTML 里标记语法泄漏');
  const txt2 = toPlainText(withMark, {});
  assert.ok(txt2.includes('🔴短板在广度量能'), '纯文本丢了配色标记（emoji 是唯一能跨形态保留的载体）');
});

test('模板⑤：结尾附免责声明与导出时间', () => {
  const md = toMarkdown(REP_DATA, { generatedAt: '2026-10-01 10:00' });
  assert.ok(md.trimEnd().endsWith('> 导出时间：2026-10-01 10:00'), 'Markdown 结尾不是导出时间');
  assert.ok(md.includes('非投资建议'));
  const html = toStandaloneHtml(REP_DATA, { generatedAt: '2026-10-01 10:00' });
  assert.ok(html.includes('免责声明') && html.includes('2026-10-01 10:00'));
  const txt = toPlainText(REP_DATA, { generatedAt: '2026-10-01 10:00' });
  assert.ok(txt.includes('非投资建议') && txt.includes('导出时间：2026-10-01 10:00'));
});

test('模板·降级：纯文本渲染不了折叠，口径一律平铺并带 [口径] 前缀（不丢信息）', () => {
  const txt = toPlainText(REP_DATA, {});
  assert.equal(/<details|<summary/.test(txt), false, '纯文本不该出现折叠标签');
  assert.ok(txt.includes('[口径] 情绪分为七因子加权合成'), '章节口径未被平铺保留');
  assert.ok(txt.includes('[口径] 口径备注：涨跌家数为沪深两市'), '附录口径未被平铺保留');
  assert.ok(txt.includes('[ ] 能否守住正轴'), '复选框在纯文本里应降级为 [ ]');
});

test('模板·HTML：<details> 折叠件无需脚本即可用（导出文档仍然无 JS）', () => {
  const html = toStandaloneHtml(REP_DATA, {});
  assert.ok(html.includes('<details class="caliber"'), 'HTML 缺折叠件');
  assert.ok(html.includes(`<summary>${CALIBER_SUMMARY_DOC}</summary>`), '折叠件标题必须与约定一致');
  assert.ok(!html.includes('点击展开'), '导出 HTML 不应出现「点击展开」字样（读者无从点击）');
  assert.ok(html.includes('details.caliber'), '样式表缺折叠件样式');
  assert.equal(/<script/i.test(html), false, '折叠件是原生 HTML，不该为此引入脚本');
  // 打印时折叠件必须强制展开（收起着打出来会缺口径）
  // ★ 断言必须用**全量兜底**选择器 `> *:not(summary)`，不能只认 p/ul：
  //   旧版只写了 `> p` 与 `> ul`，口径正文一旦含表格/多段就漏掉 —— 这正是
  //   "打印时看不到全部内容"的根因（且它还能通过旧断言，属于守卫自己锁住了 bug）。
  assert.ok(/details\.caliber\s*>\s*\*:not\(summary\)[^}]*display:\s*block\s*!important/.test(STANDALONE_CSS),
    '打印样式未用全量选择器强制展开口径件（只写 p/ul 会漏掉表格等）');
});

test('模板·HTML：表格与复选框清单渲染为语义标签', () => {
  const html = toStandaloneHtml(REP_DATA, {});
  assert.ok(/<table class="rep-tbl">/.test(html), '缺表格');
  assert.ok(/<thead><tr><th>板数<\/th>/.test(html), '表头未渲染为 th（打印时不会重复表头）');
  assert.ok(html.includes('<ul class="todo">'), '复选框清单未渲染为独立列表');
  assert.ok(html.includes('class="cb"'), '缺复选框占位符 ☐');
  assert.equal(/<input[^>]*type=["']checkbox/i.test(html), false,
    '导出文档里不该用 <input>（静态稿里不可交互，部分渲染器还会丢掉）');
});

test('模板·纪律：导出层不重算指标（不出现 tanh/加权/阈值推导）', async () => {
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/report.js', import.meta.url), 'utf8'));
  // 去掉注释后，统计代码里不该出现"重新算一个指标"的痕迹
  const code = src.split('\n').filter((ln) => !/^\s*(\/\/|\*|\/\*)/.test(ln)).join('\n');
  for (const bad of [/Math\.tanh/, /scoreEmotion|scorePnl|scoreTheme|scoreBreadth/, /weights?\s*\./, /clamp100/]) {
    assert.equal(bad.test(code), false, `report.js 里出现了指标计算痕迹：${bad}`);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 公文体例契约（用户给定的「A股市场研究分析简报 · 报告标准格式」）
// 这一组用例的性质与前一组不同：前面守的是「内容别丢」，这里守的是「格式别走样」。
// 公文格式是**规范**——版心、字号阶梯、序号层级都是硬要求，不是审美偏好。
// 版式数值全部来自 DOC_SPEC（唯一出处），所以这里既断言 DOC_SPEC 本身，
// 也断言 CSS/HTML **确实用了** DOC_SPEC（防止有人绕过常量手写字面量）。
// ────────────────────────────────────────────────────────────────────────────

test('公文·版式规格：A4 与页边距（上37 下35 左28 右26）', () => {
  assert.equal(DOC_SPEC.page.size, 'A4');
  assert.equal(DOC_SPEC.page.w, '210mm');
  assert.equal(DOC_SPEC.page.h, '297mm');
  assert.equal(DOC_SPEC.page.top, '37mm');
  assert.equal(DOC_SPEC.page.bottom, '35mm');
  assert.equal(DOC_SPEC.page.left, '28mm');
  assert.equal(DOC_SPEC.page.right, '26mm');
  // CSS 必须由常量插值而来，不是手抄
  assert.ok(/@page\s*\{[^}]*margin:\s*37mm 26mm 35mm 28mm/.test(STANDALONE_CSS),
    '@page 边距未按 DOC_SPEC 生成（顺序：上 右 下 左）');
});

test('公文·字号阶梯：2 号报头/主标题、3 号摘要与正文与附表、4 号页码', () => {
  assert.equal(DOC_SPEC.font.h1, '22pt');
  assert.equal(DOC_SPEC.font.abstract, '16pt');
  assert.equal(DOC_SPEC.font.body, '16pt');
  assert.equal(DOC_SPEC.font.table, '16pt');
  assert.equal(DOC_SPEC.font.page, '14pt');
  const html = toStandaloneHtml(REP_DATA, { dataDate: '2026-09-30' });
  const need = [
    [/\.doc-head \.masthead\s*\{[^}]*font-size:\s*22pt/, '报头未用 2 号'],
    [/\.doc-title\s*\{[^}]*font-size:\s*22pt/, '主标题未用 2 号'],
    [/\.doc-abstract\s*\{[^}]*font-size:\s*16pt/, '摘要栏未用 3 号'],
    [/\.doc-body\s*\{[^}]*font-size:\s*16pt/, '正文未用 3 号'],
    [/\.tbl-cap\s*\{[^}]*font-size:\s*16pt/, '附表标题未用 3 号'],
    [/@page :right\s*\{\s*@bottom-right[^}]*?font-size:\s*14pt/, '页码未用 4 号'],
  ];
  for (const [re, msg] of need) assert.ok(re.test(html), msg);
});

test('公文·字体族：小标宋 / 黑体 / 楷体 / 仿宋', () => {
  assert.match(DOC_SPEC.family.xbs, /STZhongsong/, '小标宋应有跨平台兜底');
  assert.match(DOC_SPEC.family.hei, /SimHei/);
  assert.match(DOC_SPEC.family.kai, /KaiTi/);
  assert.match(DOC_SPEC.family.fs, /FangSong/);
  const html = toStandaloneHtml(REP_DATA, { dataDate: '2026-09-30' });
  const need = [
    [/\.doc-head \.masthead\s*\{[^}]*font-family:[^;}]*STZhongsong/, '报头未用小标宋'],
    [/\.doc-title\s*\{[^}]*font-family:[^;}]*STZhongsong/, '主标题未用小标宋'],
    [/\.doc-abstract\s*\{[^}]*font-family:[^;}]*KaiTi/, '摘要栏未用楷体'],
    [/\.sec h2\.h1\s*\{[^}]*font-family:[^;}]*SimHei/, '一级标题未用黑体'],
    [/\.sec h3\.h2\s*\{[^}]*font-family:[^;}]*KaiTi/, '二级标题未用楷体'],
    [/\.doc-body\s*\{[^}]*font-family:[^;}]*FangSong/, '正文未用仿宋'],
  ];
  for (const [re, msg] of need) assert.ok(re.test(html), msg);
});

test('公文·序号体系：一、（黑体）→（一）（楷体）→ 1.→（1），且不得混用', () => {
  assert.equal(h1Mark(1), '一、');
  assert.equal(h1Mark(3), '三、');
  assert.equal(h2Mark(1), '（一）');
  assert.equal(h2Mark(12), '（12）', '超出中文数字表的序号要退化成阿拉伯数字而不是崩掉');
  assert.equal(h3Mark(2), '2.');
  assert.equal(h4Mark(3), '（3）');
  assert.equal(sectionNo('cn', 2), '二、');
  assert.equal(sectionNo('cnPar', 2), '（二）');
  assert.equal(sectionNo('arabic', 2), '2.');
  assert.equal(sectionNo('arabicPar', 2), '（2）');
  // 未知层级不能抛异常（版式参数不该把报告弄崩）
  assert.equal(sectionNo(undefined, 1), '一、');

  const html = toStandaloneHtml(REP_DATA, { dataDate: '2026-09-30' });
  // 一级是「一、」、二级是「（一）」——两种形态都要真实出现
  assert.ok(/<h2 class="h1">一、/.test(html));
  assert.ok(/<h3 class="h2">（一）/.test(html));
  // 不得跳级：一、后面若直接跟阿拉伯数字「1.」就是混用（负向见 report_audit 的 doc-numbering-order）
  assert.equal(/<h2 class="h1">\d+\./.test(html), false, '一级标题混入了阿拉伯数字序号');
  assert.equal(/<h2 class="h1">[①②③④⑤⑥⑦⑧⑨]/.test(html), false, '一级标题仍带历史圆形序号');
});

test('公文·摘除历史圆形序号：① 情绪定位 → 情绪定位（序号由版式层重加）', () => {
  assert.equal(sectionTitle('① 情绪定位（核心因子·25%）'), '情绪定位（核心因子·25%）');
  assert.equal(sectionTitle('一、情绪定位'), '情绪定位', '屏幕层已写序号时也要摘掉，防止双序号');
  assert.equal(sectionTitle('情绪定位'), '情绪定位');
  const html = toStandaloneHtml(REP_DATA, { dataDate: '2026-09-30' });
  assert.ok(html.includes('>一、情绪定位（核心因子·25%）<'), '一级标题应是「一、＋纯文本标题」');
  assert.equal(/一、\s*一、/.test(html), false, '出现双序号');
});

test('公文·台阶式主标题：多行梯形/菱形，且不拆断词语', () => {
  // 短标题一行
  assert.deepEqual(foldTitle('情绪定位（核心因子·25%）'), ['情绪定位（核心因子·25%）']);
  // 长标题按标点断行，且每行都保留完整词组（不在半括号处断）
  const lines = foldTitle('资金面（龙虎榜）· 参与打分（主分数 s_net 权重 20%）+ 辅助观测（北向/机构行为）');
  assert.ok(lines.length >= 2 && lines.length <= DOC_SPEC.titleMaxLines, `行数 ${lines.length} 越界`);
  assert.equal(lines.join(''), '资金面（龙虎榜）· 参与打分（主分数 s_net 权重 20%）+ 辅助观测（北向/机构行为）',
    '断行不能丢字或多字（不许拆断，也不许吞字）');
  for (const l of lines) {
    assert.equal(/^[）】」』]/.test(l), false, `行首不该是收尾括号：「${l}」`);
  }
  // 导出的主标题带 data-line-count，供 CSS 决定梯形/菱形收窄比例
  const html = toStandaloneHtml(REP_DATA, { dataDate: '2026-09-30' });
  assert.ok(/<h1 class="doc-title" data-line-count="\d+">/.test(html), '主标题缺行数标注（无法排版梯形）');
  assert.ok(/\.doc-title\[data-line-count="2"\] \.t-line \+ \.t-line\s*\{[^}]*width:\s*7\d%/.test(STANDALONE_CSS),
    '两行标题未声明梯形收窄');
});

test('公文·报头与编号：2 号小标宋居中 + 编号居右 + 六角括号年份', () => {
  assert.equal(REPORT_TITLE, 'A股市场情绪研判简报');
  assert.deepEqual(DOC_SPEC.bracket, ['〔', '〕']);
  assert.equal(cnBracket(2026), '〔2026〕');
  assert.equal(briefSerial('2026-09-30', 3), '〔2026〕第 3 号');
  assert.equal(briefSerial('2026-09-30', undefined), '〔2026〕第 1 号', '缺期号时给明确缺省值');
  assert.equal(briefSerial('', 3), '', '无数据日期时不给编号，而不是编一个年份出来');

  const html = toStandaloneHtml(REP_DATA, { dataDate: '2026-09-30', issueNo: 7 });
  assert.ok(html.includes('<p class="masthead">A股市场情绪研判简报</p>'), '报头名称不对');
  assert.ok(html.includes('<p class="serial">〔2026〕第 7 号</p>'), '简报编号形态不对');
  assert.ok(/\.doc-head \.serial\s*\{[^}]*text-align:\s*right/.test(STANDALONE_CSS), '编号应居右');
  // 六角括号，绝不能用方括号
  assert.equal(/\[\d{4}\]/.test(html), false, '年份编号误用了方括号');
});

test('公文·生成日期：阿拉伯数字全年月日、不编虚位、右空四字', () => {
  assert.equal(docDate('2026-09-30'), '2026-09-30');
  assert.equal(docDate('2026-9-3'), '2026-09-03', '个位月日要补零（不编虚位的反面就是不能省位）');
  assert.equal(docDate('数据日期 2026-9-3 · 样本 33'), '2026-09-03', '能从含日期的文本里取日期');
  assert.equal(docDate('—'), '—', '取不到日期时原样返回，不编造');
  const html = toStandaloneHtml(REP_DATA, { dataDate: '2026-09-30' });
  assert.ok(html.includes('<p class="sign-date">2026-09-30</p>'), '落款日期不对');
  assert.ok(/\.sign-date\s*\{[^}]*text-align:\s*right[^}]*padding-right:\s*4em/.test(STANDALONE_CSS),
    '落款未右空四字');
});

test('公文·摘要栏与正文缩进：左空 2 字符、回行顶格', () => {
  assert.equal(DOC_SPEC.indentChars, 2);
  assert.equal(DOC_SPEC.dateRightChars, 4);
  const html = toStandaloneHtml(REP_DATA, { dataDate: '2026-09-30' });
  assert.ok(/\.doc-abstract\s*\{[^}]*text-indent:\s*2em/.test(html), '摘要栏未左空 2 字符');
  assert.ok(/\.sec li\s*\{[^}]*text-indent:\s*2em/.test(html), '正文行未左空 2 字符');
  assert.ok(/\.sec h2\.h1\s*\{[^}]*text-indent:\s*2em/.test(html), '一级标题未左空 2 字符');
  // 「回行顶格」由 text-indent 只管首行的特性天然实现：
  // 若改成了 padding-left 或 margin-left，回行会被一起推进去 —— 这里锁死不许出现
  assert.equal(/\.sec li\s*\{[^}]*padding-left/.test(html), false,
    '正文用了 padding-left（回行不再顶格，违反公文排版）');
});

test('公文·附表：表格标题在表格上方居中、表内文字 3 号仿宋', () => {
  const html = toStandaloneHtml(REP_DATA, { dataDate: '2026-09-30' });
  assert.ok(/\.tbl-cap\s*\{[^}]*text-align:\s*center/.test(html), '表格标题未居中');
  assert.ok(/\.rep-tbl\s*\{[^}]*font-family:[^;}]*FangSong/.test(html), '表内文字未用仿宋');
  assert.ok(/\.rep-tbl\s*\{[^}]*font-size:\s*16pt/.test(html), '表内文字未用 3 号');
  // 「在上方」：caption 必须出现在 <table> 之前
  const iCap = html.indexOf('class="tbl-cap"');
  const iTbl = html.indexOf('<table class="rep-tbl">');
  assert.ok(iCap > 0 && iTbl > 0 && iCap < iTbl, '表格标题跑到了表格下方');
});

test('公文·页码：4 号半角阿拉伯数字，单页右放、双页左放、版心之外', () => {
  assert.equal(DOC_SPEC.pageNo.page ?? DOC_SPEC.font.page, '14pt');
  assert.equal(DOC_SPEC.pageNo.single, 'right');
  assert.equal(DOC_SPEC.pageNo.double, 'left');
  // 「版心之外」= 由 @page 的页边距框（@bottom-*）承载，而不是页面内的 footer
  assert.ok(/@page :right\s*\{\s*@bottom-right\s*\{\s*content:\s*counter\(page\)/.test(STANDALONE_CSS),
    '单页页码未右放于版心外');
  assert.ok(/@page :left\s*\{\s*@bottom-left\s*\{\s*content:\s*counter\(page\)/.test(STANDALONE_CSS),
    '双页页码未左放于版心外');
  // 半角数字：counter(page) 输出的是 ASCII 数字，不能套全角替换
  assert.equal(/content:\s*counter\(page\)/.test(STANDALONE_CSS), true);
  assert.equal(/[０-９]/.test(STANDALONE_CSS), false, '样式里出现了全角数字（页码要求半角）');
});

test('公文·折叠口径模块：默认收起 <details>，标题与约定一致', () => {
  const html = toStandaloneHtml(REP_DATA, {});
  assert.ok(html.includes(`<summary>${CALIBER_SUMMARY_DOC}</summary>`), '折叠件标题必须与约定一致');
  assert.ok(!html.includes('点击展开'), '导出 HTML 不应出现「点击展开」字样（读者无从点击）');
  // 章节口径必须默认收起（没有 open 属性）；只有文末附录是展开的
  assert.ok(/<details class="caliber"><summary>/.test(html), '章节折叠件不应默认展开');
  assert.ok(/<details class="caliber appendix" open>/.test(html), '文末附录应默认展开');
  // 打印时必须强制展开，否则打出来缺口径。
  // ★ 断言全量兜底选择器（而非只认 p/ul）：旧断言写死了 `> p, > ul`，
  //   于是"只展开这两种"这个 bug 恰好能通过守卫——守卫自己锁住了 bug。
  assert.ok(/details\.caliber\s*>\s*\*:not\(summary\)[^}]*display:\s*block\s*!important/.test(STANDALONE_CSS),
    '打印样式未用全量选择器强制展开口径件（只写 p/ul 会漏掉表格等）');
});

test('公文·三条标记：关键数值加粗 / 风险前置 ⚠ / 跟踪清单复选框', () => {
  const html = toStandaloneHtml(REP_DATA, {});
  assert.ok(html.includes('<b>68.6</b>'), '关键数值未加粗');
  assert.ok(/<span class="warn">⚠ /.test(html), '风险提示未前置 ⚠');
  assert.ok(/<span class="cb">☐<\/span>/.test(html), '跟踪清单缺复选框占位');
  const md = toMarkdown(REP_DATA, {});
  assert.ok(md.includes('**68.6**'), 'Markdown 关键数值未加粗');
  assert.ok(/^- \[ \] /m.test(md), 'Markdown 跟踪清单未用 GFM 复选框');
  const txt = toPlainText(REP_DATA, {});
  assert.ok(txt.includes('[ ] 能否守住正轴'), '纯文本复选框未降级为 [ ]');
});

