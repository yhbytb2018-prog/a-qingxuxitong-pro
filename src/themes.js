// 题材去噪：标准词典归一 + 个股级去重 + 全局孤点剔除
// 用法：const d = new ThemeDenoiser(); d.fit(allDays); const byDay = d.themesAllDays(allDays);

// 1) 标准题材词典：表面变体 -> 标准题材
const CANON = {
  // 国资 / 改革
  '上海国资': '国企改革', '广州国资': '国企改革', '广州国资入主': '国企改革',
  '深圳国资': '国企改革', '福建国资': '国企改革', '珠海国资': '国企改革',
  '黑龙江国资': '国企改革', '国资背景': '国企改革', '国企': '国企改革',
  '国企背景': '国企改革', '国资': '国企改革', '央企': '国企改革',
  // 并购 / 重组
  '控股变更': '并购重组', '控制权变更': '并购重组', '控制权拟变更': '并购重组',
  '控股股东拟变更': '并购重组', '资产重组': '并购重组', '重大资产重组': '并购重组',
  '拟收购': '并购重组', '拟收购民族出版社': '并购重组', '拟收购界面财联社': '并购重组',
  '股份转让': '并购重组', '股权转让': '并购重组', '溢价转让': '并购重组', '协议转让': '并购重组',
  '定增审核': '并购重组', '大股东增持': '并购重组',
  // AI / 算力
  'AI应用': 'AI算力', 'AI应用出海': 'AI算力', 'AI终端': 'AI算力', 'AI服务器': 'AI算力',
  'AI服务器电源': 'AI算力', 'AI算力': 'AI算力', 'AI文旅': 'AI算力', '智算云': 'AI算力',
  '算力': 'AI算力', '算力硬件': 'AI算力', '算力租赁': 'AI算力', '算力基础设施': 'AI算力',
  '垂直大模型': 'AI算力', '智谱AI': 'AI算力', '政务智能体': 'AI算力', '政务数字化': 'AI算力',
  // 文化传媒
  '文化传媒': '文化传媒', '图书发行': '文化传媒', '教科书发行': '文化传媒', '数字教育': '文化传媒',
  '广电网络': '文化传媒', '杭州日报': '文化传媒', '影视制作': '文化传媒', '视听大数据': '文化传媒',
  '视听安全': '文化传媒', '媒体内容安全监测': '文化传媒', '出版发行': '文化传媒',
  // 医药
  '创新药': '医药', 'AI医疗': '医药', '中药大健康': '医药', '独家中药': '医药', '化学制药': '医药',
  '医疗器械': '医药', '体外诊断': '医药', '基因检测': '医药', '医药数字化': '医药', '医药流通': '医药',
  '药品注册': '医药', '解热镇痛': '医药', '呼吸用药': '医药', '皮肤科学': '医药', '阿尔茨海默病': '医药',
  '三代测序': '医药', '健康机器人': '医药',
  // PCB
  'PCB': 'PCB', 'PCB概念': 'PCB', 'PCB刀具': 'PCB', 'PCB用化学试剂': 'PCB', 'PCB设备': 'PCB',
  'PCB铜箔': 'PCB', '高端PCB': 'PCB', '高阶HDI': 'PCB', '高端HDI': 'PCB', 'HDI': 'PCB', 'HDI板': 'PCB', '覆铜板': 'PCB', '高速覆铜板': 'PCB', '印制电路板': 'PCB', '印刷电路板': 'PCB', '多层板': 'PCB',
  // 光通信 / MLCC
  '光模块': '光通信', '高速光模块': '光通信', '光纤光缆': '光通信', '光通信': '光通信',
  '光通信测试': '光通信', 'PI膜': '光通信', 'TAC膜': '光通信', 'MLCC': '光通信', 'MLCC离型膜': '光通信',
  // 半导体
  '半导体': '半导体', '半导体IP': '半导体', '半导体硅片': '半导体', '半导体设备': '半导体',
  '半导体测试': '半导体', '半导体装备': '半导体', '半导体超纯水膜': '半导体',
  '功率半导体IDM': '半导体', '碳化硅衬底': '半导体', '先进封装': '半导体',
  // 液冷
  '液冷': '液冷', '液冷散热': '液冷', '液冷服务器': '液冷',
  // 电子
  '电子化学品': '电子', '电子玻璃': '电子', '玻璃基板': '电子', '消费电子': '电子',
  '消费电子包装': '电子', '苹果供应链': '电子', '存储芯片': '电子',
  // 机器人
  '机器人': '机器人', '机器人缝制': '机器人', '机器人轴承': '机器人', '机器人电池': '机器人',
  '机器人线束': '机器人', '机器人结构件': '机器人', '七腾机器人': '机器人', '水务机器人': '机器人',
  '环卫机器人': '机器人', '工业母机': '机器人', '具身智能': '机器人', '人形机器人': '机器人',
  '间接投资宇树科技': '机器人',
  // 新能源
  '固态电池': '新能源', '储能': '新能源', '锂电铜箔': '新能源', '电池箔': '新能源', '氢能汽车': '新能源',
  '氢氟酸': '新能源', '清洁能源': '新能源', '海上风电': '新能源', '风电铸件': '新能源',
  '风电轴承': '新能源', '风电齿轮箱': '新能源', '风电设备': '新能源',
  // 智能网 / 车联网
  '智能驾驶': '智能网', '车联网': '智能网', '车路云': '智能网', '智能电网': '智能网',
  '智能输配电': '智能网', '智能配电': '智能网', 'V2G': '智能网', '特高压': '智能网', '虚拟电厂': '智能网',
  // 商业航天 / 低空
  '商业航天': '商业航天', '卫星智算': '商业航天', '低空经济': '低空经济',
  // 业绩线
  '业绩增长': '业绩线', '净利增长': '业绩线', '业绩扭亏': '业绩线', '半年报增长': '业绩线',
  '半年报减亏': '业绩线', '中报增长': '业绩线', '中报扭亏': '业绩线', '扭亏为盈': '业绩线',
  '净利润增长': '业绩线',
  // 网络安全
  'AI安全': '网络安全', '网络安全': '网络安全', '网络靶场': '网络安全', '数据安全': '网络安全',
  '数据标注': '网络安全', '数字风洞': '网络安全',
};

