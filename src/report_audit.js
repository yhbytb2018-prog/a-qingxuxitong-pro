// 研判报告「出厂质检」引擎（唯一来源）
//
// 为什么需要这一层：
//   报告的屏幕渲染（app.js::buildBrief）与导出（src/report.js）已共用同一份 DOM，
//   但「结构是否正确」此前只靠**事后**跑测试脚本（scripts/check_frontend.mjs、
//   scripts/audit_lhb_caliber.mjs）来保证——那是 CI 里的事，用户当场看到的报告
//   可能是坏的（缺摘要、少一段、口径折叠件没挂上，甚至指标被重算过）。
//
//   本模块把「测试脚本事后检查」变成「渲染前当场把关」：
//   先构建 → 审计 → 通过才写入 #briefBody。不通过就不渲染，用户看不到坏报告。
//
// 设计纪律（与 src/report.js 一致）：
//   · 纯函数、零依赖、ESM —— Node 单测与浏览器共用同一份判据，不写两遍。
//   · **只读**：本模块绝不修改报告数据、指标、阈值，只做结构校验与「数字可回溯」比对。
//   · 失败必须给出可读的人话原因（id + 说明 + 期望/实际），而不是一句 "audit failed"。
//
// 与 report.js 的关系：report.js 负责「DOM → 三种形态的翻译」，本模块负责
// 「翻译出来的东西是否还符合用户给定的模板契约」。两者都不重算指标。

/** 审计引擎版本（审计规则变了要能一眼看出是哪一版判的） */
export const AUDIT_VERSION = 'report-audit-v2';

/**
 * 用户给定的模板契约里「固定几大章节」。
 * 数字写在这里而不是从 DOM 数出来——若从 DOM 数，少一段时光看数字永远"自洽"，
 * 就永远发现不了缺段。**必须**是人工声明的期望值，才能当判据。
 * 历史：原为 7（含「⑦ 模拟交易复盘」）；模拟交易台面下线后改为 6，第⑦段不再渲染。
 */
export const EXPECTED_SECTIONS = 6;

/** 报头名称（与 src/report.js 的 REPORT_TITLE 同值，防漂移） */
export const MASTHEAD = 'A股市场情绪研判简报';

/**
 * 章节口径折叠件的统一标题——**屏幕**用（与 src/report.js 的 CALIBER_SUMMARY 同值，防漂移）。
 *
 * ★ 注意屏幕与导出**刻意不同值**：屏幕说「点击展开查看口径」（真的能点），
 *   导出/打印稿说「口径说明（附）」（静态文档里"点击"是一句做不到的邀请）。
 *   本常量只管屏幕；导出那边用 report.js 的 CALIBER_SUMMARY_DOC。
 *   两者都必须含"口径"二字（下面 caliber-summary-text 规则靠它确认语义没被换掉）。
 */
export const CALIBER_SUMMARY = '🔍 点击展开查看口径';

/**
 * 公文体例的四条硬性注意（用户给定），逐条落成**可机检**的结构判据：
 *   ① 年份编号用六角括号〔〕；
 *   ② 生成日期为阿拉伯数字全年月日、不编虚位；
 *   ③ 正文序号不能混用（一、后面不能直接跟 1.）；
 *   ④ 关键指标数值加粗 / 风险提示前置 ⚠ / 跟踪清单用复选框 [ ]。
 * 前三条在导出 HTML 上按**结构**判（查的是真实渲染出来的 DOM 片段，不是模板源码），
 * 第四条在 Markdown 上判（GFM 复选框是最容易在重构中丢掉的形态）。
 */
const CJK_L1 = /^(一|二|三|四|五|六|七|八|九|十)、/;   // 一、
const CJK_L2 = /^（(一|二|三|四|五|六|七|八|九|十)）/; // （一）
const ARABIC_L3 = /^\d+\.\s/;                        // 1.
const ARABIC_L4 = /^（\d+）/;                         // （1）

/**
 * 从导出 HTML 里按文档顺序抽出所有标题文字（h2.h1 / h3.h2）。
 * 判「序号是否混用」必须看**相邻两级**的关系，所以要把顺序保留下来。
 */
