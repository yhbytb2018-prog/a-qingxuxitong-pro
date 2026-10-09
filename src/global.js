// ─────────────────────────────────────────────────────────────────────────────
// 外围市场观测（隔夜外围 / 节后预案）
//
// 定位：给「A 股下一次开盘怎么走」提供一个**可核验的外部底座**。A 股休市期间本模块
//       照常更新，所以长假预案不需要靠手抄新闻——品种、与 A 股的映射方向、触发阈值
//       都在这里定义一次，抓取脚本与前端渲染都从这里派生。
//
// 为什么必须只看「同源锚」而不是「道指」：
//   A 股 9-30 收的是一个「大盘分化、成长杀跌」的盘（上证 +0.31%，但科创50 -2.51%、
//   半导体与元件领跌、超 2800 只个股下跌）。在这种结构里，用道指（金融/消费权重高）
//   去推 A 股，方向经常是反的。真正同源的是：
//     · 富时中国 A50 期货 —— 直接定价 A 股权重，且 A 股休市期间仍在交易（长假唯一实时锚）
//     · 费城半导体指数 SOX —— 与 PCB/元件/半导体同一批终端需求与客户
//     · 纳斯达克 —— 与创业板/科创的成长风格同向
//     · 金龙指数 / 富时中国 ETF —— 外资对中国资产的定价
//     · 美元指数 / 离岸人民币 —— 分母端与外资流向
//
// 设计原则（与 src/lhb.js 同源）：
//   1) 口径写进**字段名与常量**，不靠注释：涨跌幅一律用 last/prevClose 现算并同时保留
//      数据源原值（reported），两者不一致即说明口径漂移，能被守卫脚本抓到。
//   2) 取不到就是 null，**绝不 `|| 0`**——0 是真实行情值（费半 9-30 收平于 -0.00%），
//      把「没抓到」写成 0 会让缺失被读成「没波动」。
//   3) 与 A 股的映射写成**数据**（GLOBAL_ANCHORS），不埋在 if 分支里——映射要改就改数据。
//   4) 汇率的符号单独处理：USDCNH 上涨 = 人民币**贬值** = 对 A 股偏空。这个反号写进
//      `rmbUpPct` 字段名，读的人不必再心算一次。
// ─────────────────────────────────────────────────────────────────────────────

/** 数值解析：空串 / '-' / '--' 一律 null（不等于 0） */
function num(s) {
  if (s == null) return null;
  const t = String(s).trim().replace(/,/g, '');
  if (t === '' || t === '-' || t === '--') return null;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}

/** 抹掉 -0（否则 -0.00 会渲染成 "−0.00"，把「收平」显示成「下跌」） */
const nz = (v) => (v === 0 ? 0 : v);

// ── 品种清单 ────────────────────────────────────────────────────────────────
// kind 决定用哪个字段布局解析（新浪同一 host 下四套格式，见下方 NORMALIZERS）
export const GLOBAL_SYMBOLS = [
  // ① A 股外盘代理（权重最高）：长假期间唯一还在交易、且直接定价 A 股权重的品种
  { key: 'a50', code: 'hf_CHA50CFD', name: '富时中国A50期货', kind: 'hf', role: 'a_share_proxy',
    note: '新加坡交易所，A 股休市期间照常交易；长假里唯一能实时反映外资对 A 股定价的品种' },
  // ② 美股宽基
  { key: 'dji', code: 'gb_$dji', name: '道琼斯', kind: 'us', role: 'us_index',
    note: '金融/消费权重高，与 A 股成长主线关联最弱——只作广度参考，不作方向锚' },
  { key: 'spx', code: 'gb_$inx', name: '标普500', kind: 'us', role: 'us_index' },
  { key: 'ixic', code: 'gb_$ixic', name: '纳斯达克', kind: 'us', role: 'us_index',
    note: '与创业板/科创的成长风格同向' },
  { key: 'ndx', code: 'gb_$ndx', name: '纳斯达克100', kind: 'us', role: 'us_index' },
  // ③ 美股行业 / 中国资产
  { key: 'sox', code: 'gb_sox', name: '费城半导体指数', kind: 'us', role: 'us_sector',
    note: '与 A 股 PCB/元件/半导体同源度最高（同一批终端需求与客户）' },
  { key: 'hxc', code: 'gb_$hxc', name: '纳斯达克中国金龙指数', kind: 'us', role: 'china_adr' },
  { key: 'fxi', code: 'gb_fxi', name: '富时中国ETF（FXI）', kind: 'us', role: 'china_adr',
    note: '美股上市的中国大盘股 ETF，外资对中国权重的定价' },
  // ④ 中国香港（与 A 股共用假期，节前/节后对照用）
  { key: 'hsi', code: 'rt_hkHSI', name: '恒生指数', kind: 'hk', role: 'hk_index' },
  { key: 'hstech', code: 'rt_hkHSTECH', name: '恒生科技', kind: 'hk', role: 'hk_index' },
  // ⑤ 汇率（分母端 / 外资流向）
  { key: 'dxy', code: 'DINIW', name: '美元指数', kind: 'dxy', role: 'fx',
    note: '新浪口径，与 ICE 官方或有个位小数差异' },
  { key: 'cnh', code: 'fx_susdcnh', name: '美元/离岸人民币', kind: 'fx', role: 'fx' },
  { key: 'cny', code: 'fx_susdcny', name: '美元/在岸人民币', kind: 'fx', role: 'fx' },
  // ⑥ 商品
  { key: 'gold', code: 'hf_GC', name: 'COMEX黄金', kind: 'hf', role: 'commodity' },
  { key: 'wti', code: 'hf_CL', name: 'WTI原油', kind: 'hf', role: 'commodity' },
  { key: 'brent', code: 'hf_OIL', name: '布伦特原油', kind: 'hf', role: 'commodity',
    note: '新浪报的是**活跃合约**；媒体常引用即将到期合约（两者可差数美元，见 2026-09-30 实例）' },
];

