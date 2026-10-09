// 研判报告导出引擎（唯一来源）
//
// 为什么放在 src/ 而不是写在 app.js 里：
//   报告的「屏幕渲染」与「导出文档」必须是同一份内容——如果导出另写一套字符串拼接，
//   两边的数字/口径迟早漂移。所以这里不重新计算任何指标，只做一件事：
//   把**屏幕上真实渲染出来的那份 DOM**（#briefBody 的 .bf-sec 结构）翻译成
//   纯文本 / Markdown / 独立 HTML 三种形态。用户看到的即导出的。
//
// 纯函数为主（除 parseReport 需要 DOM 之外，其余都收结构化数据），Node 与浏览器共用，
// 便于单元测试直接在 Node 里跑断言。

export const REPORT_VERSION = 'report-v3';

/** 报告文档的标题与署名（正式文档需要，屏幕上被页面标题代替） */
export const REPORT_TITLE = 'A股市场情绪研判简报';
export const REPORT_ORG = 'A股情绪系统 · PRO';

// ────────────────────── 公文体例：排版规格（唯一出处） ──────────────────────
//
// 为什么把版式写成**常量**而不是直接字面量写进 CSS：
//   公文格式（页边距、字号阶梯、序号体系、字体族）是**规范**，不是审美偏好——
//   规范会被引用、被切面校验（守卫脚本要按行切到「摘要栏」去查它的字号），
//   也会被导出文档与屏幕共用。一旦有人把 16pt 手改成 15pt，单测要能说得清是哪个常量错了。
//   故：**所有版式数值只有一个来源 = DOC_SPEC**，CSS 与 DOM 都从这里取。
//
// 注意这是**排版层**常量，与指标无关——本文件仍然不重算任何指标（见文件头纪律）。
//
// 字号口径：2号 ≈ 22pt，3号 ≈ 16pt，4号 ≈ 14pt（公文常用对照）。
// 字体族按「Windows 公文标准字体优先、跨平台有兜底」排列：
//   小标宋 = 方正小标宋简体（Windows 多不带，故并列 STZhongsong / 华文中宋 / SimSun 兜底）
//   黑体 = SimHei，楷体 = KaiTi，仿宋 = FangSong。
// 浏览器到导出时一律回落到系统已装字体，**不做字体嵌入**（离线自包含是硬约束）。
export const DOC_SPEC = {
  version: 'gb-brief-v1',
  /** 整体：A4 纸与页边距（上 37 / 下 35 / 左 28 / 右 26，单位 mm） */
  page: { size: 'A4', w: '210mm', h: '297mm', top: '37mm', bottom: '35mm', left: '28mm', right: '26mm' },
  /** 字号阶梯：与公文体例一一对应（pt） */
  font: { h1: '22pt', abstract: '16pt', body: '16pt', table: '16pt', page: '14pt', note: '14pt' },
  /** 字体族 */
  family: {
    xbs: '"方正小标宋简体", "STZhongsong", "华文中宋", "SimSun", serif',
    hei: '"SimHei", "Microsoft YaHei", sans-serif',
    kai: '"KaiTi", "Kaiti SC", "STKaiti", serif',
    fs: '"FangSong", "FangSong_GB2312", "STFangsong", "SimSun", serif',
  },
  /** 标题最多排版成几行（超过就压成一行，梯形/菱形排布的行数是有限的） */
  titleMaxLines: 4,
  /** 正文「左空 2 字符」= 首行缩进 2 字（回行顶格是缩进的天然结果，无需另设） */
  indentChars: 2,
  /** 落款日期「右空四字」 */
  dateRightChars: 4,
  /** 层次序号体系：一、（黑体）→（一）（楷体）→ 1.（仿宋）→（1）（仿宋） */
  numbering: {
    level1: 'cn',      // 中文数字 + 顿号
    level2: 'cnPar',   // 中文数字 + 全角括号
    level3: 'arabic',  // 阿拉伯数字 + 半角点
    level4: 'arabicPar',
    family: ['hei', 'kai', 'fs', 'fs'],
  },
  /** 公告年份编号用六角括号（U+3014 / U+3015），不是方括号 —— 公文硬规定 */
  bracket: ['〔', '〕'],
  /** 页码：4 号半角阿拉伯数字，居版心下边缘之下、版心之外，单页右放、双页左放 */
  pageNo: { family: 'fs', single: 'right', double: 'left', showTotal: false },
};

/** 六角括号包裹的文本（年份编号等）—— 唯一出处，禁止各处手写 〔〕 */
export const cnBracket = (s) => DOC_SPEC.bracket[0] + String(s == null ? '' : s) + DOC_SPEC.bracket[1];

/** 阿拉伯数字写全年月日，不编虚位（如 2026-09-30）；非法输入原样返回，不编造日期 */
export function docDate(text) {
  const m = String(text == null ? '' : text).match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return String(text == null ? '' : text);
  return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
}

/** 中文数字（正文一级/二级序号用；报告 7 段以内，够用且不必引入大数转换） */
const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const cnNum = (n) => (n <= 10 ? CN_NUM[n] : String(n));

/**
 * 一级标题的序号标记：`一、`（黑体）。
 * 章节自带 `① 情绪定位…` 这类历史前缀时先摘掉，避免「一、① 情绪定位」双序号。
 */
export function h1Mark(index1) {
  return `${cnNum(index1)}、`;
}

/** 二级标题的序号标记：`（一）`（楷体） */
export const h2Mark = (index2) => `（${cnNum(index2)}）`;
/** 三级标题标记：`1.`（仿宋） */
export const h3Mark = (index3) => `${index3}.`;
/** 四级标题标记：`（1）`（仿宋） */
export const h4Mark = (index4) => `（${index4}）`;

/**
 * 正文层级序号：**固定顺序** 一、→（一）→ 1.→（1）。
 *
 * 为什么做成函数而不是各处手写字符串：用户给的四条硬性注意里有一条是
 * 「正文序号不能混用：一、后面不能直接跟 1.」——这是**跨行**的约束，
 * 光看一行文本发现不了。把层级选择收敛到一处，才能被守卫脚本按行校验。
 * 层级语义：'cn' → 一、｜'cnPar' →（一）｜'arabic' → 1.｜'arabicPar' →（1）
 */
