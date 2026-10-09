// 公文体例守卫的**负向注入验证**（把守卫自己当作被测对象）
//
// 为什么需要这个脚本（这是本项目的教训）：
//   「有一条守卫」不等于「守卫拦得住」。守卫最容易犯的错是**参照物拿错**——
//   断言看起来在查 A，实际命中的是无关的 B，于是永远为真。
//   本项目已经踩过三次（见 scripts/audit_lhb_caliber.mjs 里人工复核门槛那段的长注释）。
//   所以公文体例的每一条守卫，都必须能被一段**故意改坏的源码**触发。
//
// 做法：把 src/report.js 逐条改坏一次 → 跑口径守卫 → 断言「那条守卫失败了」→ 还原。
// 改坏用的是**真实源码字符串替换**，替换失败（字符串没找到）会当成「注入未生效」报出来，
// 而不是静默算通过——否则「替换没命中」会被误读成「守卫很强」。
//
// 用法：node scripts/verify_doc_spec_guards.mjs
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const F = 'src/report.js';
const BAK = 'src/report.js.negbak';
const NODE = process.execPath;

if (!existsSync(F)) { console.error(`找不到 ${F}`); process.exit(1); }
copyFileSync(F, BAK);
const orig = readFileSync(BAK, 'utf8');

/**
 * 每条：名称 + 破坏源码的函数 + 期望被哪条守卫的标题片段拦下。
 * 期望值用的是守卫**标题里的特征词**，改守卫文案时这里要一起改
 * （这是刻意的摩擦：文案变了说明守卫语义可能也变了，值得人看一眼）。
 */
const cases = [
  ['页边距改错（上 37mm → 30mm）',
    (s) => s.replace("top: '37mm'", "top: '30mm'"), '页边距'],
  ['@page 边距顺序写错（左右互换）',
    (s) => s.replace('${DOC_SPEC.page.top} ${DOC_SPEC.page.right} ${DOC_SPEC.page.bottom} ${DOC_SPEC.page.left}',
      '${DOC_SPEC.page.top} ${DOC_SPEC.page.left} ${DOC_SPEC.page.bottom} ${DOC_SPEC.page.right}'), '上 右 下 左'],
  ['字号阶梯改错（正文 16pt → 15pt）',
    (s) => s.replace("body: '16pt'", "body: '15pt'"), '字号阶梯'],
  ['CSS 手抄字号字面量（绕过 DOC_SPEC）',
    (s) => s.replace('font-family: ${DOC_SPEC.family.fs}; font-size: ${DOC_SPEC.font.body}; line-height: 1.7;',
      'font-family: ${DOC_SPEC.family.fs}; font-size: 16px; line-height: 1.7;'), '手抄的 pt/px 字面量'],
  ['丢小标宋跨平台兜底',
    (s) => s.replace('xbs: \'"方正小标宋简体", "STZhongsong", "华文中宋", "SimSun", serif\'', "xbs: 'SimSun, serif'"), '字体族'],
  ['一级标题字体族与层级不符（黑体 → 仿宋）',
    (s) => s.replace('${DOC_SPEC.family.hei}', '${DOC_SPEC.family.fs}'), '序号字体跟着层级走'],
  ['CSS 手抄字体名（绕过 DOC_SPEC.family）',
    (s) => s.replace('font-family: ${DOC_SPEC.family.fs}; font-size: ${DOC_SPEC.font.body}; line-height: 1.7;',
      'font-family: SimSun, serif; font-size: ${DOC_SPEC.font.body}; line-height: 1.7;'), '手抄字体名'],
  ['六角括号改回方括号',
    (s) => s.replace("bracket: ['〔', '〕']", "bracket: ['[', ']']"), '六角括号'],
  ['日期不补零（2026-9-3）',
    (s) => s.replace("String(+m[2]).padStart(2, '0')", 'String(+m[2])')
      .replace("String(+m[3]).padStart(2, '0')", 'String(+m[3])'), 'docDate'],
  ['落款不右空四字',
    (s) => s.replace('padding-right: ${DOC_SPEC.dateRightChars}em', 'padding-right: 0'), '右空四字'],
  ['页码只留单页（删掉 :left 镜像）',
    (s) => s.replace('@page :left { @bottom-left { content: counter(page); font-family: ${DOC_SPEC.family.fs}; font-size: ${DOC_SPEC.font.page}; } }\n', ''), '双页'],
  ['正文缩进改用 padding（回行不再顶格）',
    (s) => s.replace('.sec li { text-indent: 2em;', '.sec li { padding-left: 2em;'), 'text-indent'],
  ['附表标题不居中',
    (s) => s.replace('.tbl-cap { margin: 3mm 0 1mm; text-align: center;', '.tbl-cap { margin: 3mm 0 1mm; text-align: left;'), '表格标题未居中'],
];

const run = (file) => {
  try {
    return execFileSync(NODE, [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return String(e.stdout || '') + String(e.stderr || '');
  }
};

let caught = 0;
const problems = [];
try {
  for (const [name, mutate, expect] of cases) {
    const broken = mutate(orig);
    if (broken === orig) {
      problems.push(`${name} —— 注入未生效（替换目标字符串没找到，用例本身要修）`);
      continue;
    }
    writeFileSync(F, broken);
    const out = run('scripts/audit_lhb_caliber.mjs');
    const fails = out.split('\n').filter((l) => l.startsWith('✗'));
    const hit = fails.find((l) => l.includes(expect));
    if (hit) {
      caught += 1;
      console.log(`✓ 拦下：${name}\n    ${hit.trim().slice(0, 120)}`);
    } else {
      problems.push(`${name} —— 期望含「${expect}」，实际失败行：${fails.join(' | ') || '（无失败行，守卫放行了！）'}`);
    }
  }
} finally {
  // ⚠ 无论如何都要还原：这个脚本是"把源码改坏再跑"的，中途抛异常会把坏源码留在工作区
  writeFileSync(F, orig);
  unlinkSync(BAK);
}

console.log(`\n[verify-doc-spec-guards] 负向注入 ${caught}/${cases.length} 被拦下`);
if (problems.length) {
  console.error('以下注入未被拦下（守卫有洞，或注入用例本身失效）：');
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log('公文体例守卫全部经得起负向注入。');