export const SINA_CODES = GLOBAL_SYMBOLS.map((s) => s.code).join(',');
export const SINA_URL = 'https://hq.sinajs.cn/list=';

// 展示小数位（按品种量级定，写在这里而不是前端——前端只渲染文本，不再自己格式化一遍）
// 指数 2 位；A50 期货 1 位；美元指数 3 位；人民币 4 位；商品 2 位。
export const GLOBAL_DP = {
  a50: 1,
  dji: 2, spx: 2, ixic: 2, ndx: 2, sox: 2, hxc: 2, fxi: 2,
  hsi: 2, hstech: 2,
  dxy: 3, cnh: 4, cny: 4,
  gold: 2, wti: 2, brent: 2,
};

// ── 行情状态（quote state）──────────────────────────────────────────────────
//
// ★ 为什么必须有这个枚举（2026-10-01 实盘事故的直接产物）：
//   新浪在「该交易会话还没开盘 / 还没成交」时，回填的是：
//     last == prevClose、chgPct == 0、chgAmt == 0、open == high == low == 0
//   这是一份**看起来完全正常**的平盘数据。旧代码直接 last/prevClose 现算 → chgPct = 0，
//   前端显示「道指 0.00%」→ 触发式观测判「无明确方向」→ 用户读成「外围没动」。
//   而真相是「这一场还没开，我们不知道」。
//   **把"不知道"渲染成"0%"是本模块最严重的一类错误**：0% 是锚在阈值中间的确定值，
//   它会静默地把「未参与判定」伪装成「参与判定且判定为中性」。
//
//   故所有行情一律带 state，缺失/未开盘的品种 chgPct 必须为 **null**（不是 0）。
export const QUOTE_STATE = {
  OK: 'ok',                       // 有成交、可现算涨跌幅
  PREOPEN: 'preopen',             // 会话未开盘（open/high/low 全 0）→ chgPct = null
  NO_TRADE: 'no-trade',           // 数据源给的是平盘占位（last==prevClose 且 量=0 且 振幅=0）
  MISSING: 'missing',             // 字段缺失/解析不出 latest
};

/** 判断美股行情是否「本会话尚无成交」——判据写死在常量里，便于守卫扫描 */
export const NO_TRADE_MIN_AMPLITUDE = 0;   // 高-低 <= 0 视为无振幅

/**
 * 由归一化后的字段推断行情状态。
 * ⚠ 一律**基于可核验的字段证据**判断，不靠"看起来像 0"这种猜测。
 */
export function inferQuoteState(q, kind) {
  if (!q || q.last == null) return QUOTE_STATE.MISSING;
  // 只有美股/港股这种"有明确开盘收盘"的会话型品种才可能 preopen；
  //   期货/汇率/商品是连续交易，open/high/low 为 0 只说明数据源没给，不等于没开盘。
  const sessionKinds = kind === 'us' || kind === 'hk';
  if (!sessionKinds) return QUOTE_STATE.OK;
  const o = q.open, h = q.high, l = q.low;
  const allZero = o === 0 && h === 0 && l === 0;
  const noRange = (h != null && l != null) && (h - l) <= NO_TRADE_MIN_AMPLITUDE;
  if (allZero || noRange) return QUOTE_STATE.PREOPEN;
  // ⚠ 这里**只**判 allZero / noRange，不再叠加 "last === prevClose 且 chgReported === 0" 这条。
  //   为什么去掉：真收平（有振幅、last 恰好等于 prevClose）是完全合法的行情，
  //   叠加那条会把它误杀成 no-trade。区分"占位平盘"与"真收平"的唯一可靠证据就是
  //   **振幅**——占位态 open/high/low 全是 0（或高==低），真收平必有振幅。见测试回归①。
  return QUOTE_STATE.OK;
}


