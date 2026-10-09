// 席位口径唯一来源（券商主体 / 席位类型 / 买卖双侧明细读取）
//
// 为什么单独成文件：席位名要同时被「个股详情抽屉」「锁仓/新进资金统计」「未来可能的报告」
// 使用。若各处手写字符串解析，同一家券商会因为写法差异（「股份有限公司」/「有限责任公司」/
// 带括号的「(中国)」）被判成不同主体，跨日跨票的聚合就会悄悄错位。
//
// 关于「游资身份」的诚实边界：
//   市面上流传的"某营业部 = 某游资大佬"名单多数无法核验，且席位会被转租、资金会换营业部。
//   本模块**不做**这种点名归属——那是猜测，不是数据。只输出可核验的结构性事实：
//     · 券商主体（名称里唯一确定的机构）
//     · 席位类型（机构专用 / 沪深股通 / 券商总部·自营 / 分公司 / 营业部）
//     · 是否外资券商（名称含高盛/瑞银/摩根等，其席位多为 QFII 通道性质）
//   这些都能从名称本身直接读出，不需要外部名单，也不会随时间失效。

/** 买卖双侧明细的规范形态 */
export const SIDE = { BUY: 'b', SELL: 's' };

/**
 * 「类别汇总行」判定 —— 东财席位明细接口的非席位污染行。
 *
 * 为什么必须剔除：东财 RPT_BILLBOARD_DAILYDETAILSBUY/SELL 在**部分票**（尤其「连续N日累计」
 * 涨跌幅偏离类区间榜）里，除了真正的 5 个买卖席位，还会混入交易所披露的**投资者结构汇总行**：
 * 「自然人」「中小投资者」「机构」「其他自然人」等。它们不是任一营业部/席位，而是该股
 * 买入（卖出）总额按投资者类型拆分的统计口径行，金额量级与整只票的成交额同阶。
 *
 * 不剔除的后果（2026-09-30 实测，真 bug）：
 *   · 688137 近岸蛋白 一条区间榜记录 BILLBOARD_BUY_AMT = 116.97 亿（正常应为 5.01 亿，放大 23.4 倍），
 *     席位明细里「自然人 75.8 亿 + 中小投资者 41.49 亿 + 机构 41.17 亿 + 其他自然人 34.31 亿」合计 192.77 亿；
 *   · 这 4 行被 classifySeat 判成 hot（既非「机构专用」也非「股通」）→ 游资买入被虚增 192.77 亿；
 *   · 同时进入全市场买方合计 buyAll，把 buy_top3_pct 的分母从 139.67 亿抬到 332.44 亿，
 *     集中度从 44.5% 被稀释到 18.7%（错了一个量级档位：中等 → 分散）；
 *   · 个股层面 近岸蛋白的「买方前三集中度」被这 4 行占满，虚高到 80.1% 并挤进 TOP5。
 *
 * 判据：名称**完全等于**这些投资者类别词（不做包含匹配）——真实席位名再短也带券商主体或
 * 「营业部/分公司/专用/总部」，不会恰好只有这几个词，所以全等匹配足够且不会误杀。
 */
const AGGREGATE_ROW_NAMES = new Set([
  '自然人', '机构', '中小投资者', '其他自然人', '其他机构', '专业机构', '个人投资者', '非金融类上市公司',
]);
export function isAggregateSeatRow(name) {
  return AGGREGATE_ROW_NAMES.has(String(name || '').trim());
}

/**
 * 读取某票的席位明细，并把**旧格式（仅买方数组）与新格式（{b,s}）统一**成同一形态。
 * 存量存档不会因字段升级而重算，历史天数仍是旧格式——调用方不必关心这件事。
 * @returns {{b: Array<[string, number]>, s: Array<[string, number]>, hasSell: boolean}}
 */
export function seatsOf(detailMap, code) {
  const raw = detailMap && code != null ? detailMap[code] : null;
  if (!raw) return { b: [], s: [], hasSell: false };
  // 旧格式：直接是 [[名, 额], ...]，只有买方
  if (Array.isArray(raw)) return { b: raw.map(normPair).filter(keepSeat), s: [], hasSell: false };
  const b = Array.isArray(raw.b) ? raw.b.map(normPair).filter(keepSeat) : [];
  const s = Array.isArray(raw.s) ? raw.s.map(normPair).filter(keepSeat) : [];
  return { b, s, hasSell: s.length > 0 };
}

// 过滤掉「类别汇总行」——它们不是席位，是交易所的投资者结构统计行（见 isAggregateSeatRow）。
// 这里是**唯一读取出口**：所有消费方（锁仓/新进、席位身份下钻、报告抽屉）都经此函数，
// 故净化只需做一次，不必在每个调用点重复判。
const keepSeat = ([nm]) => !isAggregateSeatRow(nm);

const normPair = (p) => (Array.isArray(p)
  ? [String(p[0] ?? ''), Number(p[1]) || 0]
  : [String(p?.name ?? ''), Number(p?.v ?? p?.amount ?? 0) || 0]);

