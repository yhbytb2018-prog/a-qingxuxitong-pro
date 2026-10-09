// 引擎：题材去噪 + 动量增强（从 src/pipeline.js 拆出，2026-10-05 批次3 4.1）。
//
// 拆分纪律：函数体**逐字搬移**、零语义改动——golden 摘要与 test/integration_pipeline.test.mjs
// 用生产同一条管道锁死口径，搬移本身不得引入任何行为差异。
// src/pipeline.js 对本模块 re-export，既有调用方 import 路径零改动；
// 新代码请直接 import './engine/enrich.js'。
import config from '../config.js';
import { ThemeDenoiser, computeMomentum } from '../themes.js';
import { dailyRowsOf } from '../lhb.js';

// 用题材去噪 + 动量 增强每一日（离线可重跑：历史重算脚本复用同一实现，避免口径二次实现）
export function enrich(allDays) {
  const dn = new ThemeDenoiser({ minGlobalStocks: config.minThemeStocksGlobal }).fit(allDays);
  const byDay = dn.themesAllDays(allDays);
  const mom = computeMomentum(byDay, config.momentumRecent, config.momentumPrev, config.minThemeStocksWindow);
  // 昨日新晋名单：把「上一交易日按同一 momentum 口径算出的 fresh」也落盘。
  // 为什么必须由引擎算并留痕：报告要回答「昨日新晋题材今日还活着吗」，这需要**昨日视角**的
  // fresh 名单（用截止昨日的数据重算 momentum）。如果报告端拿「今日 fresh」去比「昨日 themes」，
  // 语义会变成「今日新晋在昨日是否已存在」——而新晋的定义本就是昨日不存在，逻辑自相矛盾，
  // 得数恒为一个不小的小数（2026-09-30 实测算出 53%，真实存活率是另一回事）。
  // 引擎侧用同一份 byDay/同一套参数重算昨日视角，是唯一不会口径漂移的做法。
  const prevMom = byDay.length > 1
    ? computeMomentum(byDay.slice(0, -1), config.momentumRecent, config.momentumPrev, config.minThemeStocksWindow)
    : { fresh: [], continuing: [], fading: [] };
  // momentum 三态统一为 {theme, stocks}（stocks = 今日覆盖个股数；退潮题材今日已消失 → 0，如实）。
  // 旧档 continuing/fading 是裸字符串数组，golden 测试只锁 .length —— 元素升级为对象不破坏守卫。
  const elOf = (t) => ({ theme: t, stocks: (byDay[byDay.length - 1][t] || new Set()).size });
  const momObj = {
    fresh: mom.fresh.map((t) => ({ theme: t, stocks: [...(byDay[byDay.length - 1][t] || [])].length || countInWindow(byDay, t, config.momentumRecent) })),
    continuing: mom.continuing.map(elOf),
    fading: mom.fading.map(elOf),
    // 昨日视角的新晋/延续/退潮（用于「昨日新晋今日存活」的分子分母同源比对）
    prev_fresh: prevMom.fresh,
    prev_continuing: prevMom.continuing,
    prev_fading: prevMom.fading,
  };
  const out = allDays.map((d, i) => {
    const o = { ...d, themes: Object.fromEntries(Object.entries(byDay[i]).map(([k, v]) => [k, v.size])) };
    // 合并方案阶段1（2026-10-02）：themeList = 去噪题材数组（tag/count/codes/强度组件）。
    // 算法移植自原系统 template.html topicStrength（宽度30+高度30+资金20+持续20），
    // 供 UI 题材强度榜/热度榜/成分股下钻直读——前端不再自行拆 reason 词频（丢弃旧口径）。
    // 资金维度取「当日榜」权威口径（dailyRowsOf），与 summary.lhb_daily_net 同源。
    o.themeList = themeListOf(byDay, i, d);
    // ⑨ 主线题材龙虎资金占比：主线题材（当日成分股最多）个股龙虎净买 ÷ 全榜单龙虎净买
    // 分子分母都必须取「当日榜」口径（口径守卫会核对本字段与 summary.lhb_daily_net 同源）；
    // 早先误用含区间累计榜的全量数组，同一只票会出现 3 天累计额当日度额，占比随披露节奏跳动。
    if (o.summary) {
      const rows = dailyRowsOf(o);
      const entries = Object.entries(byDay[i]);
      if (rows.length && entries.length) {
        const [name, codes] = entries.sort((a, b) => b[1].size - a[1].size)[0];
        let main = 0, tot = 0;
        for (const l of rows) { tot += l.net_buy_wan || 0; if (codes.has(l.code)) main += l.net_buy_wan || 0; }
        o.summary.main_theme = {
          name,
          main_yi: Math.round(main / 1e4 * 100) / 100,
          tot_yi: Math.round(tot / 1e4 * 100) / 100,
          pct: tot !== 0 ? Math.round(main / tot * 1000) / 10 : null,
          caliber: 'daily',
        };
      }
    }
    return o;
  });
  return { out, momObj, byDay };
}