// ── 美股会话时钟（抓取时机）─────────────────────────────────────────────────
//
// ★ 为什么需要它（2026-10-01 事故的第二重成因）：
//   旧逻辑「每个工作日都跑」，于是抓到了北京 21:10 = 美东 09:10 这一刻——
//   美股 09:30 才开盘，此时数据源给的是**盘前占位**（last==prevClose、open/high/low=0）。
//   于是"抓了个盘前 → 当收平 0%"。抓取时机错，比任何计算 bug 都更根本：
//   再好的口径也救不回"在错误时刻取数"。
//
//   修正：美股数据只在**收盘后**才可信。规则写成一个可测的纯函数：
//     US_CLOSE_ET_MIN = 16:00（常规收盘）→ 加 30 分钟结算缓冲 = 16:30 ET
//     → 北京 04:30（夏令时 EDT = UTC-4 → 北京 UTC+8，差 12 小时）。
//
//   注意：这里是**采样窗口**而非"唯一允许运行时刻"——脚本其余品种（A50/汇率/商品）
//   是连续交易，随时可抓。故本函数只回答"此刻美股那一档能不能采信"，
//   由抓取脚本据此决定是否用美股涨跌幅、以及是否把整体结论降级。
export const US_CLOSE_ET_MIN = 16 * 60;              // 16:00 ET
export const US_SETTLE_BUFFER_MIN = 30;              // 收盘后 30 分钟
export const US_READY_ET_MIN = US_CLOSE_ET_MIN + US_SETTLE_BUFFER_MIN; // 16:30 ET

/** 美东夏令时判定（3 月第 2 个周日 02:00 → 11 月第 1 个周日 02:00）。返回 true=EDT(UTC-4) */
export function isUSEasternDST(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return false;
  const y = d.getUTCFullYear();
  // 3 月第 2 个周日
  const mar = new Date(Date.UTC(y, 2, 1));
  const marSun = 1 + ((7 - mar.getUTCDay()) % 7) + 7;   // 第 2 个周日
  const dstStart = Date.UTC(y, 2, marSun, 7, 0);        // 3 月第 2 周日 02:00 EST = 07:00 UTC
  // 11 月第 1 个周日
  const nov = new Date(Date.UTC(y, 10, 1));
  const novSun = 1 + ((7 - nov.getUTCDay()) % 7);
  const dstEnd = Date.UTC(y, 10, novSun, 6, 0);         // 11 月第 1 周日 02:00 EDT = 06:00 UTC
  const t = d.getTime();
  return t >= dstStart && t < dstEnd;
}

/** 给定时刻 → 美东当日的"分钟数"（0..1439） */
export function etMinutesOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const off = isUSEasternDST(d) ? -4 : -5;
  const mins = (d.getUTCHours() + off) * 60 + d.getUTCMinutes();
  return ((mins % 1440) + 1440) % 1440;
}

/**
 * 此刻美股能否采信（收盘态已就位）。
 * 返回 { ready, etMin, etText, reason }
 *   ready=false 时**不是"数据坏了"**，而是"这一档美股还没收盘，不该当收盘用"。
 */
export function usSessionReadiness(date) {
  const d = date instanceof Date ? date : new Date(date);
  const etMin = etMinutesOf(d);
  if (etMin == null) return { ready: false, etMin: null, etText: '—', reason: '时刻无效' };
  const hh = String(Math.floor(etMin / 60)).padStart(2, '0');
  const mm = String(etMin % 60).padStart(2, '0');
  const etText = `${hh}:${mm} ET`;
  if (etMin < 9 * 60 + 30) {
    return { ready: false, etMin, etText, reason: `美东 ${etText} 盘前（09:30 才开盘），此刻美股无收盘价` };
  }
  if (etMin < US_CLOSE_ET_MIN) {
    return { ready: false, etMin, etText, reason: `美东 ${etText} 盘中（16:00 才收盘），此刻只是盘中价` };
  }
  if (etMin < US_READY_ET_MIN) {
    return { ready: false, etMin, etText, reason: `美东 ${etText} 刚收盘（${US_SETTLE_BUFFER_MIN} 分钟结算缓冲内），收盘价可能尚未稳定` };
  }
  return { ready: true, etMin, etText, reason: `美东 ${etText} 已收盘（≥16:30 ET），可采信当日收盘` };
}