export function sectionNo(level, index) {
  if (level === 'cn' || level === 'cnPar') {
    return level === 'cn' ? h1Mark(index) : h2Mark(index);
  }
  if (level === 'arabic' || level === 'arabicPar') {
    return level === 'arabic' ? h3Mark(index) : h4Mark(index);
  }
  return h1Mark(index); // 未声明层级时按一级处理，不抛异常（报告不该因为版式参数崩掉）
}

/** 章节标题里残留的历史圆形序号（①②③…）——导出前摘掉，避免与「一、」并存 */
const stripOldNo = (s) => String(s || '').replace(/^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫]\s*/, '');

/**
 * 台阶式换行：章节标题过长时按标点断行，**绝不拆断词语**。
 *
 * 规则（宁可行短，不可拆词）：
 *   ① 中文标点（、，；：）后是天然断点；
 *   ② 全角括号/引号后**不**断（断了会把「（核心因子·25%）」拆成两行）；
 *   ③ 单行仍超长时才退回「等分台阶」——此为最后手段，且只按字符等分，
 *      仍然不插入任何连字符或空格。**注意**：无标点的长串（如「资金面（龙虎榜），参与打分…」，
 *      整段只有一个中文逗号）在中文里没有真正无歧义的断点，此时只能按字符切，
 *      切点仍落在字与字之间、不插入任何符号，属可接受的排版近似。
 */
export function foldTitle(text, max = DOC_SPEC.titleMaxLines, lineLen = 18) {
  const chars = [...stripOldNo(String(text || ''))];
  if (chars.length <= lineLen) return [chars.join('')];

  const lines = [];
  let cur = [];
  for (let i = 0; i < chars.length; i++) {
    cur.push(chars[i]);
    // 在标点处断行，但排除开括号/开引号后的位置（断了会拆散「『情绪定位』」这类词组）
    const isBreak = '、，；：'.includes(chars[i])
      || (chars[i] === '·' && /[\u4e00-\u9fa5]/.test(chars[i + 1] || ''))
      || (chars[i] === '）' && cur.length >= 8);
    if (isBreak && chars.length - i - 1 > 2 && lines.length < max - 1) {
      lines.push(cur.join(''));
      cur = [];
    }
  }
  if (cur.length) lines.push(cur.join(''));

  // 断点太少（整句无标点）时才退回等分台阶；能被标点切开的绝不做等分
  if (lines.length < 2) {
    const per = Math.ceil(chars.length / Math.min(max, Math.ceil(chars.length / lineLen)));
    const eq = [];
    for (let i = 0; i < chars.length; i += per) eq.push(chars.slice(i, i + per).join(''));
    return eq;
  }
  return lines;
}

/** 章节标题的显示文本（去掉序号前缀与历史圆形序号，序号由版式层统一加） */
export function sectionTitle(secTitle) {
  return stripOldNo(String(secTitle || ''))
    // 「一、」这类序号若已由屏幕层写进标题，同样摘掉，防止双序号
    .replace(/^[一二三四五六七八九十]+、\s*/, '');
}

/** 章节口径折叠件的统一标题——**屏幕**用（.bf-caliber 的 <summary>）。模板规定，屏幕必须用它。 */
export const CALIBER_SUMMARY = '🔍 点击展开查看口径';

/**
 * 章节口径折叠件的标题——**导出文档/打印稿**用。
 *
 * 为什么不与屏幕共用同一个串：屏幕上的字面是「点击展开查看口径」，那是一个**真能点的**
 * 交互提示（<details> 确实可展开）。但导出的 .html/.md 是拿去发邮件、进知识库、直接
 * 打印成 PDF 的：在纸面或静态文档里"点击展开"是一句**做不到的邀请**——读者找不到可点的
 * 东西，只会以为是文档坏了。所以导出侧改用不带动作词的静态标签，只说明这一段是什么。
 *
 * 保留「口径」二字是刻意的：审计规则 caliber-summary-text 依赖它来确认折叠件语义没被换掉。
 */
export const CALIBER_SUMMARY_DOC = '📎 口径说明（附）';

/**
 * 三档"配色标记"（模板预留）：
 *   风险 🔴 / 积极 🟢 / 中性 ⚫
 * 语义由**数据驱动**——由 buildBrief 在生成文本时决定挂哪一档，导出层只负责把
 * `[[risk:文字]]` 这类标记翻成对应形态（屏幕已有 .ico-* 类时不重复处理）。
 */
export const MARKERS = { risk: '🔴', pos: '🟢', neutral: '⚫' };

// ────────────────────────── 解析 DOM → 结构化 ──────────────────────────

/**
 * 把 #briefBody 的 DOM 解析成结构化报告。
 * 只认这几类节点（与 buildBrief 的输出严格对应）：
 *   .bf-meta      数据落款条
 *   .bf-abstract  极简摘要（一句话核心结论）
 *   .bf-sec       段落（.bf-h 标题 + .bf-body 正文；段内可含 .bf-caliber 口径折叠件）
 *   .bf-appendix  文末独立折叠附录（汇总全部口径）
 *   .bf-foot      其他非折叠口径备注（历史形态，保留兼容）
 * 段落正文里：.bf-li 是一行，.bf-h.bf-h2 是段内小标题，
 *             .bf-todo 是待办清单项（复选框），.bf-table 是表格（连板天梯）。
 * 保留加粗（<b>）与色调（.bf-up/.bf-dn/.bf-warn/.muted），其余标签一律丢弃——
 * 导出文档只该有「正文 + 强调」，不该带页面上的交互性包裹。
 */
