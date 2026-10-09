// 数据导出：把屏幕上看到的每一块数据，导出成 CSV / Excel。
//
// ── 本模块存在的理由（比"多一个下载按钮"重要得多）────────────────────────────
// 导出的**必须与屏幕同源**。最容易犯的错是在前端另写一套取数逻辑——那样导出的
// 数字与页面上的会慢慢分叉（改了一处忘了另一处），而用户下载到的文件是"看起来
// 很正式的表格"，恰恰最不会被怀疑。故：
//   · 取数一律走本模块的 DATASETS 目录，前端只负责"把哪一份交给下载器"
//   · 本模块是**纯函数、零依赖**：不读盘、不写盘、不碰 DOM → 可在 Node 侧单测，
//     也能证明"导出 == 屏幕"这件事（测试直接喂同一份 archive/signals 给两边）
//
// ── 数据诚实性（本项目铁律）──────────────────────────────────────────────────
//   · 缺失一律导出**空单元格**，绝不写 0 —— 0 会被读成"实际值就是 0"（如"净买 0"＝
//     多空抵消，与"没数据"含义相反）。CSV 里空 ≠ 0，Excel 里空单元格也不参与统计。
//   · 布尔一律导出「是/否」，不导出 true/false —— 打开 Excel 看到 true 的人会问
//     "这是文本还是布尔"，而 是/否 没有歧义。
//   · 回填日的情绪分是 **s_net 单因子占位值**（非综合分），导出时用 `isBackfill`
//     列显式标记，并在表头注释里说明 —— 否则按情绪分排序会把回填日排到前列。
//
// ── 为什么自写 CSV / XLSX 序列化，而不是引库 ─────────────────────────────────
// 本项目前端是零构建的 vanilla（无打包器）。引一个 xlsx 库意味着要么走 CDN
// （离线看盘就废了）、要么把几百 KB 塞进仓库。而 SpreadsheetML 2003（XML 工作表）
// 是 Excel/WPS 都能直接打开的单文件格式，序列化不到 100 行且完全可测。
// 代价：只能出**单表页**——多表页需要 sheet 关系文件（.rels），复杂度不划算。
// 需要多表页的用户下载 CSV 分开看，或按数据集单独导出。

// ── 单元格类型 ────────────────────────────────────────────────────────────────
// 刻意只用两种：数（right/数值）与文（left/文本）。不做日期类型——债券式日期解析
// （day-first vs month-first）是 Excel 的老坑，写成本地化的 YYYY-MM-DD 字符串
// 反而在任何区域设置下都不会被误解析。
export const CELL = Object.freeze({ NUM: 'num', TXT: 'txt' });

/**
 * 从对象里安全取一个"原始值"，同时给出它是否为"真值"。
 *
 * ⚠ 这是全模块最关键的一个函数。本项目的核心陷阱：`+[] === 0`、`+'' === 0`、
 *   `+null === 0`、`+{} === NaN`。任何"先取值再 Number()"的写法都会把缺失
 *   （null / undefined / '' / []）悄悄变成 0 —— 导出的表格因此**看不出**缺数据，
 *   比少几行严重得多。
 *   故取值后必须经 has() 判定，只有确实是有意义的值才落到单元格。
 */