// ── 与 A 股的映射：写成数据，不写进 if ──────────────────────────────────────
// sign：该品种**上涨**对 A 股该方向的风险偏好是 +1 利好 / -1 利空 / 0 中性（仅结构参考）
export const GLOBAL_ANCHORS = [
  { from: 'a50', sign: 1, aSectors: ['上证指数', '沪深300', '券商', '银行', '白酒'],
    why: 'A50 成分即 A 股核心权重；休市期间它是唯一实时定价，节后开盘方向的第一参考' },
  { from: 'sox', sign: 1, aSectors: ['元件', '半导体', '消费电子', '光学光电子', 'PCB'],
    why: '费半与 A 股电子链共用同一批终端需求与客户，直接同源' },
  { from: 'ixic', sign: 1, aSectors: ['创业板指', '科创50', '软件开发', 'IT服务', '通信设备'],
    why: '纳指与 A 股成长风格同向' },
  { from: 'hxc', sign: 1, aSectors: ['互联网电商', '文化传媒', '教育', '医疗服务'],
    why: '金龙指数成分多为中概互联/教育/医疗，映射 A 股对应板块情绪' },
  { from: 'hsi', sign: 1, aSectors: ['银行', '保险', '房地产', '贵金属'],
    why: '港股与 A 股金融地产权重股重合度高（AH 联动）' },
  { from: 'dxy', sign: -1, aSectors: ['全市场流动性'],
    why: '美元走强 → 人民币承压 → 外资流入放缓、分母端偏紧' },
  { from: 'cnh', sign: -1, aSectors: ['全市场流动性', '航空', '造纸'],
    why: 'USDCNH 上涨即人民币贬值，对全市场风险偏好偏空（外币负债行业成本上升）' },
  { from: 'gold', sign: 0, aSectors: ['贵金属', '小金属'],
    why: '金价上行直接利好 A 股贵金属板块，但同时是避险信号，对整体风险偏好中性偏空' },
  { from: 'wti', sign: 0, aSectors: ['油气开采及服务', '石油加工贸易', '化学原料'],
    why: '油价上行利好上游、抬高中下游成本；单日大涨常对应输入型通胀预期' },
];

// ── 触发阈值（承压/支撑）─────────────────────────────────────────────────────
// 说明：阈值不是拍出来的——它是「该品种的日波动分布里，多少算异常」的口径选择。
// A50 期货日内波动显著小于 A 股现货，故阈值取 1.0%；SOX 与纳指取 2.0/1.5%。
export const WATCH_THRESHOLDS = {
  a50Down: -1.0, a50Up: 1.0,
  soxDown: -2.0, soxUp: 1.5,
  ixicDown: -1.5, ixicUp: 1.5,
  hxcDown: -3.0, hxcUp: 2.0,
  dxyUp: 0.8, dxyDown: -0.8,
  rmbDep: 0.5, rmbApp: 0.5, // 人民币贬值/升值 0.5%
  goldUp: 2.0, brentUp: 3.0,
  hsiDown: -2.0, hsiUp: 2.0,
};

// 承压/支撑的总分门限：|bias| 超过该值才给方向性结论，否则算震荡
export const WATCH_BIAS_GATE = 2;

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