export function parseReport(rootEl) {
  if (!rootEl) return { meta: null, abstract: null, sections: [], appendix: null, foot: null };

  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  // 原文里「⚠」出现的位置很不整齐：有的连续两个（页面用两个容器强调）、
  // 有的紧贴在数字/单位后面（「+5.04亿⚠ （独立新股）」）。
  // 导出给外人看的文档不能带这种排版噪音，统一规范成「句首一个 ⚠ + 空格」。
  const tidyWarn = (s) => s
    // 连续多个 ⚠（含中间空白）合并成一个——页面里常见「⚠ ⚠」叠着的写法
    .replace(/(?:⚠\s*){2,}/g, '⚠ ')
    // 紧贴前后文字的 ⚠（「+5.04亿⚠ （独立新股）」）两侧补空格，避免和数字/单位粘在一起
    .replace(/([^\s（【「『])⚠/g, '$1 ⚠')
    .replace(/⚠([^\s，。；：、）】」』！？])/g, '⚠ $1')
    .replace(/([（【「『])\s+/g, '$1')         // 开括号后的空格是排版噪音
    .replace(/\s{2,}/g, ' ')
    .trim();

  // 递归把节点转成「带标记的纯文本」，保留 b/strong（粗）、i/em（斜体）与语义色，
  // 其余标签只取文字（br 转空格避免粘字）。
  const inline = (node) => {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += n.nodeValue; continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (tag === 'br') { out += ' '; continue; }
      const inner = inline(n);
      const cls = n.className || '';
      if (tag === 'b' || tag === 'strong') out += `**${clean(inner)}**`;
      else if (/\bbf-up\b/.test(cls)) out += `【涨】${clean(inner)}`;
      else if (/\bbf-dn\b/.test(cls)) out += `【跌】${clean(inner)}`;
      else if (/\bbf-warn\b/.test(cls)) out += `⚠ ${clean(inner)}`;
      else if (/\bmuted\b/.test(cls)) out += clean(inner);
      else out += inner;
    }
    return out;
  };

  const metaEl = rootEl.querySelector('.bf-meta');
  const meta = metaEl ? clean(inline(metaEl).replace(/\*\*/g, '')) : null;

  // 极简摘要（模板①）：报告开头的「一句话核心」。取内层 .bf-ab-text 的文本，
  // 无内层时退化为整块文本——两种写法都能解析，避免屏幕侧改结构就解析不出来。
  const absEl = rootEl.querySelector('.bf-abstract');
  const abstract = absEl
    ? clean(inline(absEl.querySelector('.bf-ab-text') || absEl).replace(/\*\*/g, ''))
    : null;

  /**
   * 从任意容器抽「行」：.bf-li 是正文行、.bf-h2 是段内小标题、.bf-todo 是待办项、
   * .bf-table 是表格。**只遍历直接子节点**，保持行的粒度（口语：一行是一行）。
   * 表格单独作为 { kind:'table', head, rows } 返回，导出层负责渲染成真表格，
   * 不做「表格摊平成一行文字」那种丢结构的降级。
   *
   * ★ 表格被 .bf-li 包住时也要认出来（真实 bug 的修复）：
   *   页面侧的写法有两种——`sec3` 的连板天梯是**裸传**（.bf-body 的直接子就是 .bf-table），
   *   而 `sec4` 的板块相对强弱原先写成 `li(head + table)`，表格落在 .bf-li **里面**。
   *   只认直接子的话，后者会掉进 `kind:'li'` 分支，被 inline() 摊平成
   *   「超额进攻（前 5）涨跌幅超额攻0↑+1.00%…」这样一坨无结构文本——
   *   表格在导出文档里**整块消失**，只剩一串粘在一起的表头与数字。
   *   故这里再探一层：.bf-li 内部若恰有一个 .bf-table，按表格处理（行内其余文字忽略，
   *   因为那本就是表格的标题行，仍在页面上以 .bf-li 形式单独存在）。
   */
  const extractLines = (bodyEl) => {
    const lines = [];
    if (!bodyEl) return lines;
    for (const child of bodyEl.children) {
      const cls = child.className || '';
      // 直接子就是表格，或 .bf-li 里恰好只有一个表格（后者是历史写法，兼容之）
      const tblEl = /\bbf-table\b/.test(cls)
        ? child
        : (/\bbf-li\b/.test(cls) && child.querySelectorAll('.bf-table').length === 1
          ? child.querySelector('.bf-table') : null);
      if (tblEl) {
        const head = [...tblEl.querySelectorAll('thead th, thead td')].map((th) => clean(th.textContent));
        const rows = [...tblEl.querySelectorAll('tbody tr')].map((tr) =>
          [...tr.children].map((td) => tidyWarn(clean(inline(td)))));
        lines.push({ kind: 'table', head, rows, caption: clean(tblEl.getAttribute('data-caption') || '') });
      } else if (/\bbf-todo\b/.test(cls)) {
        lines.push({ kind: 'todo', text: tidyWarn(clean(inline(child))) });
      } else if (/\bbf-li\b/.test(cls)) {
        lines.push({ kind: 'li', text: tidyWarn(clean(inline(child))) });
      } else if (/\bbf-h2\b/.test(cls)) {
        // 段内小标题（（一）级）。与一级标题同理：**只用内容 span 的文字**，
        // 否则会把版式层刚加的「（一）」当成标题的一部分，导致导出的序号变成「（一）（一）…」。
        const inner = child.querySelector('.bf-sec-t') || child.querySelector('.bf-h-t');
        lines.push({ kind: 'sub', text: clean((inner || child).textContent) });
      }
    }
    return lines;
  };

  const sections = [];
  for (const sec of rootEl.querySelectorAll('.bf-sec')) {
    const h = sec.querySelector('.bf-h');
    // ⚠ 只取**内容 span**（.bf-sec-t / .bf-h-t）的文字，不能取整个 .bf-h 的 textContent：
    // 屏幕层现在把序号「一、」放在独立的 .bf-sec-no 里，取整块就会把序号带进标题，
    // 导出时再补一次「一、」→ 变成「一、一、情绪定位」。没有内容 span 时才退回整块
    // （兼容旧结构 / 单测里手写的 fixture）。
    const inner = h && (h.querySelector('.bf-sec-t') || h.querySelector('.bf-h-t'));
    const title = h ? clean((inner || h).textContent) : '';
    // 口径折叠件（模板③）：默认收起，导出时同样渲染为 <details>（纯文本形态平铺 + [口径] 前缀）。
    // 必须从 body 里"摘"出来，否则 extractLines 会把它当成一个不可识别的 div 丢掉。
    const calEl = sec.querySelector('.bf-caliber');
    const calBody = calEl ? calEl.querySelector('.bf-cal-body') : null;
    const caliber = calBody ? tidyWarn(clean(inline(calBody))) : null;
    if (calEl) calEl.remove();

    const lines = extractLines(sec.querySelector('.bf-body'));
    sections.push({ id: sec.id || '', title, lines, caliber });
  }

  // 文末独立折叠附录（模板③）：汇总全部口径。与段落口径一样，导出时是 <details>。
  const appxEl = rootEl.querySelector('.bf-appendix');
  const appxBody = appxEl ? appxEl.querySelector('.bf-cal-body') : null;
  const appendix = appxEl
    ? { title: clean(appxEl.querySelector('summary')?.textContent || '口径附录'),
        body: appxBody ? clean(inline(appxBody)) : clean(inline(appxEl)) }
    : null;

  // 兼容历史形态：若没有独立附录，仍认 .bf-foot（旧报告的写法）
  const footEl = rootEl.querySelector('.bf-foot:not(.bf-appendix)');
  const foot = footEl ? clean(inline(footEl).replace(/\*\*/g, '')) : null;

  return { meta, abstract, sections, appendix, foot };
}