// 2) 黑名单：单只票专属诱因 / 非可投资题材
const BLACKLIST = new Set([
  '拟收购界面财联社', '拟收购民族出版社', '教科书发行', '图书发行', '杭州日报',
  '参股神州龙芯（CPU）', '参股CPU', '一汽配套', '索具龙头', '深海系泊', '炭黑龙头',
  '炭黑涨价', '高端黄酒', '黄酒主业', '针织服装', '鸭业全产业链', '羽绒出口', '贴牌加工',
  '服装贴牌', '家电复材', '模切业务', '导热凝胶', '电容配件', '铝板带', '锡锑铟',
  '铁路扣件合同', '矿业整合', '硅砂矿', '矿山服务', '盐湖提锂', '玉米种业', '安赛蜜',
  '精细化工', '食品饲料添加剂', '高纯四氯化硅', '功能性硅烷', '日用陶瓷', '日用陶瓷出口',
  '纺织主业', '纺织印染', '绿色低碳', '绿色印染', '造纸化学品', '聚酯薄膜', '膜分离',
  '航空零部件', '精密制造', '高端部件', '易开盖', '烟标印刷', '热电联产', '特种电缆',
  '电线电缆', '电力服务', '电力水电', '生态水利', '生活用纸', '客户资源', '客户拓展',
  '订单充足', '订单增长', '产能扩张', '产能满产', '大兆瓦装备', '大尺寸拓展', '多元化布局',
  '行业龙头', '华字辈', '兰亭', '哪吒重整', '安哥拉电解铝', '客车销量', '导电炭黑',
  '岩土固化', '岩土固化剂', '环卫自动驾驶', '环卫装备', '海南自贸港', '游船票务',
]);

function tokenize(reason) {
  if (!reason) return [];
  return String(reason).split(/[＋+]/).map((t) => t.trim()).filter(Boolean);
}

function normalizeToken(tok) {
  if (BLACKLIST.has(tok)) return null;
  if (CANON[tok]) return CANON[tok];
  return tok;
}

export class ThemeDenoiser {
  constructor({ minGlobalStocks = 2 } = {}) {
    this.minGlobalStocks = minGlobalStocks;
    this.validThemes = new Set();
  }

  fit(allDays) {
    const globalStocks = {};
    for (const d of allDays) {
      for (const stk of d.hot || []) {
        const seen = new Set();
        for (const tok of tokenize(stk.reason)) {
          const th = normalizeToken(tok);
          if (th && !seen.has(th)) {
            seen.add(th);
            (globalStocks[th] = globalStocks[th] || new Set()).add(stk.code);
          }
        }
      }
    }
    this.validThemes = new Set(
      Object.keys(globalStocks).filter((th) => globalStocks[th].size >= this.minGlobalStocks)
    );
    return this;
  }

  // 返回 {标准题材: Set(个股code)}
  themesPerDay(day) {
    const res = {};
    for (const stk of day.hot || []) {
      const seen = new Set();
      for (const tok of tokenize(stk.reason)) {
        const th = normalizeToken(tok);
        if (th && this.validThemes.has(th) && !seen.has(th)) {
          seen.add(th);
          (res[th] = res[th] || new Set()).add(stk.code);
        }
      }
    }
    return res;
  }

  themesAllDays(allDays) {
    return allDays.map((d) => this.themesPerDay(d));
  }
}

// 动量：近N日 vs 前N日（按窗口内覆盖个股数判定存在）
export function computeMomentum(themesByDay, recentN, prevN, minStocks = 2) {
  const N = themesByDay.length;
  // 窗口不足时早退：原实现用 Array.from({length:N}) 生成下标，当 N < recentN + prevN 时
  // 会取到负下标 → agg 里 themesByDay[-1] 为 undefined → Object.entries 抛
  // 「Cannot convert undefined or null to object」。调用方（enrich）在存档不足 10 天时曾直接崩，
  // 这里改为返回三个空数组，把「数据不足」表达成空结果而不是异常。
  if (N < recentN + prevN) return { fresh: [], continuing: [], fading: [] };
  const recentIdx = Array.from({ length: recentN }, (_, i) => N - recentN + i);
  const prevIdx = Array.from({ length: prevN }, (_, i) => N - recentN - prevN + i);
  const agg = (idxs) => {
    const m = {};
    for (const i of idxs) {
      for (const [th, codes] of Object.entries(themesByDay[i])) {
        m[th] = m[th] || new Set();
        for (const c of codes) m[th].add(c);
      }
    }
    return m;
  };
  const rec = agg(recentIdx);
  const pre = agg(prevIdx);
  const present = (m) => Object.fromEntries(Object.entries(m).filter(([, s]) => s.size >= minStocks));
  const r = present(rec), p = present(pre);
  const fresh = Object.keys(r).filter((t) => !(t in p));
  const fading = Object.keys(p).filter((t) => !(t in r));
  const continuing = Object.keys(r).filter((t) => t in p);
  return { fresh, continuing, fading };
}

// 题材逐日趋势（用于展示某题材每日覆盖个股数）
export function themeTrend(themesByDay, theme, lastK) {
  const slice = themesByDay.slice(-lastK);
  return slice.map((m, i) => ({ day: i, count: m[theme] ? m[theme].size : 0 }));
}