/** 该票买方席位明细（兼容新旧格式），按金额降序 */
export function buySeatsOf(detailMap, code) {
  return seatsOf(detailMap, code).b.slice().sort((x, y) => y[1] - x[1]);
}

/** 该票卖方席位明细（旧格式下恒为空数组），按金额降序 */
export function sellSeatsOf(detailMap, code) {
  return seatsOf(detailMap, code).s.slice().sort((x, y) => y[1] - x[1]);
}

/** 某一侧的合计（万元）与该侧前 3 占比（%） */
export function sideStats(pairs) {
  const rows = Array.isArray(pairs) ? pairs : [];
  const sum = rows.reduce((a, x) => a + (Number(x[1]) || 0), 0);
  const top3 = rows.slice().sort((x, y) => y[1] - x[1]).slice(0, 3)
    .reduce((a, x) => a + (Number(x[1]) || 0), 0);
  return { n: rows.length, sum, top3Pct: sum > 0 ? top3 / sum * 100 : null };
}

// ────────────────────────── 席位身份解析 ──────────────────────────

// 券商主体：取名称里第一个「…证券/…基金/…资管」片段，去掉公司后缀与括号地域
// 例：国泰海通证券股份有限公司南京胜利路证券营业部 → 国泰海通证券
//     高盛(中国)证券有限责任公司上海浦东新区世纪大道证券营业部 → 高盛(中国)证券
//     中信建投证券股份有限公司上海分公司 → 中信建投证券
//     某某基金管理有限公司 → 某某基金（"管理"属通用业务后缀，并入后缀剥离）
export function brokerOf(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  // 机构专用 / 股通专用 没有券商主体
  if (/机构专用/.test(s) || /(沪|深)股通/.test(s)) return '';
  // 尾部通用词一并剥离：公司后缀（股份/有限/责任/公司）与业务后缀（管理/控股）。
  // 注意：机构关键词必须**长词在前**（资产管理 先于 资管），否则惰性量词会把
  // "某某资产管理有限公司" 切成 "某某资管…"，主体名被截短后与其他写法对不上。
  const INST = '资产管理|证券|基金|资管|期货';
  const TAIL = '(?:股份)?有限(?:责任)?公司|管理|控股';
  const m = s.match(new RegExp('^(.{2,30}?(?:' + INST + '))(?:' + TAIL + '|\\(|（|$)'));
  if (m) return m[1].trim();
  // 兜底：开头到第一个「股份有限公司/有限责任公司」
  const m2 = s.match(/^(.{2,30}?)(?:股份有限公司|有限责任公司|有限公司)/);
  if (m2) return m2[1].trim();
  // 再兜底：取前 6 个字（保证不返回空，宁可粗也不空）
  return s.slice(0, 6);
}

/**
 * 席位类型。判据全部来自名称本身，不依赖外部名单：
 *   inst  机构专用（公募/保险等专用席位，不披露具体机构）
 *   north 沪深股通（北向资金通道）
 *   prop  券商总部/自营（"总部"(不含营业部) / 自营 / 证券投资部）
 *   branch 分公司（省级/地市级分公司，多为互联网开户归集，散户与量化混聚）
 *   sales 证券营业部（传统营业部席位）
 *   other 无法归类
 */
export function seatTypeOf(name) {
  const s = String(name || '').trim();
  if (!s) return 'other';
  if (/机构专用/.test(s)) return 'inst';
  if (/(沪|深)股通/.test(s)) return 'north';
  if (/总部/.test(s) || /自营/.test(s) || /证券投资部/.test(s)) return 'prop';
  if (/营业部/.test(s)) return 'sales';
  if (/分公司|分公司$/.test(s)) return 'branch';
  if (/证券|基金|资管/.test(s)) return 'sales'; // 有券商名但既无营业部也无分公司后缀，按营业部性质处理
  return 'other';
}

export const SEAT_TYPE_LABEL = {
  inst: '机构专用',
  north: '沪深股通',
  prop: '券商总部/自营',
  branch: '分公司',
  sales: '证券营业部',
  other: '其他',
};

/** 外资/合资券商：仅作性质标注，不代表必然为外资资金 */
const FOREIGN_BROKERS = ['高盛', '瑞银', '摩根', '瑞信', '野村', '大和', '汇丰', '花旗', '德意志', '星展', '法兴', '巴黎'];

/** 是否为外资/合资券商主体（其营业部席位常为 QFII/通道性质） */
export function isForeignBroker(name) {
  const b = brokerOf(name) || String(name || '');
  return FOREIGN_BROKERS.some((f) => b.includes(f));
}

/**
 * 席位地区：从营业部名里取城市，用于"同城席位聚集"这类结构性观察。
 * 只做**可核验**的抽取，取不到就返回空，不猜。
 *
 * 为什么用城市白名单而不是"切出 2~4 字"：
 *   营业部名是「主体+地名+路名+营业部」的连写串，用开放式正则切分必然会切错——
 *   实测把「南京胜利路」切成「南京胜利」、「上海浦东新区」切成「海浦东新」
 *   （主体剥离残留 + 贪婪匹配把路名前缀一起吞掉）。这种"看起来对、细看全错"的
 *   结果比返回空更危险。因此改为：在**已知城市名**里做最长匹配，地名表是封闭集合，
 *   匹配不到就返回空。营业部所在地一定是地级市及以上，白名单覆盖足够。
 * 例：…南京胜利路证券营业部 → 南京；…上海长宁区江苏路… → 上海；…拉萨团结路第二… → 拉萨
 */