function headingTexts(html) {
  const out = [];
  const re = /<h([23])\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/h\1>/g;
  let m;
  while ((m = re.exec(html))) {
    const text = m[3].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    out.push({ level: m[1] === '2' ? 1 : 2, text });
  }
  return out;
}

export const RULES = [
  {
    id: 'abstract-present',
    msg: '报告开头缺【极简摘要】（模板①：一句话总结核心）',
    run: (c) => !!(c.rep && c.rep.abstract && c.rep.abstract.trim()),
  },
  {
    id: 'abstract-first',
    msg: '【极简摘要】不在报告最前面（模板①要求置于开头）',
    // 在屏幕 DOM 上按文档顺序比较：摘要节点必须早于第一个 .bf-sec
    run: (c) => {
      if (!c.rootEl || !c.rootEl.querySelector) return true; // 无 DOM 时不判（Node 侧只测结构）
      const abs = c.rootEl.querySelector('.bf-abstract');
      const firstSec = c.rootEl.querySelector('.bf-sec');
      if (!abs || !firstSec) return true;
      // compareDocumentPosition: 4 = DOCUMENT_POSITION_FOLLOWING（abs 在 firstSec 之前）
      return !!(abs.compareDocumentPosition(firstSec) & 4);
    },
  },
  {
    id: 'sections-count',
    msg: `章节数不等于 ${EXPECTED_SECTIONS}（模板②：固定 ${EXPECTED_SECTIONS} 大章节）`,
    run: (c) => {
      const n = (c.rep && c.rep.sections ? c.rep.sections.length : 0);
      return n === EXPECTED_SECTIONS ? true : `实际 ${n} 段`;
    },
  },
  {
    id: 'sections-titled',
    msg: '存在没有标题的章节',
    run: (c) => {
      const bad = (c.rep.sections || []).filter((s) => !s.title || !s.title.trim());
      return bad.length === 0 ? true : `第 ${bad.map((s) => s.id || '?').join('、')} 段标题为空`;
    },
  },
  {
    id: 'sections-nonempty',
    msg: '存在没有任何正文行与表格的章节（只剩标题）',
    run: (c) => {
      const bad = (c.rep.sections || []).filter((s) => !(s.lines || []).length);
      return bad.length === 0 ? true : `第 ${bad.map((s) => s.id || '?').join('、')} 段为空`;
    },
  },
  {
    id: 'caliber-per-section',
    msg: `并非每段都挂了口径折叠件（模板③：每章节一个「${CALIBER_SUMMARY}」）`,
    run: (c) => {
      const secs = c.rep.sections || [];
      const bad = secs.filter((s) => !s.caliber || !s.caliber.trim());
      return bad.length === 0 ? true
        : `${bad.length}/${secs.length} 段缺口径件（第 ${bad.map((s) => s.id || '?').join('、')} 段）`;
    },
  },
  {
    id: 'caliber-summary-text',
    // 注意本规则查的是**屏幕** DOM（#briefBody 下的 .bf-sec .bf-caliber summary），
    // 故判据是屏幕串 CALIBER_SUMMARY。导出侧用的是 report.js 的 CALIBER_SUMMARY_DOC，
    // 两者**刻意不同**（屏幕说"点击展开"，静态文档说"口径说明"），由 audit_lhb_caliber 的
    // 模板契约块反向锁死"必须不同"。所以这里不能写"屏幕与导出必须一致"——那句话现在是错的。
    msg: `屏幕口径折叠件标题不是「${CALIBER_SUMMARY}」`,
    // 判据来源：优先用调用方**在 parseReport 之前**采好的 domCaliberSummaries 快照。
    // 原因：parseReport 会就地移除 .bf-caliber（防口径混进正文），之后 DOM 上就查不到了——
    // 若这时才查，会把一份合规报告误判为未通过。没有快照时才退回实时查询
    // （单测里传的是未被 parseReport 动过的容器，直接查也是对的）。
    run: (c) => {
      let sums = c.domCaliberSummaries;
      if (!Array.isArray(sums)) {
        if (!c.rootEl || !c.rootEl.querySelectorAll) return true;
        sums = [...c.rootEl.querySelectorAll('.bf-sec .bf-caliber summary')]
          .map((s) => s.textContent.trim());
      }
      if (!sums.length) return '屏幕 DOM 里找不到章节口径折叠件';
      const bad = sums.filter((s) => s !== CALIBER_SUMMARY);
      return bad.length === 0 ? true : `${bad.length} 个折叠件标题不符（如「${bad[0]}」）`;
    },
  },
  {
    id: 'ladder-is-table',
    msg: '连板天梯不是表格（模板②：连板天梯用表格）',
    run: (c) => {
      const tbl = (c.rep.sections || [])
        .flatMap((s) => s.lines || [])
        .filter((l) => l.kind === 'table');
      if (!tbl.length) return '整份报告没有任何表格，连板天梯疑似被摊平成文字';
      // 表格必须有表头与至少一行数据，否则是个空壳
      const bad = tbl.filter((t) => !(t.head || []).length || !(t.rows || []).length);
      return bad.length === 0 ? true : `${bad.length} 个表格缺表头或数据行`;
    },
  },
  {
    id: 'todo-checklist',
    msg: '明日跟踪项不是复选框清单（模板④）',
    run: (c) => {
      // 同 caliber-summary-text：优先用 parseReport 前采的快照，避免被就地移除影响。
      const total = Number.isInteger(c.domTodoCount)
        ? c.domTodoCount
        : (c.rootEl && c.rootEl.querySelectorAll ? c.rootEl.querySelectorAll('.bf-todo').length : null);
      if (total === null) return true;
      if (!total) return '屏幕上找不到任何 .bf-todo 跟踪项';
      // 必须有 aria-checked 才是"复选框"，不是普通 div
      const bad = Number.isInteger(c.domTodoAriaCount)
        ? total - c.domTodoAriaCount
        : [...c.rootEl.querySelectorAll('.bf-todo')].filter((t) => !t.hasAttribute('aria-checked')).length;
      return bad === 0 ? true : `${bad} 个跟踪项缺 aria-checked（不是可勾选项）`;
    },
  },
  {
    id: 'todo-gfm-in-md',
    msg: 'Markdown 里的跟踪项不是 GFM 复选框语法 - [ ]（模板④/⑤）',
    run: (c) => {
      if (!c.md) return true;
      if (!/^\- \[ \] /m.test(c.md)) return 'Markdown 未见 - [ ] 行';
      return true;
    },
  },
  {
    id: 'key-bold',
    msg: '关键数值没有加粗（模板④：关键数值加粗）',
    run: (c) => {
      if (!c.md) return true;
      const n = (c.md.match(/\*\*[^*]+\*\*/g) || []).length;
      return n >= 5 ? true : `Markdown 中加粗片段仅 ${n} 处（<5，疑似丢失强调）`;
    },
  },
  {
    id: 'details-paired',
    msg: 'Markdown 里 <details> 标签不配对（折叠件会渲染错乱）',
    run: (c) => {
      if (!c.md) return true;
      const open = (c.md.match(/<details>/g) || []).length;
      const close = (c.md.match(/<\/details>/g) || []).length;
      return open === close ? true : `<details> ${open} 个 / </details> ${close} 个`;
    },
  },
  {
    id: 'appendix-present',
    msg: '缺文末独立折叠附录（模板③：汇总全部口径）',
    run: (c) => {
      if (!c.rep.appendix) return '结构化报告无 appendix';
      // 快照优先（与其它 DOM 检查同一纪律）；无快照时退回实时查询
      if (c.domAppendix === false) return '屏幕 DOM 里找不到 .bf-appendix';
      if (c.domAppendix === undefined && c.rootEl && c.rootEl.querySelector
        && !c.rootEl.querySelector('.bf-appendix')) {
        return '屏幕 DOM 里找不到 .bf-appendix';
      }
      return true;
    },
  },
  {
    id: 'appendix-in-md',
    msg: 'Markdown 里找不到口径附录折叠件',
    run: (c) => {
      if (!c.md) return true;
      // 附录在 Markdown 里紧跟分隔线，且是最后一个 details 块
      const i = c.md.lastIndexOf('<details>');
      return i >= 0 ? true : 'Markdown 无 <details> 块';
    },
  },
  {
    id: 'disclaimer',
    msg: '报告结尾缺免责声明（模板⑤）',
    run: (c) => {
      const md = c.md || '', txt = c.txt || '', html = c.html || '';
      const hit = /非投资建议|不构成任何投资建议/.test(md)
        && /非投资建议|不构成任何投资建议/.test(txt)
        && /免责声明/.test(html);
      return hit ? true : 'md/txt/html 至少一种形态缺免责声明';
    },
  },
  {
    id: 'generated-at',
    msg: '报告结尾缺导出时间（模板⑤）',
    run: (c) => {
      const hasAt = (s) => /导出时间：\s*\d{4}-\d{2}-\d{2}/.test(s || '');
      return (hasAt(c.md) && hasAt(c.txt)) ? true : 'Markdown/纯文本未同时带导出时间';
    },
  },
  {
    id: 'markers',
    msg: '三档配色标记未落地（模板④：🔴风险/🟢积极/⚫中性）',
    /**
     * 判据为什么这么写：
     *   三档标记是**数据驱动**的——由 buildBrief 按当日实际结论决定挂哪一档
     *   （档位过热/清仓→🔴、满仓→🟢、半仓→⚫）。所以「某个标记没出现」不等于
     *   「模板没落地」，可能只是当日没触发那个档位（例：情绪温和时不会有 🔴 风险项）。
     *
     *   要区分这两种情况，只能看**语义结构**而非字符：
     *     · 屏幕侧：.ico-risk / .ico-pos / .ico-neutral 三个 class 体系是否齐备
     *       （CSS 与渲染函数都在，说明模板落地了，只是数据没用满三档）；
     *     · 导出侧：[[risk:]] 这类标记语法能被翻译成 emoji（report.js 的 MARKERS 表存在）。
     *   因此本项检查的是「三档机制在位」，而不是「今日恰好出现了三个 emoji」。
     */
    run: (c) => {
      // 导出层：三档映射表必须存在（report.js 的 MARKERS）
      const hasMarkerTable = c.markerKinds
        ? ['risk', 'pos', 'neutral'].every((k) => c.markerKinds.includes(k))
        : true; // 无快照时不判（单测环境的 md/txt 由 fixture 提供）
      if (!hasMarkerTable) return '三档标记映射表不完整（导出层缺 risk/pos/neutral）';
      // 屏幕层：三档 class 必须都定义在样式里（否则某一档渲染出来没颜色 = 模板没落地）
      if (c.hasMarkerClasses === false) return '屏幕缺三档配色 class（.ico-risk/.ico-pos/.ico-neutral）';
      // 当日实际出现的标记数量：0 个才算异常（说明渲染函数根本没挂标记）
      const src = [c.md, c.txt, c.html].filter(Boolean).join('\n');
      if (src) {
        const n = ['🔴', '🟢', '⚫'].filter((m) => src.includes(m)).length;
        if (n === 0) return '三种形态里都找不到任何配色标记（渲染函数疑似未挂标记）';
      }
      return true;
    },
  },
  {
    id: 'compliance-no-recompute',
    msg: '报告出现「仅供参考」以外的投资建议式措辞（合规守卫）',
    run: (c) => {
      const src = [c.md, c.txt].filter(Boolean).join('\n');
      if (!src) return true;
      // 只拦"保证收益/必涨/稳赚"这类越界措辞；合规的免责声明本身含"非投资建议"不算违规
      const BAN = /(保证收益|稳赚不赔|必涨|一定会上涨|包赚)/;
      const m = src.match(BAN);
      return m ? `出现越界措辞「${m[1]}」` : true;
    },
  },

  // ── 公文体例（用户给定「A股市场研究分析简报 · 报告标准格式」）─────────────
  // 这一组的意义：公文格式是**规范**，不是"好看就行"。规范一旦被重构改掉，
  // 报告就不再是公文了。所以每条硬性注意都有对应的机检项。
  {
    id: 'doc-masthead',
    msg: `报头缺简报名称「${MASTHEAD}」（公文硬规定）`,
    run: (c) => {
      if (!c.html) return true;
      // 判真实渲染出的报头元素，而不是源码里有没有这个字符串
      const m = c.html.match(/<p class="masthead">([\s\S]*?)<\/p>/);
      if (!m) return '导出文档里找不到 .masthead 报头';
      const text = m[1].replace(/<[^>]*>/g, '').trim();
      return text === MASTHEAD ? true : `报头名称是「${text}」，应为「${MASTHEAD}」`;
    },
  },
  {
    id: 'doc-serial-right',
    msg: '简报编号未居右或无六角括号年份〔YYYY〕（公文硬规定）',
    run: (c) => {
      if (!c.html) return true;
      const m = c.html.match(/<p class="serial">([\s\S]*?)<\/p>/);
      if (!m) return '导出文档里找不到 .serial 简报编号';
      const text = m[1].replace(/<[^>]*>/g, '').trim();
      // 六角括号是 U+3014 / U+3015，不是方括号——这是最容易被"顺手改成 [ ]"的地方
      if (!/〔\d{4}〕/.test(text)) return `编号「${text}」缺六角括号年份`;
      // 「居右」由 CSS 的 text-align:right 承载；这里断言那条规则真的挂着 .serial
      if (!/\.doc-head \.serial\s*\{[^}]*text-align:\s*right/.test(c.html)) return '编号未声明居右';
      return true;
    },
  },
  {
    id: 'doc-date-arabic',
    msg: '生成日期不是阿拉伯数字全年月日（公文硬规定：不编虚位、不用汉字数字）',
    run: (c) => {
      if (!c.html) return true;
      const m = c.html.match(/<p class="sign-date">([\s\S]*?)<\/p>/);
      if (!m) return '导出文档里找不到 .sign-date 生成日期落款';
      const text = m[1].replace(/<[^>]*>/g, '').trim();
      // 必须形如 2026-09-30：四位年 + 两位月 + 两位日（不编虚位＝不写成 2026-9-30）
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return `日期「${text}」不是 YYYY-MM-DD 形态`;
      if (/[一二三四五六七八九十〇]/.test(text)) return `日期「${text}」用了汉字数字`;
      // 「右空四字」
      if (!/\.sign-date\s*\{[^}]*padding-right:\s*4em/.test(c.html)) return '日期未声明右空四字';
      return true;
    },
  },
  {
    id: 'doc-numbering-order',
    msg: '正文层级序号混用（公文硬规定：一、→（一）→ 1.→（1），不得跳级）',
    run: (c) => {
      if (!c.html) return true;
      const hs = headingTexts(c.html);
      if (!hs.length) return '导出文档里找不到任何层级标题';
      // ① 一级标题必须清一色「一、」形态，二级必须清一色「（一）」形态：
      //    混用(等级内混)本身就是最常见的错法，先拦掉。
      const badL1 = hs.filter((h) => h.level === 1 && !CJK_L1.test(h.text));
      if (badL1.length) return `一级标题不是「一、」形态：${badL1[0].text}`;
      const badL2 = hs.filter((h) => h.level === 2 && !CJK_L2.test(h.text));
      if (badL2.length) return `二级标题不是「（一）」形态：${badL2[0].text}`;
      // ② 跨级：一级标题后**直接**跟阿拉伯数字「1.」＝跳级（缺「（一）」这一层）
      for (let i = 0; i < hs.length; i++) {
        if (hs[i].level !== 1) continue;
        const nxt = hs[i + 1];
        if (nxt && (ARABIC_L3.test(nxt.text) || ARABIC_L4.test(nxt.text))) {
          return `「${hs[i].text}」的下一级直接是「${nxt.text}」（跳过了「（一）」这一层）`;
        }
      }
      return true;
    },
  },
  {
    id: 'doc-numbering-single',
    msg: '同一标题出现双序号（如「一、① 情绪定位」），序号被叠加了',
    run: (c) => {
      if (!c.html) return true;
      const hs = headingTexts(c.html);
      const bad = hs.filter((h) => (h.text.match(/^[一二三四五六七八九十]+、/g) || []).length > 1
        || /^[一二三四五六七八九十]+、\s*[①②③④⑤⑥⑦⑧⑨⑩]/.test(h.text)
        || /^[①②③④⑤⑥⑦⑧⑨⑩]/.test(h.text));
      return bad.length === 0 ? true : `标题序号叠加：${bad[0].text}`;
    },
  },
  {
    id: 'doc-page-margin',
    msg: '版心页边距不符公文体例（上 37 / 下 35 / 左 28 / 右 26 mm）',
    run: (c) => {
      if (!c.html) return true;
      // @page 简写顺序：top right bottom left —— A4 公文的标准写法
      return /@page\s*\{[^}]*size:\s*A4[^}]*margin:\s*37mm\s+26mm\s+35mm\s+28mm/.test(c.html)
        ? true : '导出文档的 @page 边距不是「上37 右26 下35 左28」';
    },
  },
  {
    id: 'doc-font-ladder',
    msg: '公文字号阶梯不完整（报头/主标题 2 号、摘要 3 号楷体、正文 3 号仿宋、页码 4 号）',
    run: (c) => {
      if (!c.html) return true;
      const need = [
        [/\.doc-head \.masthead\s*\{[^}]*font-size:\s*22pt/, '报头未用 2 号（22pt）'],
        [/\.doc-title\s*\{[^}]*font-size:\s*22pt/, '主标题未用 2 号（22pt）'],
        [/\.doc-abstract\s*\{[^}]*font-size:\s*16pt/, '摘要栏未用 3 号（16pt）'],
        [/\.doc-body\s*\{[^}]*font-size:\s*16pt/, '正文未用 3 号（16pt）'],
        [/@page :right\s*\{\s*@bottom-right\s*\{[^}]*font-size:\s*14pt/, '页码未用 4 号（14pt）'],
      ];
      const bad = need.filter(([re]) => !re.test(c.html));
      return bad.length === 0 ? true : bad.map(([, m]) => m).join('；');
    },
  },
  {
    id: 'doc-font-family',
    msg: '公文未使用规定字体族（小标宋 / 黑体 / 楷体 / 仿宋）',
    run: (c) => {
      if (!c.html) return true;
      const need = [
        [/\.doc-head \.masthead\s*\{[^}]*font-family:[^;}]*STZhongsong/, '报头未用小标宋'],
        [/\.sec h2\.h1\s*\{[^}]*font-family:[^;}]*SimHei/, '一级标题未用黑体'],
        [/\.sec h3\.h2\s*\{[^}]*font-family:[^;}]*KaiTi/, '二级标题未用楷体'],
        [/\.doc-body\s*\{[^}]*font-family:[^;}]*FangSong/, '正文未用仿宋'],
      ];
      const bad = need.filter(([re]) => !re.test(c.html));
      return bad.length === 0 ? true : bad.map(([, m]) => m).join('；');
    },
  },
  {
    id: 'doc-page-number',
    msg: '页码规则缺失（单页右放 @page :right / 双页左放 @page :left）',
    run: (c) => {
      if (!c.html) return true;
      const right = /@page :right\s*\{\s*@bottom-right\s*\{\s*content:\s*counter\(page\)/.test(c.html);
      const left = /@page :left\s*\{\s*@bottom-left\s*\{\s*content:\s*counter\(page\)/.test(c.html);
      if (!right || !left) return `单页右放=${right} 双页左放=${left}`;
      return true;
    },
  },
  {
    id: 'doc-title-indent',
    msg: '正文/摘要未左空 2 字符（text-indent: 2em）',
    run: (c) => {
      if (!c.html) return true;
      const need = [
        [/\.doc-abstract\s*\{[^}]*text-indent:\s*2em/, '摘要栏未左空 2 字符'],
        [/\.sec li\s*\{[^}]*text-indent:\s*2em/, '正文行未左空 2 字符'],
        [/\.sec h2\.h1\s*\{[^}]*text-indent:\s*2em/, '一级标题未左空 2 字符'],
      ];
      const bad = need.filter(([re]) => !re.test(c.html));
      return bad.length === 0 ? true : bad.map(([, m]) => m).join('；');
    },
  },
  {
    id: 'doc-table-caption-centered',
    msg: '附表标题未在表格上方居中（公文硬规定）',
    run: (c) => {
      if (!c.html) return true;
      if (!/\.tbl-cap\s*\{[^}]*text-align:\s*center/.test(c.html)) return '表格标题未居中';
      // 「在表格上方」：caption 必须出现在 <table 之前（按文档顺序）
      const iCap = c.html.indexOf('class="tbl-cap"');
      const iTbl = c.html.indexOf('<table class="rep-tbl"');
      if (iCap >= 0 && iTbl >= 0 && iCap > iTbl) return '表格标题跑到了表格下方';
      return true;
    },
  },
  {
    id: 'doc-checklist-brackets',
    msg: '跟踪清单未用复选框 [ ]（公文硬规定）',
    run: (c) => {
      if (!c.md) return true;
      if (!/^\- \[ \] /m.test(c.md)) return 'Markdown 未见 - [ ] 复选框行';
      if (!c.html) return true;
      return /<span class="cb">☐<\/span>/.test(c.html) ? true : '导出 HTML 未见 ☐ 复选框占位';
    },
  },
];

/**
 * 主入口：对一份报告跑全部审计。
 *
 * @param {object} rep       parseReport() 的结构化结果
 * @param {object} [opts]
 * @param {Element} [opts.rootEl] 屏幕上的报告容器（#briefBody），用于校验 DOM 侧结构
 * @param {string}  [opts.md]     toMarkdown() 产物
 * @param {string}  [opts.txt]    toPlainText() 产物
 * @param {string}  [opts.html]   toStandaloneHtml() 产物
 * @returns {{ pass:boolean, total:number, passed:number, failed:Array<{id:string,msg:string,reason:string}>, checks:Array, version:string }}
 */
export function auditReport(rep, opts = {}) {
  const ctx = {
    rep: rep || { sections: [] },
    rootEl: opts.rootEl || null,
    md: opts.md || '',
    txt: opts.txt || '',
    html: opts.html || '',
  };
  const checks = [];
  for (const rule of RULES) {
    let ok, reason = '';
    try {
      const r = rule.run(ctx);
      if (r === true || r === undefined || r === null) { ok = true; }
      else { ok = false; reason = typeof r === 'string' ? r : rule.msg; }
    } catch (e) {
      // 审计项自己抛异常不能把审计搞挂——按失败处理并如实报原因
      ok = false;
      reason = `审计项异常：${String(e && e.message || e)}`;
    }
    checks.push({ id: rule.id, msg: rule.msg, ok, reason: ok ? '' : reason });
  }
  const failed = checks.filter((c) => !c.ok);
  return {
    pass: failed.length === 0,
    total: checks.length,
    passed: checks.length - failed.length,
    failed,
    checks,
    version: AUDIT_VERSION,
  };
}

/**
 * 便捷判定：只关心过没过。
 * @returns {boolean}
 */
export function isAuditPass(rep, opts) {
  return auditReport(rep, opts).pass;
}

/**
 * 把审计结果整理成一行摘要（状态条用）。
 * 例：`通过 18/18 项` / `未通过 2/18 项 · 缺文末独立折叠附录`
 */
export function auditSummary(result) {
  if (!result) return '未审计';
  if (result.pass) return `通过 ${result.passed}/${result.total} 项`;
  const first = result.failed[0];
  const more = result.failed.length > 1 ? ` 等 ${result.failed.length} 项` : '';
  return `未通过 ${result.passed}/${result.total} 项 · ${first ? first.reason : ''}${more}`;
}