// 题材强度榜（合并方案阶段1）：宽度30 + 高度(均涨幅)30 + 榜上资金20 + 持续性20。
// 忠实移植原系统 template.html topicStrength——差异仅两处，均为口径修正：
//   ① 资金维度：旧用 lhb_aggr||lhb（含区间累计榜），改用 dailyRowsOf 当日榜（权威口径）；
//   ② streak 范围：旧按页面裁剪后的 DAYS 回溯，这里按全档 byDay 回溯（口径更完整）。
// 输出元素 {tag, count, codes, avg_zf, avg_hs, net, streak, score}，按 score 降序全量返回（UI 自行取 TOP）。
function themeListOf(byDay, dayIdx, day) {
  const entries = Object.entries(byDay[dayIdx] || {});
  if (!entries.length) return [];
  const hotBy = new Map((day.hot || []).map((h) => [h.code, h]));
  const lhbMap = new Map();
  for (const l of dailyRowsOf(day)) lhbMap.set(l.code, l.net_buy_wan || 0);
  const out = entries.map(([tag, codes]) => {
    const o = { tag, count: 0, zf: 0, hs: 0, net: 0 };
    const arr = [...codes];
    for (const c of arr) {
      const h = hotBy.get(c);
      if (!h) continue; // 成分股当日不在强势股池 → 不计宽度/高度（与旧口径一致）
      o.count++; o.zf += h.change_pct || 0; o.hs += h.huanshou || 0;
      if (lhbMap.has(c)) o.net += lhbMap.get(c);
    }
    if (!o.count) return null;
    o.codes = arr;
    o.avg_zf = +(o.zf / o.count).toFixed(2);
    o.avg_hs = +(o.hs / o.count).toFixed(2);
    o.net = Math.round(o.net);
    let streak = 0; // 连续在榜天数（含当日），按去噪 themes 回溯
    for (let i = dayIdx; i >= 0; i--) {
      if ((byDay[i] || {})[tag]) streak++; else break;
    }
    o.streak = streak;
    return o;
  }).filter(Boolean);
  if (!out.length) return out;
  const maxC = Math.max(...out.map((o) => o.count), 1);
  const maxZ = Math.max(...out.map((o) => o.avg_zf), 0.01);
  const maxN = Math.max(...out.map((o) => o.net), 1);
  const maxS = Math.max(...out.map((o) => o.streak), 1);
  for (const o of out) {
    o.score = Math.round(o.count / maxC * 30 + Math.max(o.avg_zf, 0) / maxZ * 30 + Math.max(o.net, 0) / maxN * 20 + o.streak / maxS * 20);
  }
  return out.sort((a, b) => b.score - a.score);
}

function countInWindow(byDay, theme, n) {
  const slice = byDay.slice(-n);
  const s = new Set();
  for (const m of slice) if (m[theme]) for (const c of m[theme]) s.add(c);
  return s.size;
}
