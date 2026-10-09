// 报告「出厂质检」引擎单测（src/report_audit.js）
//
// 测试重心在**负向**：审计引擎的价值不在于「好报告能通过」（那是必然的），
// 而在于「坏报告一定过不去」。所以每一项检查都要有一个"故意弄坏"的用例，
// 否则这道闸门就是个装饰。
//
// 为什么这些用例必须存在：闸门一旦有漏判，用户就会看到一份**没验过**的坏报告，
// 而页面上还挂着"✓ 已通过质检"——比没有闸门更糟（给了虚假的安全感）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditReport, isAuditPass, auditSummary, RULES, AUDIT_VERSION, EXPECTED_SECTIONS, MASTHEAD } from '../src/report_audit.js';
import { toStandaloneHtml, toMarkdown, toPlainText } from '../src/report.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 构造一份「合规」的结构化报告（模拟 parseReport 的输出） ──────────────────
// 章节标题保持 buildBrief 的真实形态（带历史圆形序号前缀）——
// 导出层要负责把它翻成公文的「一、」，这正是要验的翻译链路，不能提前替它做掉。
const secTitles = ['① 情绪定位', '② 资金面', '③ 盈亏效应', '④ 广度与量能', '⑤ 题材结构', '⑥ 综合研判'];
function goodRep() {
  return {
    meta: '数据日期 2026-09-30 · 样本 33 个交易日',
    abstract: '情绪 62.3 落于中性区｜建议仓位 60%｜🔴短板在题材结构',
    sections: secTitles.map((t, i) => ({
      id: `bfsec${i + 1}`,
      title: t,
      lines: i === 3
        // 第④段带连板天梯表格（模板②要求表格）
        ? [{ kind: 'li', text: '量能 **1.02 万亿**' },
           { kind: 'table', head: ['板数', '只数', '个股'], rows: [['5板', '1', 'A']], caption: '连板天梯' }]
        : [{ kind: 'li', text: `第${i + 1}段正文 **62.3**` }],
      caliber: `第${i + 1}段口径：七因子加权。`,
    })),
    appendix: { title: '📚 口径附录', body: '全报告统一口径 ……' },
    foot: null,
  };
}

/**
 * 三种形态的「合规」样本**从真引擎现生成**，不手抄。
 *
 * 为什么必须现生成（这是本项目踩过的坑）：
 *   手抄的 fixture 等于第二套口径——版式一旦调整（比如这次从「网页文档」改成「公文」），
 *   手抄样本还停留在旧形态，测试要么假通过、要么报一堆与实现无关的假失败，
 *   两种结果都会掩盖真问题。现生成的样本天然跟随实现，审计项要与它脱节都难。
 *   而"实现本身坏了"由另一层负责：test/report.test.mjs 用**字面量**断言版式常量。
 */
const goodOpts = (rep = goodRep()) => {
  const o = { dataDate: '2026-09-30', generatedAt: '2026-10-01 17:00', issueNo: 3 };
  return { rootEl: null, md: toMarkdown(rep, o), txt: toPlainText(rep, o), html: toStandaloneHtml(rep, o) };
};

/**
 * 一份**完整合规**的样本（三种形态都补齐跟踪项复选框）。
 * 正向用例必须都走它——只补一半（比如只给 md 补、不给 html 补）会造成
 * 「这条用例过、那条用例挂」的假象，排查成本全花在 fixture 上。
 */
function fullSample() {
  const rep = goodRep();
  const opts = goodOpts(rep);
  opts.md += '\n- [ ] 观察封板率是否站稳 80%\n';
  opts.html += '\n<ul class="todo"><li><span class="cb">☐</span>观察封板率</li></ul>\n';
  return { rep, opts };
}

// ────────────────────────── 正向：合规报告必须全通过 ──────────────────────────

test('正向：合规报告全部检查项通过', () => {
  const { rep, opts } = fullSample();
  const r = auditReport(rep, opts);
  assert.equal(r.pass, true, '失败项：' + JSON.stringify(r.failed));
  assert.equal(r.total, RULES.length);
  assert.equal(r.passed, r.total);
  assert.equal(r.failed.length, 0);
});