// ────────────────────────── 三种输出形态 ──────────────────────────

/**
 * 纯文本 / Markdown 用的「去标记」：把文本里的标记词还原成人类可读的形态。
 *   **粗体** → 粗体（Markdown 保留 **，纯文本去掉）
 *   【涨】+1.2 → ↑+1.2 ；【跌】-1.8 → ↓-1.8（箭头比中文标记词更短、更直观）
 *   ⚠ 原样保留（是内容的一部分，不是排版标记）
 *   [[risk:文字]] / [[pos:文字]] / [[neutral:文字]] → 配色标记（Markdown 保留，纯文本保留 emoji）
 * 这些标记词只用于「屏幕 DOM → 结构化数据」的中间表示，不该泄漏到最终产物里。
 */
const stripMark = (s, keepBold = false) => String(s || '')
  .replace(/【涨】\s*/g, '↑')
  .replace(/【跌】\s*/g, '↓')
  // 配色标记：[[risk:文字]] → 🔴文字（三档统一在此落地，屏幕不用 emoji 时也能导出）
  .replace(/\[\[(risk|pos|neutral):([^\]]*)\]\]/g, (_, k, t) => MARKERS[k] + t)
  .replace(/\*\*([^*]+)\*\*/g, keepBold ? '**$1**' : '$1');

/**
 * 纯文本：复制到微信/邮件/记事本可直接读，不含任何标记。
 *
 * 降级说明：纯文本**渲染不了** <details> 折叠（没有可点开的东西），
 * 所以口径在这里一律**平铺**输出并加 `[口径]` 前缀——宁可多几行，也不丢信息。
 * 这与「默认收起、只展示指标」的屏幕体验不一致，是形态限制下的取舍，属预期。
 */