function pick(obj, path) {
  if (!obj) return undefined;
  let cur = obj;
  for (const k of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

/** 该值是否"有意义"（可导出）。缺失 → false。 */
export function has(v) {
  if (v == null) return false;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'boolean') return true;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** 单元格渲染：缺失 → 空串（绝不 0）；布尔 → 是/否；数 → 定点；其余原样字符串化。 */
export function cellText(v, type) {
  if (!has(v)) return '';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (type === CELL.NUM) {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return '';
    return String(Math.round(n * 1e6) / 1e6);
  }
  return String(v);
}

// ── CSV（RFC 4180）────────────────────────────────────────────────────────────
// 引号规则：字段含 逗号 / 引号 / 换行 / 首尾空白 时用双引号包裹，内部引号双写。
// 首尾空白也要包：题材名里偶有前后空格，不包会被 Excel 静默吃掉。
export function csvField(s) {
  const t = String(s == null ? '' : s);
  return /[",\r\n]|^\s|\s$/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

/**
 * 由 columns + rows 生成 CSV 文本。
 * @param {{key:string,label:string,type?:string}[]} columns
 * @param {object[]} rows 每行一个对象（键与 columns.key 对应）
 * @param {{bom?:boolean, meta?:object}} opts bom 默认加（Excel 识别 UTF-8 的唯一可靠办法）
 *
 * 首部写 `#` 注释行：数据日期 / 生成时刻 / 口径来源 / 缺失语义。
 * 这些信息本身也在屏幕上（各面板的口径折叠件里），导出件脱离页面后若无它们，
 * 收件人无法判断这是哪一天的、空单元格是什么意思。
 */
export function buildCsv(columns, rows, opts = {}) {
  const cols = Array.isArray(columns) ? columns : [];
  const list = Array.isArray(rows) ? rows : [];
  const lines = [];
  const meta = opts.meta || {};
  for (const [k, v] of Object.entries(meta)) {
    if (!has(v)) continue;
    lines.push('# ' + csvField(k + '：' + String(v)));
  }
  lines.push(cols.map((c) => csvField(c.label)).join(','));
  for (const r of list) {
    lines.push(cols.map((c) => csvField(cellText(pick(r, c.key), c.type || CELL.TXT))).join(','));
  }
  const body = lines.join('\r\n') + '\r\n';
  // BOM：Excel 打开无 BOM 的 UTF-8 CSV 会按系统 ANSI 解码 → 中文全乱码。
  return (opts.bom === false ? '' : '\uFEFF') + body;
}

/** CSV 版本用「-utf8-bom」入名，让收到乱码文件的人一眼知道该换编码打开。 */
export function datasetFileName(base, ext, stamp) {
  const s = String(stamp || '').replace(/[^\dA-Za-z-]/g, '') || 'unknown';
  return `${base}-${s}.${ext}`;
}

// ── XLSX：SpreadsheetML 2003（Excel 2000/2003 XML 工作表）──────────────────────
function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // XML 1.0 不允许的控制字符（标签里偶尔混进 \u0000-\u001f）——不剔除会让整份文件打不开
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** 表名：Excel 限制 31 字符且不可含 : \ / ? * [ ]，超长/非法都会导致打开失败。 */
export function sheetName(s) {
  const t = String(s || 'Sheet1').replace(/[:\\/?*[\]]/g, '_').slice(0, 31);
  return t || 'Sheet1';
}

/**
 * 生成 SpreadsheetML 2003 XML 文本（Excel / WPS / Numbers 均可直接打开）。
 *
 * 为什么不用真 .xlsx（zip）：那需要实现 zip 容器（或引库）。本格式是**纯文本单文件**，
 * 序列化确定、可 diff、可单测，且对"下载下来看一眼"这个真实用途完全够用。
 */
export function buildSpreadsheetXml(sheets, opts = {}) {
  const list = Array.isArray(sheets) ? sheets : [];
  const meta = opts.meta || {};
  const metaRows = Object.entries(meta).filter(([, v]) => has(v));
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<?mso-application progid="Excel.Sheet"?>');
  out.push('<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"');
  out.push(' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">');
  out.push('<Styles>'
    + '<Style ss:ID="hdr"><Font ss:Bold="1"/><Interior ss:Color="#EEEEEE" ss:Pattern="Solid"/></Style>'
    + '<Style ss:ID="txt"><NumberFormat ss:Format="@"/></Style>'
    + '</Styles>');
  for (const sh of list) {
    const cols = Array.isArray(sh.columns) ? sh.columns : [];
    const rows = Array.isArray(sh.rows) ? sh.rows : [];
    out.push(`<Worksheet ss:Name="${xmlEsc(sheetName(sh.name))}"><Table>`);
    // 列宽：按标签长度给个粗略宽度，否则打开是一排"####"
    out.push(cols.map((c) => {
      const w = Math.min(220, Math.max(60, (String(c.label || '').length * 9) + 30));
      return `<Column ss:Width="${w}"/>`;
    }).join(''));
    if (metaRows.length) {
      out.push('<Row ss:StyleID="txt">');
      metaRows.forEach(([k, v], i) => {
        if (i === 0) out.push('<Cell ss:StyleID="txt"><Data ss:Type="String">'
          + xmlEsc(k + '：' + String(v)) + '</Data></Cell>');
      });
      out.push('</Row>');
    }
    out.push('<Row ss:StyleID="hdr">');
    for (const c of cols) {
      out.push('<Cell ss:StyleID="hdr"><Data ss:Type="String">'
        + xmlEsc(c.label) + '</Data></Cell>');
    }
    out.push('</Row>');
    for (const r of rows) {
      out.push('<Row>');
      for (const c of cols) {
        const t = cellText(pick(r, c.key), c.type || CELL.TXT);
        if (t === '') { out.push('<Cell/>'); continue; }
        if ((c.type || CELL.TXT) === CELL.NUM) {
          out.push(`<Cell><Data ss:Type="Number">${xmlEsc(t)}</Data></Cell>`);
        } else {
          out.push(`<Cell ss:StyleID="txt"><Data ss:Type="String">${xmlEsc(t)}</Data></Cell>`);
        }
      }
      out.push('</Row>');
    }
    out.push('</Table></Worksheet>');
  }
  out.push('</Workbook>');
  return out.join('\n');
}

// ── 数据集目录 ────────────────────────────────────────────────────────────────
// 每个数据集 = 一段可独立导出的表格。columns 的顺序就是导出列顺序，
// **与屏幕上的列顺序一致**（用户对照着看不会错位）。

/** 情绪分·逐日（与走势图同源：displayDays 语义由调用方保证）。 */
const D_DAILY = {
  id: 'daily',
  label: '情绪分·逐日',
  fileBase: 'sentiment-daily',
  note: '逐交易日情绪分与七个因子。回填日（isBackfill=是）的情绪分是 s_net 单因子占位值，不是综合分——按此列排序会把回填日排到前面，请先按 isBackfill 过滤。',
  columns: [
    { key: 'trade_date', label: '交易日' },
    { key: 'value', label: '情绪分', type: CELL.NUM },
    { key: 'pct_rank', label: '历史分位%', type: CELL.NUM },
    { key: 'net_daily_pct_rank', label: '净买分位%', type: CELL.NUM },
    { key: 's_net', label: 's_net 资金', type: CELL.NUM },
    { key: 's_pos', label: 's_pos 涨跌', type: CELL.NUM },
    { key: 's_brd', label: 's_brd 广度', type: CELL.NUM },
    { key: 's_hot', label: 's_hot 热度', type: CELL.NUM },
    { key: 's_zdt', label: 's_zdt 涨停跌停', type: CELL.NUM },
    { key: 's_zbl', label: 's_zbl 封板', type: CELL.NUM },
    { key: 's_amt', label: 's_amt 量能', type: CELL.NUM },
    { key: 'missing_count', label: '缺失因子数', type: CELL.NUM },
    { key: 'imputedRatio', label: '补位率', type: CELL.NUM },
    { key: 'isBackfill', label: '回填日' },
    { key: 'zt_count', label: '涨停数', type: CELL.NUM },
    { key: 'dt_count', label: '跌停数', type: CELL.NUM },
    { key: 'zb_count', label: '炸板数', type: CELL.NUM },
    { key: 'seal_pct', label: '封板率%', type: CELL.NUM },
    { key: 'up_count', label: '上涨家数', type: CELL.NUM },
    { key: 'down_count', label: '下跌家数', type: CELL.NUM },
    { key: 'amount_yi', label: '成交额(亿)', type: CELL.NUM },
    { key: 'lhb_daily_net', label: '龙虎净买(万)', type: CELL.NUM },
    { key: 'ind_count', label: '行业数', type: CELL.NUM },
    { key: 'main_theme', label: '主线题材' },
  ],
  rows(arc) {
    return ((arc && arc.all_days) || []).map((d) => {
      const e = d.emotion || {}, s = d.summary || {};
      return {
        trade_date: d.trade_date,
        value: e.value ?? e.score,
        pct_rank: e.pct_rank,
        net_daily_pct_rank: e.net_daily_pct_rank,
        s_net: e.s_net, s_pos: e.s_pos, s_brd: e.s_brd, s_hot: e.s_hot,
        s_zdt: e.s_zdt, s_zbl: e.s_zbl, s_amt: e.s_amt,
        missing_count: Array.isArray(e.missing) ? e.missing.length : undefined,
        imputedRatio: e.imputedRatio,
        isBackfill: !!e._backfill,
        zt_count: s.zt_count, dt_count: s.dt_count, zb_count: s.zb_count,
        seal_pct: s.seal_pct, up_count: s.up_count, down_count: s.down_count,
        amount_yi: s.amount_yi, lhb_daily_net: s.lhb_daily_net,
        ind_count: s.ind_count, main_theme: s.main_theme,
      };
    });
  },
};

/** 个股明细（强势股归因）。 */
const D_HOT = {
  id: 'hot',
  label: '个股明细',
  fileBase: 'stock-detail',
  note: '当日强势股归因清单（与页面「强势股归因」表同源）。涨跌幅为当日收盘口径。',
  columns: [
    { key: 'trade_date', label: '交易日' },
    { key: 'code', label: '代码' },
    { key: 'name', label: '名称' },
    { key: 'change_pct', label: '涨跌幅%', type: CELL.NUM },
    { key: 'close', label: '收盘价', type: CELL.NUM },
    { key: 'huanshou', label: '换手率%', type: CELL.NUM },
    { key: 'reason', label: '上榜诱因' },
  ],
  rows(arc) {
    const d = lastDayOf(arc);
    if (!d) return [];
    return (d.hot || []).map((h) => ({ trade_date: d.trade_date, ...h }));
  },
};

/** 龙虎榜资金（聚合后口径）。 */
const D_LHB = {
  id: 'lhb',
  label: '龙虎榜资金',
  fileBase: 'lhb-daily',
  note: '按代码聚合后的龙虎榜资金。caliber=daily 为当日榜（权威口径），range 为区间累计榜（成交额是区间累计值，不可与当日榜相加）。',
  columns: [
    { key: 'trade_date', label: '交易日' },
    { key: 'code', label: '代码' },
    { key: 'name', label: '名称' },
    { key: 'caliber', label: '口径' },
    { key: 'close', label: '收盘价', type: CELL.NUM },
    { key: 'change_pct', label: '涨跌幅%', type: CELL.NUM },
    { key: 'net_buy_wan', label: '净买(万)', type: CELL.NUM },
    { key: 'buy_wan', label: '买入(万)', type: CELL.NUM },
    { key: 'sell_wan', label: '卖出(万)', type: CELL.NUM },
    { key: 'deal_wan', label: '成交(万)', type: CELL.NUM },
    { key: 'turnover_pct', label: '换手率%', type: CELL.NUM },
    { key: 'reason', label: '上榜原因' },
  ],
  rows(arc) {
    const d = lastDayOf(arc);
    if (!d) return [];
    // 展示层一律用聚合产物；lhb_aggr 缺失时回退原始记录（前端同款回退）
    const rows = Array.isArray(d.lhb_aggr) ? d.lhb_aggr : (Array.isArray(d.lhb) ? d.lhb : []);
    return rows.map((r) => ({ trade_date: d.trade_date, ...r }));
  },
};

/** 题材分布（当日去噪后）。 */
const D_THEMES = {
  id: 'themes',
  label: '题材分布',
  fileBase: 'themes',
  note: '当日题材出现次数（已去噪，与页面「最新日题材」同源）。',
  columns: [
    { key: 'trade_date', label: '交易日' },
    { key: 'theme', label: '题材' },
    { key: 'count', label: '个股数', type: CELL.NUM },
  ],
  rows(arc) {
    const d = lastDayOf(arc);
    const t = (d && d.themes) || null;
    if (!t) return [];
    return Object.entries(t).map(([theme, count]) => ({ trade_date: d.trade_date, theme, count }));
  },
};

/** 行业涨跌幅（当日）。 */
const D_INDUSTRY = {
  id: 'industry',
  label: '行业涨跌幅',
  fileBase: 'industry',
  note: '当日各行业涨跌幅（同花顺行业口径，主源）。与「跨源互证」面板的第二源（申万二级）分类体系不同，两者不可直接比较。',
  columns: [
    { key: 'trade_date', label: '交易日' },
    { key: 'name', label: '行业' },
    { key: 'change_pct', label: '涨跌幅%', type: CELL.NUM },
  ],
  rows(arc) {
    const d = lastDayOf(arc);
    if (!d) return [];
    return (d.industry || []).map((x) => ({ trade_date: d.trade_date, ...x }));
  },
};

/** 市场宽度·逐日。 */
const D_BREADTH = {
  id: 'breadth',
  label: '市场宽度·逐日',
  fileBase: 'breadth',
  note: '宽度由全市场真实前复权日K计算（非 hot 榜单样本）。比例为空的含义是「未计算」（样本不足或 PB 源不可用），不是 0。',
  columns: [
    { key: 'date', label: '交易日' },
    { key: 'scanned', label: '有效样本', type: CELL.NUM },
    { key: 'maRatio', label: '站上20日线', type: CELL.NUM },
    { key: 'newHighRatio', label: '新高占比', type: CELL.NUM },
    { key: 'newLowRatio', label: '新低占比', type: CELL.NUM },
    { key: 'brokenRatio', label: '破净率', type: CELL.NUM },
    { key: 'up', label: '上涨家数', type: CELL.NUM },
    { key: 'down', label: '下跌家数', type: CELL.NUM },
    { key: 'verdict', label: '结论' },
  ],
  rows(_arc, sig) {
    const b = (sig && sig.breadth) || null;
    if (!b) return [];
    const series = Array.isArray(b.series) ? b.series : [];
    if (series.length) return series;
    return b.snapshot ? [b.snapshot] : [];
  },
};

/** 跨源互证（偏离行业，供人工复核）。 */
const D_XCHECK = {
  id: 'crosscheck',
  label: '跨源互证·偏离行业',
  fileBase: 'crosscheck',
  note: '主源（同花顺行业，90 个）与第二源（申万二级，100 个）经别名表归一化后的可比行业。devPp 是**已扣除常态系统性偏移**后的偏差。未被两个源同时覆盖的行业不在本表中——那是「未核对」，不是「一致」。',
  columns: [
    { key: 'date', label: '交易日' },
    { key: 'name', label: '行业' },
    { key: 'primaryPct', label: '主源%', type: CELL.NUM },
    { key: 'secondaryPct', label: '第二源%', type: CELL.NUM },
    { key: 'devPp', label: '去偏偏差(pp)', type: CELL.NUM },
    { key: 'kind', label: '判定' },
    { key: 'reason', label: '说明' },
  ],
  rows(_arc, sig) {
    const x = (sig && sig.crosscheck) || null;
    if (!x) return [];
    return Array.isArray(x.flagged) ? x.flagged : [];
  },
};

/** 数据质量（脏数据留痕）。 */
const D_DIRTY = {
  id: 'dirty',
  label: '数据质量留痕',
  fileBase: 'data-quality',
  note: '单源内部校验的留痕。status=dirty 表示该字段已被排除在因子入参之外（原值仍保留在档里）；warn 表示仅标记需人工复核，未剔除任何数据。',
  columns: [
    { key: 'date', label: '交易日' },
    { key: 'status', label: '状态' },
    { key: 'field', label: '字段' },
    { key: 'rule', label: '规则' },
    { key: 'severity', label: '级别' },
    { key: 'reason', label: '原因' },
  ],
  rows(_arc, sig) {
    const dd = (sig && sig.dirty) || null;
    if (!dd) return [];
    const out = [];
    for (const r of (Array.isArray(dd.recent) ? dd.recent : [])) {
      const issues = Array.isArray(r.issues) && r.issues.length ? r.issues : [{}];
      for (const it of issues) {
        out.push({
          date: r.date, status: r.status,
          field: it.field, rule: it.rule, severity: it.severity, reason: it.reason,
        });
      }
    }
    return out;
  },
};

/** 资金属性（机构/北向/游资逐日净买）。 */
const D_SEATS = {
  id: 'seats',
  label: '资金属性·逐日净买',
  fileBase: 'seats-daily',
  note: '三类席位逐日净买（亿元）。仅买方口径——锁仓/新进问的是「买盘是不是老面孔」。空值＝该日无席位明细。',
  columns: [
    { key: 'date', label: '交易日' },
    { key: 'instNet', label: '机构净买(亿)', type: CELL.NUM },
    { key: 'northNet', label: '北向净买(亿)', type: CELL.NUM },
    { key: 'hotNet', label: '游资净买(亿)', type: CELL.NUM },
  ],
  rows(_arc, sig) {
    const s = (sig && sig.seats) || null;
    if (!s) return [];
    return Array.isArray(s.series) ? s.series : [];
  },
};

/** 外围行情（隔夜）。 */
const D_GLOBAL = {
  id: 'global',
  label: '外围行情·隔夜',
  fileBase: 'global-quotes',
  note: '外围品种隔夜行情。A 股休市期间照常更新，与 A 股存档节奏不同。',
  columns: [
    { key: 'name', label: '品种' },
    { key: 'code', label: '代码' },
    { key: 'role', label: '角色' },
    { key: 'last', label: '最新价', type: CELL.NUM },
    { key: 'prevClose', label: '前收', type: CELL.NUM },
    { key: 'chg', label: '涨跌', type: CELL.NUM },
    { key: 'chgPct', label: '涨跌幅%', type: CELL.NUM },
    { key: 'sessionDate', label: '会话日期' },
    { key: 'quoteTime', label: '报价时间' },
    { key: 'note', label: '说明' },
  ],
  rows(_arc, _sig, g) {
    const q = (g && g.quotes) || null;
    return Array.isArray(q) ? q.filter((x) => x && x.ok !== false) : [];
  },
};

/** 全部数据集（顺序即导出菜单顺序：先日常，后诊断）。 */
export const DATASETS = Object.freeze([
  D_DAILY, D_HOT, D_THEMES, D_INDUSTRY, D_BREADTH, D_SEATS, D_GLOBAL, D_LHB, D_XCHECK, D_DIRTY,
]);

/** 按 id 取数据集定义（导出菜单项 → 定义）。 */
export function datasetById(id) {
  return DATASETS.find((d) => d.id === id) || null;
}

function lastDayOf(arc) {
  const days = (arc && arc.all_days) || [];
  return days.length ? days[days.length - 1] : null;
}

/**
 * 统一取数入口。
 * @returns {{id:string,label:string,columns:object[],rows:object[],note:string,fileBase:string,count:number,empty:boolean}}
 *
 * ⚠ 刻意**不抛错**：某个段缺失（如 crosscheck 未生成）时返回空表 + note，
 *   由调用方决定怎么提示。抛错会让"导出一整份但有一块暂时没有"变成"什么都导不出来"。
 */
export function buildDataset(id, ctx = {}) {
  const def = datasetById(id);
  if (!def) return null;
  let rows = [];
  try {
    rows = def.rows(ctx.archive || null, ctx.signals || null, ctx.global || null) || [];
    rows = rows.filter((r) => r && Object.keys(r).length);
  } catch {
    // 取数失败＝这一段没数据，不是整个导出失败。如实为空，由调用方提示。
    rows = [];
  }
  return {
    id: def.id, label: def.label, fileBase: def.fileBase,
    columns: def.columns, rows, note: def.note,
    count: rows.length, empty: rows.length === 0,
  };
}

/** 导出用的元信息（写进 CSV 首部注释 / Excel 首行）。 */
export function datasetMeta(ctx = {}) {
  const meta = (ctx.archive && ctx.archive.meta) || {};
  const sig = ctx.signals || {};
  const m = {
    数据日期: meta.tradeDate || (sig.meta && sig.meta.tradeDate) || '',
    生成时刻: meta.generatedAt || (sig.meta && sig.meta.generatedAt) || '',
    公式版本: meta.formulaVersion || (sig.meta && sig.meta.formulaVersion) || '',
    数据新鲜度: (meta.freshness && meta.freshness.state) || '',
    缺失语义: '空单元格＝未计算/无数据，不等于 0',
    口径归属: 'A股情绪系统 PRO · 导出件与页面同源',
  };
  return m;
}

/** 组装导出件：CSV 文本 + 文件名。 */
export function exportAsCsv(id, ctx = {}) {
  const ds = buildDataset(id, ctx);
  if (!ds) return null;
  const text = buildCsv(ds.columns, ds.rows, { meta: datasetMeta(ctx) });
  return { ...ds, text, ext: 'csv', mime: 'text/csv', fileName: datasetFileName(ds.fileBase, 'csv', ctx.archive?.meta?.tradeDate) };
}

/** 组装导出件：SpreadsheetML XML 文本 + 文件名（一个工作簿可含多个表页）。 */
export function exportAsExcel(ids, ctx = {}) {
  const want = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  const sets = want.map((id) => buildDataset(id, ctx)).filter(Boolean);
  if (!sets.length) return null;
  const sheets = sets.map((s) => ({ name: s.label, columns: s.columns, rows: s.rows }));
  const text = buildSpreadsheetXml(sheets, { meta: datasetMeta(ctx) });
  const base = sets.length === 1 ? sets[0].fileBase : 'sentiment-all';
  return {
    sets, text, ext: 'xls', mime: 'application/vnd.ms-excel',
    fileName: datasetFileName(base, 'xls', ctx.archive?.meta?.tradeDate),
  };
}

/** 导出清单页：给"导出全部"用的目录（哪些数据集、各多少行）。 */
export function exportManifest(ctx = {}) {
  return DATASETS.map((d) => {
    const ds = buildDataset(d.id, ctx);
    return { id: d.id, label: d.label, count: ds ? ds.count : 0, empty: ds ? ds.empty : true };
  });
}