test('正向：auditSummary 在通过时给出「通过 N/N 项」', () => {
  const { rep, opts } = fullSample();
  const r = auditReport(rep, opts);
  assert.match(auditSummary(r), /^通过 \d+\/\d+ 项$/);
});

test('正向：isAuditPass 与 auditReport().pass 一致', () => {
  const { rep, opts } = fullSample();
  assert.equal(isAuditPass(rep, opts), true);
  assert.equal(isAuditPass({ sections: [] }, {}), false);
});

test('契约：期望章节数是人工声明的常量（若从 DOM 数，缺段永远自洽、永远发现不了）', () => {
  assert.equal(EXPECTED_SECTIONS, 6);
  // 源码里必须是字面量常量，不能是「数出来」的
  const src = readFileSync(path.join(ROOT, 'src', 'report_audit.js'), 'utf8');
  assert.match(src, /export const EXPECTED_SECTIONS = 6;/);
});

// ────────────────────────── 负向：每种破坏都必须被拦下 ──────────────────────────
// 辅助：跑审计并断言「某 id 必须失败」
function mustFail(mutate, ruleId) {
  const rep = goodRep();
  const opts = goodOpts();
  mutate(rep, opts);
  const r = auditReport(rep, opts);
  assert.equal(r.pass, false, `期望被拦下但通过了（应触发 ${ruleId}）`);
  const hit = r.failed.find((f) => f.id === ruleId);
  assert.ok(hit, `应触发 ${ruleId}，实际失败项：${r.failed.map((f) => f.id).join('、')}`);
  assert.ok(hit.reason && hit.reason.trim(), `${ruleId} 必须给出可读原因`);
  return hit;
}

test('负向①：摘要缺失 → abstract-present 拦下', () => {
  mustFail((rep) => { rep.abstract = ''; }, 'abstract-present');
});

test('负向②：章节只有 5 段（少一段）→ sections-count 拦下并报出实际段数', () => {
  const hit = mustFail((rep) => { rep.sections = rep.sections.slice(0, 5); }, 'sections-count');
  assert.match(hit.reason, /5/);
});

test('负向③：某段缺口径折叠件 → caliber-per-section 拦下', () => {
  mustFail((rep) => { rep.sections[4].caliber = ''; }, 'caliber-per-section');
});

test('负向④：连板天梯被摊平成文字（无表格）→ ladder-is-table 拦下', () => {
  mustFail((rep) => {
    rep.sections = rep.sections.map((s) => ({
      ...s,
      lines: s.lines.filter((l) => l.kind !== 'table'),
    }));
  }, 'ladder-is-table');
});

test('负向⑤：表格是空壳（无表头/无数据行）→ ladder-is-table 拦下', () => {
  mustFail((rep) => {
    for (const s of rep.sections) {
      for (const l of s.lines) if (l.kind === 'table') { l.head = []; l.rows = []; }
    }
  }, 'ladder-is-table');
});

test('负向⑥：文末独立附录缺失 → appendix-present 拦下', () => {
  mustFail((rep) => { rep.appendix = null; }, 'appendix-present');
});

test('负向⑦：Markdown 跟踪项不是 GFM 复选框（写成普通列表）→ todo-gfm-in-md 拦下', () => {
  mustFail((rep, opts) => { opts.md = opts.md.replace('- [ ] ', '- '); }, 'todo-gfm-in-md');
});

test('负向⑧：Markdown <details> 不配对 → details-paired 拦下并报出个数', () => {
  const hit = mustFail((rep, opts) => { opts.md = opts.md.replace('</details>', ''); }, 'details-paired');
  assert.match(hit.reason, /3 个.*2 个|<details>/);
});

test('负向⑨：结尾缺免责声明（三形态都缺）→ disclaimer 拦下', () => {
  mustFail((rep, opts) => {
    opts.md = opts.md.replace(/非投资建议/g, '仅供参考');
    opts.txt = opts.txt.replace(/非投资建议/g, '仅供参考');
    opts.html = opts.html.replace('免责声明', '说明');
  }, 'disclaimer');
});

test('负向⑩：结尾缺导出时间 → generated-at 拦下', () => {
  mustFail((rep, opts) => {
    opts.md = opts.md.replace(/导出时间：.*/, '');
    opts.txt = opts.txt.replace(/导出时间：.*/, '');
  }, 'generated-at');
});