// 直辖市 + 计划单列市 + 省会 + 主要地级市（营业部常驻地，封闭集合，非穷举也无妨）
const CITY_LIST = [
  // 直辖市
  '北京', '上海', '天津', '重庆',
  // 计划单列市
  '深圳', '宁波', '青岛', '大连', '厦门',
  // 省会
  '广州', '杭州', '南京', '武汉', '成都', '西安', '长沙', '郑州', '济南', '合肥',
  '福州', '昆明', '南昌', '贵阳', '南宁', '兰州', '太原', '石家庄', '沈阳', '哈尔滨',
  '长春', '呼和浩特', '银川', '西宁', '乌鲁木齐', '海口', '拉萨',
  // 主要地级市 / 江浙沪粤等营业部密集城市
  '苏州', '无锡', '常州', '南通', '徐州', '扬州', '盐城', '泰州', '镇江', '淮安',
  '连云港', '宿迁', '温州', '嘉兴', '绍兴', '金华', '台州', '湖州', '丽水', '衢州',
  '舟山', '东莞', '佛山', '珠海', '中山', '惠州', '江门', '汕头', '湛江', '肇庆',
  '泉州', '漳州', '莆田', '龙岩', '三明', '南平', '宁德', '烟台', '潍坊', '临沂',
  '淄博', '济宁', '泰安', '威海', '东营', '日照', '洛阳', '开封', '新乡', '南阳',
  '许昌', '焦作', '安阳', '平顶山', '商丘', '信阳', '周口', '驻马店', '漯河', '三门峡',
  '襄阳', '宜昌', '荆州', '黄石', '十堰', '荆门', '孝感', '岳阳', '株洲', '湘潭',
  '衡阳', '常德', '郴州', '绵阳', '德阳', '宜宾', '泸州', '南充', '乐山', '自贡',
  '内江', '遂宁', '眉山', '遵义', '六盘水', '曲靖', '玉溪', '大理', '桂林', '柳州',
  '北海', '梧州', '玉林', '湛江', '宝鸡', '咸阳', '渭南', '榆林', '延安', '汉中',
  '唐山', '保定', '廊坊', '沧州', '邯郸', '邢台', '衡水', '秦皇岛', '张家口', '承德',
  '大同', '临汾', '运城', '长治', '包头', '鄂尔多斯', '鞍山', '抚顺', '本溪', '锦州',
  '营口', '盘锦', '吉林', '齐齐哈尔', '大庆', '牡丹江', '芜湖', '蚌埠', '安庆', '马鞍山',
  '阜阳', '宿州', '六安', '滁州', '宣城', '铜陵', '黄山', '九江', '赣州', '上饶',
  '宜春', '吉安', '抚州', '景德镇', '萍乡', '新余', '鹰潭', '三亚', '儋州',
];

// 按长度降序（避免"上海"抢先匹配掉更长的地名）；此处城市名均为 2~3 字
const CITY_SORTED = CITY_LIST.slice().sort((a, b) => b.length - a.length);

/**
 * 找名称中出现的最靠前、且最长的城市名。
 * 用 lastIndexOf 无法判先后，故逐个城市扫描取「最早出现位置」，同位置取最长。
 */
function findCity(s) {
  let best = null;
  let bestPos = Infinity;
  for (const c of CITY_SORTED) {
    const p = s.indexOf(c);
    if (p === -1) continue;
    if (p < bestPos || (p === bestPos && best && c.length > best.length)) {
      best = c;
      bestPos = p;
    }
  }
  return best || '';
}

export function cityOf(name) {
  const s = String(name || '').trim();
  if (!s || /机构专用|(沪|深)股通/.test(s)) return '';
  // 只在「券商主体之后」的地名段里找，避免把主体名里碰巧含城市的字（如"长江证券"含"江"）算进去
  // 主体剥离：去掉到第一个公司后缀为止的前缀（含括号地域），与 brokerOf 用同一套词表
  let seg = s.replace(new RegExp('^(.*?(?:资产管理|证券|基金|资管|期货))(?:(?:股份)?有限(?:责任)?公司|管理|控股|$)'), '');
  if (!seg) seg = s;
  seg = seg.replace(/^[（(][^）)]*[）)]/, ''); // 去掉「(中国)」这类括号地域
  return findCity(seg);
}

/**
 * 一次性解析出席位的全部可核验身份。
 * @returns {{name,broker,type,typeLabel,foreign,city}}
 */
export function seatIdentity(name) {
  const s = String(name || '').trim();
  const type = seatTypeOf(s);
  return {
    name: s,
    broker: brokerOf(s),
    type,
    typeLabel: SEAT_TYPE_LABEL[type] || '其他',
    foreign: isForeignBroker(s),
    city: cityOf(s),
  };
}