export function toPlainText(rep, opts = {}) {
  const { dataDate = '', generatedAt = '', issueNo = 1 } = opts;
  const L = [];
  // 报头（简报名称 + 编号）→ 与导出文档同一体例：纯文本也认得出这是一份「简报」
  L.push(REPORT_TITLE);
  const serial = briefSerial(dataDate, issueNo);
  if (serial) L.push(serial);
  if (dataDate) L.push(`数据日期：${docDate(dataDate)}`);
  L.push('');
  if (rep.abstract) { L.push(`【摘要】${stripMark(rep.abstract)}`); L.push(''); }
  if (rep.meta) { L.push(rep.meta); L.push(''); }
  rep.sections.forEach((sec, i) => {
    // 层次序号：一、（（一）在段内递进）——纯文本同样遵守，不能因为没有样式就丢掉层级
    L.push(`${sectionNo('cn', i + 1)}${sectionTitle(sec.title)}`);
    let subNo = 0;
    for (const ln of sec.lines) {
      if (ln.kind === 'sub') { subNo += 1; L.push(`  ${sectionNo('cnPar', subNo)}${sectionTitle(ln.text)}`); }
      else if (ln.kind === 'todo') L.push(`  [ ] ${stripMark(ln.text)}`);
      else if (ln.kind === 'table') {
        // 表格在纯文本里用「｜」分隔的对齐列，保留结构与逐只可核性
        if (ln.caption) L.push(`  ${ln.caption}`);
        if (ln.head.length) L.push('  ' + ln.head.join(' ｜ '));
        for (const r of ln.rows) L.push('  ' + r.map((c) => stripMark(c)).join(' ｜ '));
      } else L.push(`  · ${stripMark(ln.text)}`);
    }
    if (sec.caliber) L.push(`  [口径] ${stripMark(sec.caliber)}`);
    L.push('');
  });
  // 文末独立附录：纯文本里同样平铺（无折叠可用），保留 [口径] 前缀以便检索
  if (rep.appendix) {
    L.push(`【${stripMark(rep.appendix.title)}】`);
    L.push(`[口径] ${stripMark(rep.appendix.body)}`);
    L.push('');
  }
  if (rep.foot) { L.push('口径备注'); L.push(stripMark(rep.foot)); L.push(''); }
  L.push(`本简报由 ${REPORT_ORG} 规则引擎自动生成，数据来源于公开行情接口，仅供研究参考，非投资建议。`);
  // 落款：生成日期（阿拉伯数字写全年月日，不编虚位）
  if (dataDate) L.push(docDate(dataDate));
  if (generatedAt) L.push(`导出时间：${generatedAt}`);
  return L.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** Markdown 里的表格单元格：竖线与换行必须转义，否则列会串位 */
const mdCell = (s) => stripMark(s, true).replace(/\|/g, '\\|').replace(/\n+/g, ' ');

/**
 * Markdown：可直接粘进文档系统/知识库，结构与屏幕一致。
 *
 * 模板要求「输出 Markdown，支持网页渲染折叠标签」——Markdown 本身允许内嵌 HTML，
 * 而 `<details>` 是**HTML 原生**折叠件（无需脚本），GitHub / 语雀 / Notion / 飞书等
 * 主流渲染器都支持，所以这里直接用 `<details>` 承载口径，而不是把口径藏起来或全平铺。
 * 明日观测用 GFM 任务列表语法 `- [ ]`，在支持的编辑器里可直接勾选。
 */
export function toMarkdown(rep, opts = {}) {
  const { dataDate = '', generatedAt = '', issueNo = 1 } = opts;
  const L = [];
  // 报头：简报名称 + 编号（编号居右 → Markdown 里用行尾对齐语义表达「居右」）
  L.push(`# ${REPORT_TITLE}`);
  L.push('');
  const serial = briefSerial(dataDate, issueNo);
  if (serial) { L.push(`<p align="right">${serial}</p>`); L.push(''); }
  if (dataDate) L.push(`**数据日期**：${docDate(dataDate)}　　**生成方式**：规则引擎自动生成`);
  L.push('');
  // 摘要栏（模板①：一句话核心）
  if (rep.abstract) {
    L.push(`> **【摘要】** ${stripMark(rep.abstract, true)}`);
    L.push('');
  }
  if (rep.meta) { L.push(`> ${rep.meta.replace(/\|/g, '\\|')}`); L.push(''); }

  // 固定章节：正文只放指标，口径一律收进 <details>
  // 层次序号与导出文档同一体系：一、→（一）→ 1.，Markdown 的 # 层级与之一一对应
  rep.sections.forEach((sec, i) => {
    L.push(`## ${sectionNo('cn', i + 1)}${sectionTitle(sec.title)}`);
    L.push('');
    let subNo = 0;
    for (const ln of sec.lines) {
      if (ln.kind === 'sub') { subNo += 1; L.push(`### ${sectionNo('cnPar', subNo)}${sectionTitle(ln.text)}`); L.push(''); }
      else if (ln.kind === 'todo') { L.push(`- [ ] ${stripMark(ln.text, true)}`); }
      else if (ln.kind === 'table') {
        if (ln.caption) { L.push(`**${mdCell(ln.caption)}**`); L.push(''); }
        if (ln.head.length) {
          L.push(`| ${ln.head.map(mdCell).join(' | ')} |`);
          L.push(`| ${ln.head.map(() => '---').join(' | ')} |`);
        }
        for (const r of ln.rows) L.push(`| ${r.map(mdCell).join(' | ')} |`);
        L.push('');
      } else L.push(`- ${stripMark(ln.text, true)}`);
    }
    // 每章节口径折叠件（默认收起，仅展示指标）
    if (sec.caliber) {
      L.push('');
      L.push(`<details>`);
      L.push(`<summary>${CALIBER_SUMMARY_DOC}</summary>`);
      L.push('');
      L.push(stripMark(sec.caliber, true));
      L.push('');
      L.push(`</details>`);
    }
    L.push('');
  });

  // ③ 文末独立折叠附录：汇总全部口径
  if (rep.appendix) {
    L.push('---');
    L.push('');
    L.push('<details>');
    L.push(`<summary>${stripMark(rep.appendix.title, true)}</summary>`);
    L.push('');
    L.push(stripMark(rep.appendix.body, true));
    L.push('');
    L.push('</details>');
    L.push('');
  }
  // 兼容历史形态的口径备注
  if (rep.foot) {
    L.push('---'); L.push('');
    L.push('<details>');
    L.push(`<summary>${CALIBER_SUMMARY_DOC}（备注）</summary>`);
    L.push('');
    L.push(rep.foot);
    L.push('');
    L.push('</details>');
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push(`> 本简报由 ${REPORT_ORG} 规则引擎自动生成，数据来源于公开行情接口，仅供研究参考，**非投资建议**。`);
  // 落款：生成日期（阿拉伯数字写全年月日，不编虚位，右空四字 → Markdown 用行尾对齐表达）
  if (dataDate) L.push(`<p align="right">${docDate(dataDate)}</p>`);
  if (generatedAt) L.push(`> 导出时间：${generatedAt}`);
  L.push('');
  return L.join('\n');
}

const escHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * 行内标记 → HTML。
 * 顺序很关键：**先转义**（报告文本里的 < > 不能变成真标签，防注入），**再**把标记词换成标签。
 *
 * 三种标记各自需要一个明确的收尾边界，不能开一个 span 就撒手：
 *   · **文字** → 显式成对，直接闭合
 *   · 【涨】+1.2 / 【跌】-1.8 → 颜色只该覆盖这个数字，故用「数字串」做闭合边界
 *     （涨跌值形如 +6.0 / -1.8 / 0.00，可能带正负号与小数点）
 *   · ⚠（可能是连续的「⚠ ⚠」）→ 挂在后随那句话上，闭合到标点或行尾
 */
function inlineToHtml(raw) {
  let s = escHtml(raw);
  // 1) 粗体：成对闭合
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  // 2) 配色标记（模板④预留）：[[risk:文字]] → 带 🔴 的语义 span。
  //    注意顺序：必须在粗体之后（标记内可能含 **），且在三类标记之后（标记内可能含涨跌数字）。
  s = s.replace(/\[\[(risk|pos|neutral):([^\]]*)\]\]/g,
    (_, k, t) => `<span class="ico ico-${k}">${MARKERS[k]} ${t}</span>`);
  // 3) 涨跌：数字串整体着色。【涨】/【跌】前面可能什么都没有，后面必须紧跟数字
  s = s.replace(/【涨】\s*([+-]?[\d,.]+%?)/g, '<span class="chg"><i>▲</i> $1</span>');
  s = s.replace(/【跌】\s*([+-]?[\d,.]+%?)/g, '<span class="chg chg-dn"><i>▼</i> $1</span>');
  // 4) 警示：连续多个 ⚠ 合并成一个，闭合到该句结束（标点 / 行尾）
  s = s.replace(/(?:⚠\s*)+([^。；;]*)(?=[。；;]|$)/g, '<span class="warn">⚠ $1</span>');
  return s;
}

/**
 * 独立完整的 HTML 文档：**自包含**（内联样式、无外部依赖、无脚本），
 * 符合正式报告排版（标题页眉 / 数据落款 / 极简摘要 / 编号章节 / 口径折叠附录 / 免责声明），
 * A4 打印就绪（@page 边距、避免段落内断页、表头重复）。
 *
 * 关于「无脚本」：这不是为了省事，而是导出文档要能被邮件客户端、旧浏览器、PDF 打印器、
 * 甚至纯文本查看器安全打开。`<details>` 恰好是唯一**无需脚本**的原生折叠元素，
 * 故模板要求的折叠件在这里用 `<details>` 实现，而不是引入 JS。
 * 打印时用 CSS 强制展开全部 `<details>`（折叠着打出来会缺内容）。
 */
/**
 * 简报编号（报头右上）：`〔2026〕第 3 号`。
 *   · 年份一律**六角括号**（公文硬规定，见 DOC_SPEC.bracket）；
 *   · 期号由调用方给定（app.js 从全部交易日推算），缺省为 1，不编造；
 *   · **不写死任何具体年份**——年份从数据日期现取，报告每年都能用。
 */
export function briefSerial(dataDate, issueNo) {
  const y = (String(dataDate || '').match(/\d{4}/) || [])[0] || '';
  if (!y) return '';
  const n = Number.isFinite(+issueNo) && +issueNo > 0 ? +issueNo : 1;
  return `${cnBracket(y)}第 ${n} 号`;
}

/**
 * 独立完整的 HTML 文档：**自包含**（内联样式、无外部依赖、无脚本），
 * 按**党政机关公文体例**排版（报头 / 主标题 / 摘要栏 / 层次序号正文 / 附表 / 页码 / 落款），
 * A4 打印就绪（精确页边距、避免段落内断页、表头重复）。
 *
 * 版式的每一个数值都取自 DOC_SPEC（唯一出处），本函数不写字面量——
 * 想改页边距/字号，改 DOC_SPEC，屏幕与导出一起变，守卫脚本也按同一份常量校验。
 *
 * 关于「无脚本」：这不是为了省事，而是导出文档要能被邮件客户端、旧浏览器、PDF 打印器、
 * 甚至纯文本查看器安全打开。`<details>` 恰好是唯一**无需脚本**的原生折叠元素，
 * 故模板要求的折叠件在这里用 `<details>` 实现，而不是引入 JS。
 * 打印时用 CSS 强制展开全部 `<details>`（折叠着打出来会缺内容）。
 */
export function toStandaloneHtml(rep, opts = {}) {
  const { dataDate = '', generatedAt = '', url = '', issueNo = 1 } = opts;
  const css = STANDALONE_CSS;
  const body = [];

  // ── 报头：简报名称（2 号小标宋，居中）+ 简报编号（居右） ──
  body.push(`<header class="doc-head">`);
  body.push(`<p class="serial">${escHtml(briefSerial(dataDate, issueNo))}</p>`);
  body.push(`<p class="masthead">${escHtml(REPORT_TITLE)}</p>`);
  body.push(`</header>`);

  // ── 主体：主标题（2 号小标宋，居中，多行梯形/菱形、不拆断词语） ──
  const titleLines = foldTitle(REPORT_ORG);
  body.push(`<h1 class="doc-title" data-line-count="${titleLines.length}">`
    + titleLines.map((l) => `<span class="t-line">${escHtml(l)}</span>`).join('')
    + `</h1>`);

  // ── 摘要栏：标题下空一行，3 号楷体，左空 2 字符（只放极简核心摘要） ──
  if (rep.abstract) {
    body.push(`<p class="doc-abstract"><span class="abs-lead">〔摘要〕</span>${inlineToHtml(rep.abstract)}</p>`);
  }
  // 数据落款条：属于「生成依据」而非摘要内容，字号同 4 号，不占摘要栏
  if (rep.meta) body.push(`<p class="doc-meta">${escHtml(rep.meta)}</p>`);

  // ── 正文：3 号仿宋，每段左空 2 字符、回行顶格 ──
  body.push(`<main class="doc-body">`);
  rep.sections.forEach((sec, i) => {
    body.push(`<section class="sec">`);
    // 一级标题：一、（黑体）
    body.push(`<h2 class="h1">${escHtml(sectionNo('cn', i + 1))}${escHtml(sectionTitle(sec.title))}</h2>`);
    const bullets = [];
    const todos = [];
    const flush = () => {
      if (bullets.length) { body.push(`<ul>${bullets.join('')}</ul>`); bullets.length = 0; }
      if (todos.length) { body.push(`<ul class="todo">${todos.join('')}</ul>`); todos.length = 0; }
    };
    let subNo = 0; // 段内小标题按「（一）（二）…」递进（楷体）
    for (const ln of sec.lines) {
      if (ln.kind === 'sub') {
        flush();
        subNo += 1;
        body.push(`<h3 class="h2">${escHtml(sectionNo('cnPar', subNo))}${escHtml(sectionTitle(ln.text))}</h3>`);
      } else if (ln.kind === 'todo') {
        // 复选框清单：导出文档是静态的，用 ☐ 字符而非 <input>——<input> 在打印稿里
        // 既不可交互也会被部分渲染器丢掉，反倒看不出这是"待办"。
        if (bullets.length) { body.push(`<ul>${bullets.join('')}</ul>`); bullets.length = 0; }
        todos.push(`<li><span class="cb">☐</span>${inlineToHtml(ln.text)}</li>`);
      } else if (ln.kind === 'table') {
        flush();
        // 附表：**表格标题在表格上方居中**（公文硬规定），文字 3 号仿宋
        if (ln.caption) body.push(`<p class="tbl-cap">${escHtml(ln.caption)}</p>`);
        const th = ln.head.map((c) => `<th>${escHtml(c)}</th>`).join('');
        const trs = ln.rows.map((r) =>
          `<tr>${r.map((c) => `<td>${inlineToHtml(c)}</td>`).join('')}</tr>`).join('');
        body.push(`<table class="rep-tbl">${th ? `<thead><tr>${th}</tr></thead>` : ''}<tbody>${trs}</tbody></table>`);
      } else bullets.push(`<li>${inlineToHtml(ln.text)}</li>`);
    }
    flush();
    // 章节口径折叠件（默认收起，仅展示指标）——打印时由 CSS 强制展开
    if (sec.caliber) {
      body.push(`<details class="caliber"><summary>${escHtml(CALIBER_SUMMARY_DOC)}</summary>`);
      body.push(`<p>${inlineToHtml(sec.caliber)}</p>`);
      body.push(`</details>`);
    }
    body.push(`</section>`);
  });
  body.push(`</main>`);

  // 文末独立折叠附录：汇总全部口径
  if (rep.appendix) {
    body.push(`<details class="caliber appendix" open><summary>${escHtml(rep.appendix.title)}</summary>`);
    body.push(`<p>${escHtml(rep.appendix.body)}</p>`);
    body.push(`</details>`);
  }
  // 兼容历史形态的口径备注
  if (rep.foot) {
    body.push(`<details class="caliber appendix"><summary>${escHtml(CALIBER_SUMMARY_DOC)}（备注）</summary>`);
    body.push(`<p>${escHtml(rep.foot)}</p>`);
    body.push(`</details>`);
  }

  // ── 落款：生成日期（阿拉伯数字，不编虚位，右空四字） ──
  body.push(`<p class="sign-date">${escHtml(docDate(dataDate))}</p>`);

  body.push(`<footer class="doc-foot">`);
  body.push(`<p class="disclaimer"><b>免责声明</b>：本简报由 ${escHtml(REPORT_ORG)} 规则引擎根据公开行情数据自动生成，仅供研究参考，<b>不构成任何投资建议</b>。数据可能存在延迟或误差，据此操作风险自担。</p>`);
  if (url) body.push(`<p class="src">数据来源：${escHtml(url)}</p>`);
  if (generatedAt) body.push(`<p class="src">导出时间：${escHtml(generatedAt)}</p>`);
  body.push(`</footer>`);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(REPORT_TITLE)}${dataDate ? ' · ' + escHtml(dataDate) : ''}</title>
<style>${css}</style>
</head>
<body>
<article class="doc">
${body.join('\n')}
</article>
</body>
</html>
`;
}

// 公文体例排版：白底黑字、2/3/4 号字号阶梯、小标宋/黑体/楷体/仿宋。刻意**不**跟随站点深色主题——
// 导出/打印的文档是要发给别人、拿去打印的，深色底打印会变成一片黑。
//
// ⚠ 这里的每个数值都来自 DOC_SPEC（唯一出处），用模板串插入而不是手抄：
//   手抄就会出现「常量说 16pt、CSS 写 15px」这种两套口径，守卫脚本无从判断谁对。
// 页码的「单页右放、双页左放」用 @page :left/:right 的页边距框 + counter(page) 实现，
// 精确落在版心之外；Chromium 打印会忽略 :left/:right 的 margin box，此时退化为
// 浏览器默认的页脚页码位置（内容仍然完整，只是左右分置不生效）——见文末说明。
export const STANDALONE_CSS = `
@page { size: ${DOC_SPEC.page.size}; margin: ${DOC_SPEC.page.top} ${DOC_SPEC.page.right} ${DOC_SPEC.page.bottom} ${DOC_SPEC.page.left}; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body { color: #000; font-family: ${DOC_SPEC.family.fs}; font-size: ${DOC_SPEC.font.body}; line-height: 1.7; }
/* 版心宽度 = A4宽 210 − 左 28 − 右 26 = 156mm，与 @page 页边距严格一致 */
.doc { width: 156mm; margin: 0 auto; padding: 0 0 12mm; }

/* ── 报头：简报名称（2 号小标宋，居中）+ 简报编号（居右） ── */
.doc-head { margin: 0 0 6mm; }
.doc-head .serial { margin: 0; text-align: right; font-family: ${DOC_SPEC.family.fs}; font-size: ${DOC_SPEC.font.note}; color: #000; }
.doc-head .masthead { margin: 1mm 0 0; text-align: center; font-family: ${DOC_SPEC.family.xbs};
  font-size: ${DOC_SPEC.font.h1}; font-weight: 700; letter-spacing: .1em; line-height: 1.4; }

/* ── 主标题：2 号小标宋，居中；多行梯形/菱形（台阶居中，逐行收窄） ── */
.doc-title { margin: 4mm 0 ${DOC_SPEC.font.body}; padding: 0; text-align: center; font-family: ${DOC_SPEC.family.xbs};
  font-size: ${DOC_SPEC.font.h1}; font-weight: 700; line-height: 1.5; }
.doc-title .t-line { display: block; }
/* 梯形/菱形：两行时上宽下窄；三行及以上时中间最宽、首尾收窄（菱形） */
.doc-title[data-line-count="2"] .t-line + .t-line { width: 74%; margin: 0 auto; }
.doc-title[data-line-count="3"] .t-line:first-child { width: 78%; margin: 0 auto; }
.doc-title[data-line-count="3"] .t-line:last-child { width: 78%; margin: 0 auto; }
.doc-title[data-line-count="4"] .t-line:first-child,
.doc-title[data-line-count="4"] .t-line:last-child { width: 72%; margin: 0 auto; }
.doc-title[data-line-count="4"] .t-line:nth-child(2),
.doc-title[data-line-count="4"] .t-line:nth-child(3) { width: 92%; margin: 0 auto; }

/* ── 摘要栏：标题下空一行、3 号楷体、左空 2 字符 ── */
.doc-abstract { margin: 0 0 3mm; text-indent: 2em; text-align: justify; font-family: ${DOC_SPEC.family.kai};
  font-size: ${DOC_SPEC.font.abstract}; line-height: 1.7; }
.doc-abstract .abs-lead { font-weight: 700; }

/* ── 数据落款条：生成依据，4 号仿宋，不占摘要栏 ── */
.doc-meta { margin: 0 0 5mm; text-indent: 2em; font-family: ${DOC_SPEC.family.fs};
  font-size: ${DOC_SPEC.font.note}; color: #333; }

/* ── 正文：3 号仿宋，每段左空 2 字符、回行顶格 ── */
.doc-body { font-family: ${DOC_SPEC.family.fs}; font-size: ${DOC_SPEC.font.body}; }
.sec { margin: 0 0 4mm; break-inside: auto; }
/* 一级标题：一、（黑体） */
.sec h2.h1 { margin: 4mm 0 2mm; text-indent: 2em; font-family: ${DOC_SPEC.family.hei};
  font-size: ${DOC_SPEC.font.body}; font-weight: 700; line-height: 1.6; }
/* 二级标题：（一）（楷体） */
.sec h3.h2 { margin: 3mm 0 1mm; text-indent: 2em; font-family: ${DOC_SPEC.family.kai};
  font-size: ${DOC_SPEC.font.body}; font-weight: 700; line-height: 1.6; }
/* 正文行：左空 2 字符，回行顶格（text-indent 只管首行，回行自然顶格） */
.sec ul { margin: 0; padding: 0; list-style: none; }
.sec li { text-indent: 2em; margin: 0 0 1mm; text-align: justify; break-inside: avoid; }

/* ── 附表：文字 3 号仿宋，表格标题在表格上方居中 ── */
.tbl-cap { margin: 3mm 0 1mm; text-align: center; font-family: ${DOC_SPEC.family.hei}; font-weight: 700;
  font-size: ${DOC_SPEC.font.table}; }
.rep-tbl { width: 100%; border-collapse: collapse; margin: 0 0 3mm; font-family: ${DOC_SPEC.family.fs};
  font-size: ${DOC_SPEC.font.table}; break-inside: avoid; table-layout: auto; }
.rep-tbl th, .rep-tbl td { border: 1px solid #000; padding: 1mm 2mm; text-align: left; vertical-align: top;
  line-height: 1.5; }
.rep-tbl thead th { background: #f2f2f2; font-family: ${DOC_SPEC.family.hei}; font-weight: 700; text-align: center; }
.rep-tbl td:first-child { white-space: nowrap; }

/* ── 明日跟踪项：复选框清单（模板④） ── */
.sec ul.todo li { text-indent: 2em; }
.sec ul.todo .cb { margin-right: .3em; }

/* ── 口径折叠件（<details> 原生折叠，无需脚本；📌 打印时强制展开） ── */
details.caliber { margin: 2mm 0 0; border: 1px solid #bbb; background: #fafafa; break-inside: avoid; }
details.caliber > summary { cursor: pointer; padding: 1mm 2mm; font-family: ${DOC_SPEC.family.kai};
  font-size: ${DOC_SPEC.font.note}; color: #333; user-select: none; }
details.caliber > summary:hover { color: #000; }
details.caliber > p { margin: 0; padding: 1mm 2mm 2mm; font-family: ${DOC_SPEC.family.kai};
  font-size: ${DOC_SPEC.font.note}; line-height: 1.7; text-align: justify; text-indent: 2em; }
details.caliber.appendix { margin-top: 5mm; }

/* ── 落款：生成日期，阿拉伯数字写全年月日、不编虚位、右空四字 ── */
.sign-date { margin: 6mm 0 0; text-align: right; padding-right: ${DOC_SPEC.dateRightChars}em;
  font-family: ${DOC_SPEC.family.fs}; font-size: ${DOC_SPEC.font.body}; }

/* ── 语义强调（注意：本文件是打印文档，涨红跌绿沿用中文惯例） ── */
b, strong { font-weight: 700; color: #000; }
.chg { color: #c0392b; white-space: nowrap; }
.chg-dn { color: #1e7e34; }
.chg i { font-style: normal; font-size: .8em; }
.warn { color: #9a6b00; font-weight: 700; }
/* 三档配色标记：白底打印文档里 emoji 会转黑白，故同时给文字色做区分 */
.ico { white-space: nowrap; }
.ico-risk { color: #c0392b; font-weight: 700; }
.ico-pos { color: #1e7e34; font-weight: 700; }
.ico-neutral { color: #333; }

/* ── 页脚（免责声明等，位于落款之后、版心之内） ── */
.doc-foot { margin-top: 4mm; padding-top: 2mm; border-top: 1px solid #999; }
.disclaimer { font-size: ${DOC_SPEC.font.note}; color: #333; line-height: 1.7; text-indent: 2em;
  font-family: ${DOC_SPEC.family.fs}; margin: 0 0 1mm; }
.src { font-size: ${DOC_SPEC.font.note}; color: #555; margin: 0; text-indent: 2em;
  font-family: ${DOC_SPEC.family.fs}; }

/* ── 页码：4 号半角阿拉伯数字，居版心下边缘之下、版心之外；单页右放、双页左放 ──
   实现说明（这是本项目已知的浏览器能力边界，不粉饰）：
     · 「居版心下边缘之下 / 版心之外」由 @page 的 @bottom-* 页边距框实现——这正是页脚区，
       落在下方 35mm 页边距内，不需要 footer 参与分页；
     · 「单页右放、双页左放」由 @page :right / :left 区分；
     · counter(page) 取当前页码，decorator 里给 ::after 挂内容（改 counter(page)+'/'+counter(pages)
       也只是加分母，故本稿不加，保持「4 号半角阿拉伯数字」的极简形态）。
   ⚠ Chromium 打印会忽略 @page :left/:right 的 margin box，此时退化为浏览器默认页脚位置；
     内容完整，只是左右分置不生效。若需严格分置，用打印对话框「页眉和页脚」或另行后处理。 */
@page :right { @bottom-right { content: counter(page); font-family: ${DOC_SPEC.family.fs}; font-size: ${DOC_SPEC.font.page}; } }
@page :left { @bottom-left { content: counter(page); font-family: ${DOC_SPEC.family.fs}; font-size: ${DOC_SPEC.font.page}; } }
.pg-no { display: none; }

/* ── 打印微调 ── */
@media print {
  .doc { width: auto; margin: 0; padding: 0; }
  a { color: inherit; text-decoration: none; }
  .sec h2.h1, .sec h3.h2 { break-after: avoid; }
  .doc-foot { break-inside: avoid; }

  /* ★ 折叠着打印会缺内容——这是本轮修的第二个真实 bug。
     旧写法只对 "> p" 与 "> ul" 加了 display:block，看起来「展开」了，但其实没用：
     一个**未 open** 的 <details> 在 Chromium 里根本不为子内容生成盒子
     （内容落在 UA 的 slot 里被 content-visibility 隐掉），
     所以无论后代怎么写 display，打印出来都还是缺的。
     正确做法是让 details **自身**在打印时表现为常开容器：
       ① 把 <summary> 的三角标记去掉（纸面上没有可折叠的语义）；
       ② 用 "details.caliber > *:not(summary)" 全量兜住，而不是逐个数 p/ul——
          口径正文可能含表格、列表、多段，漏一种就少一块（这正是"打印看不到全部内容"的由来）。
     不依赖 JS、不依赖文档里是否写了 open，纯 CSS 保证纸面完整。 */
  details.caliber { border: none; background: transparent; }
  details.caliber > summary { list-style: none; }
  details.caliber > summary::-webkit-details-marker { display: none; }
  details.caliber > summary::marker { content: ''; }
  /* 关键：把折叠件的全部内容强制显示（含未 open 的 details） */
  details.caliber > *:not(summary) { display: block !important; }
  details.caliber > :not(summary) { break-inside: avoid; }

  .rep-tbl { break-inside: avoid; }
  .rep-tbl thead { display: table-header-group; }
  .rep-tbl tr { break-inside: avoid; }
}
`;

/** 文件名：`研判报告_2026-09-30.html` —— 日期在前便于按时间排序 */
export function reportFileName(dataDate, ext) {
  const d = String(dataDate || '').replace(/[^\d-]/g, '') || 'unknown';
  return `A股研判报告_${d}.${ext}`;
}