test('负向⑪：三档配色标记丢失（🔴/🟢 都没有）→ markers 拦下', () => {
  mustFail((rep, opts) => {
    opts.md = opts.md.replace(/🔴|🟢/g, '');
    opts.txt = opts.txt.replace(/🔴|🟢/g, '');
    opts.html = opts.html.replace(/🔴|🟢/g, '');
  }, 'markers');
});

test('负向⑫：出现越界投资建议措辞 → compliance 拦下', () => {
  const hit = mustFail((rep, opts) => {
    opts.md += '\n本票明日必涨，建议满仓买入。';
  }, 'compliance-no-recompute');
  assert.match(hit.reason, /必涨/);
});

test('负向⑬：关键数值丢失加粗 → key-bold 拦下', () => {
  mustFail((rep, opts) => { opts.md = opts.md.replace(/\*\*[^*]+\*\*/g, ''); }, 'key-bold');
});

test('负向⑭：某段只剩标题（正文为空）→ sections-nonempty 拦下', () => {
  mustFail((rep) => { rep.sections[2].lines = []; }, 'sections-nonempty');
});

test('负向⑮：章节标题为空 → sections-titled 拦下', () => {
  mustFail((rep) => { rep.sections[1].title = ''; }, 'sections-titled');
});

// ────────────────────────── 边界与稳健性 ──────────────────────────

test('边界：rep 为 null / undefined 时不抛异常，且判为未通过', () => {
  for (const bad of [null, undefined]) {
    const r = auditReport(bad, {});
    assert.equal(r.pass, false);
    assert.ok(r.failed.length > 0);
  }
});

test('边界：审计项自身抛异常 → 按失败处理并说明原因（不放行）', () => {
  // 传一个会让规则内部炸掉的 rootEl（querySelector 抛错），
  // abstract-first 规则会走到 DOM 分支；这里用 Proxy 强制抛错
  const evil = new Proxy({}, { get() { throw new Error('boom'); } });
  const { opts } = fullSample();
  const r = auditReport(goodRep(), { ...opts, rootEl: evil });
  assert.equal(r.pass, false, '审计工具坏了必须按失败处理，不能放行');
  assert.ok(r.failed.some((f) => /审计项异常/.test(f.reason)));
});

test('边界：无 md/txt/html 时，纯结构类检查仍生效（不因缺产物而放行）', () => {
  const rep = goodRep();
  rep.appendix = null;
  const r = auditReport(rep, {});
  assert.equal(r.pass, false);
  assert.ok(r.failed.some((f) => f.id === 'appendix-present'));
});

test('契约：每一条规则都有唯一 id 与可读 msg', () => {
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'rule id 必须唯一');
  for (const r of RULES) {
    assert.ok(r.id && /^[a-z][a-z0-9-]*$/.test(r.id), `id 命名不规范：${r.id}`);
    assert.ok(r.msg && r.msg.length >= 6, `${r.id} 的 msg 太短，用户读不懂`);
    assert.equal(typeof r.run, 'function');
  }
});

test('契约：审计版本号存在（规则变更后要能一眼看出是哪一版判的）', () => {
  assert.match(AUDIT_VERSION, /^report-audit-v\d+$/);
  assert.equal(auditReport(goodRep(), goodOpts()).version, AUDIT_VERSION);
});

test('契约：审计引擎是纯函数——同一输入跑两次结果完全一致（无隐藏状态）', () => {
  const a = auditReport(goodRep(), goodOpts());
  const b = auditReport(goodRep(), goodOpts());
  assert.deepEqual(a.checks, b.checks);
});

test('契约：审计引擎不引入任何指标计算（只校验结构，不重算数据）', () => {
  const src = readFileSync(path.join(ROOT, 'src', 'report_audit.js'), 'utf8');
  const code = src.split('\n').filter((ln) => !/^\s*(\/\/|\*|\/\*)/.test(ln)).join('\n');
  for (const re of [/Math\.tanh/, /scoreEmotion|scorePnl|scoreTheme|scoreBreadth/, /clamp100/, /weights\s*\./]) {
    assert.doesNotMatch(code, re, `审计引擎不得重算指标：${re}`);
  }
});