/** "Sep 30 04:48PM EDT" + 年份 → "2026-09-30" */
export function parseETDate(et, year) {
  const m = /^([A-Za-z]{3})\s+(\d{1,2})/.exec(String(et || '').trim());
  if (!m || !MONTHS[m[1]]) return null;
  return `${year}-${String(MONTHS[m[1]]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
}

// ── 解析：新浪四套字段布局（索引已用真实响应逐位核对，勿凭印象改）──────────
// us   gb_*   [0]名称 [1]最新 [2]涨跌幅% [3]北京行情时间 [4]涨跌额 [5]开盘 [6]最高
//             [7]最低 [8]52周高 [9]52周低 [25]收盘时间(ET) [26]昨收 [29]年
// hk   rt_hk* [0]代码 [1]名称 [2]今开 [3]昨收 [4]最高 [5]最低 [6]最新 [7]涨跌额
//             [8]涨跌幅% [11]成交额 [12]成交量 [15]52周高 [16]52周低 [17]日期 [18]时间
// dxy  DINIW  [0]时间 [1]最新 [2]买价 [3]昨收 [5]开盘 [6]最高 [7]最低 [9]名称 [10]日期
// fx   fx_*   [0]时间 [1]最新 [2]买价 [3]昨收 [5]开盘 [6]最高 [7]最低 [9]名称
//             [14]52周高 [15]52周低 [17]日期
// hf   hf_*   [0]最新 [2]买价 [3]卖价 [4]最高 [5]最低 [6]时间 [7]昨收 [8]开盘
//             [12]日期 [13]名称
const NORMALIZERS = {
  us: (f) => ({
    name: f[0], last: num(f[1]), chgPctReported: num(f[2]), quoteTime: f[3], chgReported: num(f[4]),
    open: num(f[5]), high: num(f[6]), low: num(f[7]), hi52: num(f[8]), lo52: num(f[9]),
    prevClose: num(f[26]),
    sessionDate: parseETDate(f[25], num(f[29]) || '') || null,
  }),
  hk: (f) => ({
    name: f[1], last: num(f[6]), chgPctReported: num(f[8]), quoteTime: f[18], chgReported: num(f[7]),
    open: num(f[2]), high: num(f[4]), low: num(f[5]), hi52: num(f[15]), lo52: num(f[16]),
    prevClose: num(f[3]),
    sessionDate: (f[17] || '').replace(/\//g, '-') || null,
  }),
  dxy: (f) => ({
    name: f[9], last: num(f[1]), quoteTime: f[0], open: num(f[5]), high: num(f[6]), low: num(f[7]),
    prevClose: num(f[3]), hi52: null, lo52: null, sessionDate: f[10] || null,
  }),
  fx: (f) => ({
    name: f[9], last: num(f[1]), quoteTime: f[0], open: num(f[5]), high: num(f[6]), low: num(f[7]),
    prevClose: num(f[3]), hi52: num(f[14]), lo52: num(f[15]), sessionDate: f[17] || null,
  }),
  hf: (f) => ({
    name: f[13], last: num(f[0]), quoteTime: f[6], open: num(f[8]), high: num(f[4]), low: num(f[5]),
    prevClose: num(f[7]), hi52: null, lo52: null, sessionDate: f[12] || null,
  }),
};

/**
 * 解析新浪行情文本 → { '<code>': fields[] }。
 * 空响应（`=""`）返回空数组，交由上层判 ok=false —— 不在这里编造 0。
 */
export function parseSinaVars(text) {
  const out = {};
  const re = /var\s+hq_str_([A-Za-z0-9_$]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    out[m[1]] = m[2] === '' ? [] : m[2].split(',');
  }
  return out;
}

/**
 * 归一化单条行情。
 *
 * 涨跌幅规则（2026-10-01 事故后收紧，**这是本函数最要紧的一段**）：
 *   · 只有「本会话确实成交过」才现算 last/prevClose → chg/chgPct；
 *   · 会话未开盘 / 无成交（见 inferQuoteState）→ chg = chgPct = **null**，
 *     并在 stateText 写明「盘前无数据」。—— 严禁把占位平盘算成 0%。
 *   · 数据源在无成交时会把 chgPctReported 也写成 0.00，故**不能**用它兜底：
 *     只有 state === OK 时才采信 reported。
 * 同时保留数据源原值 chgPctReported，两者不一致即说明口径漂移。
 */
export function normalizeQuote(sym, fields) {
  const dp = GLOBAL_DP[sym.key] != null ? GLOBAL_DP[sym.key] : 2;
  const base = { key: sym.key, code: sym.code, name: sym.name, kind: sym.kind, role: sym.role,
    note: sym.note || null, ok: false, state: QUOTE_STATE.MISSING, stateText: '未取到',
    last: null, prevClose: null, chg: null, chgPct: null,
    chgPctReported: null, chgReported: null, hi52: null, lo52: null, quoteTime: null, sessionDate: null,
    open: null, high: null, low: null,
    dp, lastText: '—', chgPctText: '—' };
  if (!fields || !fields.length) return base;
  const q = NORMALIZERS[sym.kind](fields);
  if (!q || q.last == null) return { ...base, ...(q || {}), ok: false, state: QUOTE_STATE.MISSING };
  const state = inferQuoteState(q, sym.kind);
  if (state !== QUOTE_STATE.OK) {
    // 命中"未开盘/无成交"：保留 last 与 prevClose 供**人工核对**（价格本身是真值），
    //   但涨跌幅一律 null —— 让人一眼看见"这是没数据，不是没波动"。
    return { ...base, ...q, name: sym.name || q.name, ok: false, state,
      chg: null, chgPct: null,
      chgPctReported: q.chgPctReported ?? null,
      lastText: fmtNum(q.last, dp),
      chgPctText: state === QUOTE_STATE.PREOPEN ? '盘前无数据' : '无成交',
      stateText: state === QUOTE_STATE.PREOPEN ? '盘前无数据' : '无成交' };
  }
  let chg = null;
  let chgPct = null;
  if (q.prevClose) {
    chg = nz(+(q.last - q.prevClose).toFixed(6));
    chgPct = nz(+(chg / q.prevClose * 100).toFixed(4));
  } else if (q.chgPctReported != null) {
    chgPct = nz(q.chgPctReported);
  }
  return { ...base, ...q, name: sym.name || q.name, ok: true, state: QUOTE_STATE.OK, stateText: '',
    chg, chgPct,
    chgPctReported: q.chgPctReported ?? null,
    lastText: fmtNum(q.last, dp), chgPctText: fmtPct(chgPct, 2) };
}

/** 数值文案（缺失一律 '—'，不写 0） */
export function fmtNum(v, d = 2) {
  if (v == null || !Number.isFinite(+v)) return '—';
  return (+v).toFixed(d);
}

/** 涨跌幅文案（统一符号，用于信号文本与前端渲染，构建期生成 → 前端不再格式化一遍） */
export function fmtPct(v, d = 2) {
  if (v == null || !Number.isFinite(+v)) return '—';
  const r = +(+v).toFixed(d);
  // 抹掉 "-0.00%"：费半 9-30 收平于 -0.0043%，带上负号会把「收平」读成「下跌」
  if (r === 0) return `${(0).toFixed(d)}%`;
  return `${r > 0 ? '+' : ''}${r.toFixed(d)}%`;
}

/**
 * 组装快照。纯函数：给定原始文本 + 时刻 → 完整快照，便于离线测试。
 * @param {{raw: string, generatedAt?: string, aShareTradeDate?: string|null, holidays?: string[]}} o
 */
export function buildGlobalSnapshot(o = {}) {
  const vars = typeof o.raw === 'string' ? parseSinaVars(o.raw) : (o.raw || {});
  const quotes = GLOBAL_SYMBOLS.map((s) => normalizeQuote(s, vars[s.code]));

  // 人民币：USDCNH 上涨 = 人民币贬值。反号在**字段名**里说明，读的人不必心算。
  const cnh = quotes.find((q) => q.key === 'cnh');
  const cny = quotes.find((q) => q.key === 'cny');
  const rmb = {
    usdcnh_last: cnh && cnh.ok ? cnh.last : null,
    usdcnh_chg_pct: cnh && cnh.ok ? cnh.chgPct : null,
    rmb_up_pct: cnh && cnh.ok && cnh.chgPct != null ? nz(-cnh.chgPct) : null, // 正=人民币升值
    usdcny_last: cny && cny.ok ? cny.last : null,
  };

  // 美股会话日：取美股宽基里最大的 sessionDate（同一次收盘，各票应一致）
  const usDates = quotes.filter((q) => q.role === 'us_index').map((q) => q.sessionDate).filter(Boolean).sort();
  const usSessionDate = usDates.length ? usDates[usDates.length - 1] : null;

  // ★ failed 只收「**真的没拿到**」（字段缺失/解析不出）——即 state=missing。
  //   刻意**不**收 state=preopen/no-trade：那些品种**拿到了价**，只是"本会话还没成交"。
  //   两者语义完全不同，混在一起会让"盘前"看起来像"接口挂了"，
  //   掩盖真正的问题（抓取时机）并误导排查方向。会话无成交的清单单列 usNoSession。
  const failed = quotes.filter((q) => q.state === QUOTE_STATE.MISSING).map((q) => q.key);
  const generatable = quotes.filter((q) => q.state === QUOTE_STATE.OK).length;
  // ★ 抓取时机自检：美股这一档此刻是否已收盘可采信。
  //   这是 2026-10-01 事故的根因位——当时抓到北京 21:10 = 美东 09:10（盘前 20 分钟），
  //   数据源给的是占位平盘，被当成"当日 0%"用了。故把判断**留在快照里**，
  //   前端与守卫都能看见"这一份快照是在什么时候取的、当时美股收盘了没有"。
  const genDate = o.generatedAt ? new Date(o.generatedAt) : new Date();
  const readiness = usSessionReadiness(genDate);
  const usQuotesStale = quotes.filter((q) => q.kind === 'us' && q.state !== QUOTE_STATE.OK).map((q) => q.key);
  const snap = {
    meta: {
      generatedAt: genDate.toISOString(),
      source: 'sina',
      sourceUrl: SINA_URL,
      usSessionDate,
      aShareTradeDate: o.aShareTradeDate || null,
      quoteCount: quotes.length,
      okCount: generatable,
      failed,
      // 美股抓取时机（可核验：et 时刻 + 是否已收盘 + 未就绪原因）
      usReadiness: {
        ready: readiness.ready,
        etText: readiness.etText,
        reason: readiness.reason,
        readyAfterEt: '16:30 ET（收盘 + 30 分钟结算缓冲）= 北京次日 04:30',
      },
      // 美股里"本会话尚无成交"的品种（与 failed 分开：failed 是没抓到，这里是有价但无成交）
      usNoSession: usQuotesStale,
      note: '外围行情来自新浪（hq.sinajs.cn）。涨跌幅一律由 last/prevClose 现算，'
        + '且**仅在该品种本会话确实成交时**才给值；未开盘/无成交一律 null 并标「盘前无数据」，'
        + '绝不写 0（0 是真实行情值，会把"不知道"伪装成"没波动"）。'
        + '美股档只在美东 16:30（=北京次日 04:30）后才可采信，早于此取的数不作收盘价用。'
        + '本模块 A 股休市期间照常更新，唯一目的是给节后开盘提供可核验的外部底座。非投资建议。',
    },
    quotes,
    rmb,
    anchors: GLOBAL_ANCHORS,
    thresholds: WATCH_THRESHOLDS,
  };
  snap.watch = evaluateGlobalWatch(snap);
  return snap;
}

/**
 * 触发式观测：只有越过阈值才输出信号（与 app.js「明日观测」同一思路——不做固定清单）。
 *
 * 输出策略分两档，避免刷屏又保证主锚不缺位：
 *   主锚（A50 期货 / 费半 / 中国金龙）——**必报**，未触发时也给出读数与「无明确方向」；
 *   次锚（纳指 / FXI / 美元指数 / 人民币 / 黄金 / 油价 / 港股）——**触发才报**，静默即正常。
 *
 * ★ 第三档：**数据缺失**（2026-10-01 事故后新增，本函数最要紧的一段）
 *   品种取不到 / 会话未开盘时，**必须**输出「数据缺失 — 未参与判定」，且**不计入 bias**。
 *   绝不能沿用主锚的「无明确方向」文案 —— 那会让"不知道"被读成"看过了，是中性"。
 *   主锚缺数据时还会置 abstain，把整体结论降级为「判据不足」，不冒充「外围中性」。
 *
 * bias > 0 偏多 / < 0 偏空；|bias| ≤ WATCH_BIAS_GATE 视为震荡，不给方向性结论。
 */
export function evaluateGlobalWatch(snap) {
  const q = Object.fromEntries((snap.quotes || []).map((x) => [x.key, x]));
  const get = (k) => (q[k] && q[k].ok ? q[k] : null);
  const pct = (k) => (get(k) ? get(k).chgPct : null);
  // 缺失原因文案（把 state 翻成人话；区分"没抓到"与"盘前没数据"）
  const whyOf = (k) => {
    const x = q[k];
    if (!x) return '未取到';
    // 只返回「原因短语」，不要带括号——外层模板已有一对括号，里外叠起来会变成
    //   「数据缺失（盘前无数据（该会话尚未开盘））」，读起来像嵌套错误。
    if (x.state === QUOTE_STATE.PREOPEN) return '该会话尚未开盘，源给的是盘前占位';
    if (x.state === QUOTE_STATE.NO_TRADE) return '该会话无成交，源给的是平盘占位';
    return '本次未取到该品种';
  };
  const T = WATCH_THRESHOLDS;
  const signals = [];
  let bias = 0;
  const missing = [];          // 缺数据的品种（key）
  const push = (level, key, text, w) => { signals.push({ level, key, text }); bias += w; };
  // ★ 缺失哨兵：level='unknown' + weight 恒 0，并在信号里写明原因。
  //   与 push 分开写是为了防"顺手给个权重"——缺失不允许有任何方向性贡献。
  const pushMissing = (key, label, main) => {
    missing.push(key);
    signals.push({
      level: 'unknown', key,
      text: `${label} 数据缺失（${whyOf(key)}）→ 未参与判定`,
      missing: true, main: !!main,
    });
  };
  // 「无明确方向」分支的微幅权重：0.05% 以内视为真的没动（否则 0.004% 也会带上方向）
  const nudge = (v) => (Math.abs(v) < 0.05 ? 0 : (v > 0 ? 0.5 : -0.5));

  // ① A50 期货——长假期间唯一实时锚，权重最高（主锚，必报）
  const a50 = pct('a50');
  if (a50 != null) {
    if (a50 <= T.a50Down) push('warn', 'a50', `A50 期货 ${fmtPct(a50)}（≤${T.a50Down}%）→ 外资对 A 股权重给出下修定价，节后低开压力`, -3);
    else if (a50 >= T.a50Up) push('ok', 'a50', `A50 期货 ${fmtPct(a50)}（≥+${T.a50Up}%）→ 外资对 A 股权重给出上修定价，节后偏强`, 3);
    else push('info', 'a50', `A50 期货 ${fmtPct(a50)} → 假期定价基本持平，无明确方向`, nudge(a50));
  } else pushMissing('a50', 'A50 期货（主锚）', true);

  // ② 电子链（费半）——PCB/元件/半导体的同源锚（主锚，必报）
  const sox = pct('sox');
  if (sox != null) {
    if (sox <= T.soxDown) push('warn', 'sox', `费半 ${fmtPct(sox)}（≤${T.soxDown}%）→ 电子链（元件/PCB/半导体）情绪承压`, -2);
    else if (sox >= T.soxUp) push('ok', 'sox', `费半 ${fmtPct(sox)}（≥+${T.soxUp}%）→ 电子链情绪有支撑`, 2);
    else push('info', 'sox', `费半 ${fmtPct(sox)}，在 ±${Math.abs(T.soxDown)}% 以内 → 电子链无明确方向`, nudge(sox));
  } else pushMissing('sox', '费半（主锚）', true);

  // ③ 成长风格（纳指）
  const ixic = pct('ixic');
  if (ixic != null) {
    if (ixic <= T.ixicDown) push('warn', 'ixic', `纳指 ${fmtPct(ixic)} → 成长风格（创业板/科创）承压`, -1);
    else if (ixic >= T.ixicUp) push('ok', 'ixic', `纳指 ${fmtPct(ixic)} → 成长风格有支撑`, 1);
  } else pushMissing('ixic', '纳指');

  // ④ 中国资产（金龙 / FXI）——金龙为主锚，必报
  const hxc = pct('hxc');
  if (hxc != null) {
    if (hxc <= T.hxcDown) push('warn', 'hxc', `中国金龙指数 ${fmtPct(hxc)}（≤${T.hxcDown}%）→ 外资对中国资产风险偏好下降`, -2);
    else if (hxc >= T.hxcUp) push('ok', 'hxc', `中国金龙指数 ${fmtPct(hxc)}（≥+${T.hxcUp}%）→ 外资对中国资产risk-on`, 2);
    else push('info', 'hxc', `中国金龙指数 ${fmtPct(hxc)} → 外资对中国资产无异动`, 0);
  } else pushMissing('hxc', '中国金龙指数（主锚）', true);
  const fxi = pct('fxi');
  if (fxi != null && Math.abs(fxi) >= T.hxcUp) {
    const lv = fxi > 0 ? 'ok' : 'warn';
    push(lv, 'fxi', `富时中国ETF（FXI） ${fmtPct(fxi)} → 与中国金龙同向印证`, fxi > 0 ? 1 : -1);
  }

  // ⑤ 汇率（分母端 / 外资流向）
  const dxy = pct('dxy');
  if (dxy != null) {
    if (dxy >= T.dxyUp) push('warn', 'dxy', `美元指数 ${fmtPct(dxy)}（≥+${T.dxyUp}%）→ 人民币与外资流入承压（分母端偏紧）`, -1.5);
    else if (dxy <= T.dxyDown) push('ok', 'dxy', `美元指数 ${fmtPct(dxy)}（≤${T.dxyDown}%）→ 分母端压力缓解`, 1.5);
  } else pushMissing('dxy', '美元指数');
  const rmb = snap.rmb || {};
  if (rmb.rmb_up_pct != null) {
    if (rmb.rmb_up_pct <= -T.rmbDep) push('warn', 'cnh', `离岸人民币 ${fmtPct(rmb.rmb_up_pct)}（贬值 ${Math.abs(rmb.rmb_up_pct).toFixed(2)}%）→ 外资流出压力`, -1.5);
    else if (rmb.rmb_up_pct >= T.rmbApp) push('ok', 'cnh', `离岸人民币 ${fmtPct(rmb.rmb_up_pct)}（升值 ${rmb.rmb_up_pct.toFixed(2)}%）→ 外资流入有支撑`, 1.5);
  }

  // ⑥ 商品（避险 / 输入型通胀）
  const gold = pct('gold');
  if (gold != null && gold >= T.goldUp) push('warn', 'gold', `COMEX 黄金 ${fmtPct(gold)}（≥+${T.goldUp}%）→ 避险情绪升温，但直接利好 A 股贵金属`, -1);
  const wti = pct('wti');
  if (wti != null && wti >= T.brentUp) push('warn', 'wti', `WTI ${fmtPct(wti)}（≥+${T.brentUp}%）→ 输入型通胀/成本压力，利好上游`, -1);

  // ⑦ 港股（与 A 股共用假期，节前最后一日对照）
  const hsi = pct('hsi');
  if (hsi != null) {
    if (hsi <= T.hsiDown) push('warn', 'hsi', `恒生指数 ${fmtPct(hsi)}（≤${T.hsiDown}%）→ 港股先行走弱`, -1);
    else if (hsi >= T.hsiUp) push('ok', 'hsi', `恒生指数 ${fmtPct(hsi)}（≥+${T.hsiUp}%）→ 港股先行走强`, 1);
  }

  const isHoliday = !!(snap.meta && snap.meta.aShareHoliday);
  // ★ 主锚缺数据 → 整体结论降级为「判据不足」，**不得**冒充「外围中性」。
  //   主锚（A50/费半/金龙）是这套映射的方向来源；它们缺位时 bias 只剩边角料，
  //   此时给"中性"等于用一个残缺样本冒充完整结论。
  const mainMissing = signals.filter((s) => s.missing && s.main).map((s) => s.key);
  let verdict;
  if (mainMissing.length) {
    verdict = {
      key: 'insufficient',
      label: '判据不足',
      hint: '主锚（A50 期货 / 费半 / 中国金龙）中有品种未取到数据，外围方向**无法判定**——'
        + '这不是"外围中性"，而是"没看到"。节后开盘请认准 A 股自身资金与主线，勿以本栏为方向依据。',
    };
  } else if (bias >= WATCH_BIAS_GATE) verdict = { key: 'positive', label: '外围偏多', hint: '外围未构成压制，A 股可按原计划观察自身主线能否重新集结' };
  else if (bias <= -WATCH_BIAS_GATE) verdict = { key: 'negative', label: '外围偏空', hint: '外围构成压制，开盘先执行预案里的「继续观望」，等 A 股自身承接信号再谈进攻' };
  else verdict = { key: 'neutral', label: '外围中性', hint: '外围未给方向，A 股开盘方向主要由自身资金决定，重点看主线反核与量能' };

  return {
    verdict, bias: Math.round(bias * 10) / 10, signals, biasGate: WATCH_BIAS_GATE, holiday: isHoliday,
    missing, mainMissing,
    // 判定口径自述（前端直接展示，不再自己拼一遍）
    missingNote: missing.length
      ? `${missing.length} 个品种数据缺失（${missing.join('、')}），已按"未参与判定"处理，不计入方向分。`
        + '缺失 ≠ 中性：把没数据读成"没波动"会伪造出一个确定结论。'
      : '',
  };
}
