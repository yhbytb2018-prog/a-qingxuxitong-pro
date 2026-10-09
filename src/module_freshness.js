// ② 离线模块新鲜度守卫（纯函数；口径守卫惯例：amountCaliberGuard / audit_lhb_caliber.mjs 同族）。
//
// 背景（2026-10-08 第三批）：宽度扫描（data/breadth-latest.json）/ 主线回测（data/backtest.json）/
// 双轨账本（data/paper/dual_track_latest.json）三个离线模块只在 CI 的 build job 里产出，
// 本地 pipeline 与 15:30 定时任务都不含它们；而 build needs: smoke——smoke 硬失败时
// 三个模块集体停摆且零告警，旧口径值静默顶替当日值进叙事/判据（下游背离判定、
// 日报叙事毫不知情）。本模块把「旧值 ≠ 当日值」的判定收敛为唯一出处：
//
//   · 消费端守卫 guardModuleFreshness：模块日期 < 档案锚日 → 判脏 → 消费端置
//     missing 走中性（与 s_amt 缺失 → 中性 50 同一套既定安全路径），旧值不进当日叙事；
//   · CI 门禁 assessModulesFreshness：复用 assessFreshness 的相位语义
//     （fresh / pending / behind）——18:30 首抓窗口的「还没到点」是 pending 不误伤，
//     过预期更新时刻（19:30）仍落后才判 behind（真滞后，--require-fresh exit 1）。
//
// 判据（用户拍板）：纯字符串比较（YYYY-MM-DD 字典序 = 时序），不引入交易日序列——
//   · 假期天然豁免：长假期间档案日与模块日**同停**（两边都是节前最后交易日，相等 → 通过），
//     不会误杀；判据锚定「档案日」而非「今天」，这一点由单测锁死；
//   · 字段缺失 = 判脏（宁缺勿旧：缺日期的档无法自证新鲜，按脏处理走中性）。
import { assessFreshness } from './freshness.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 严格 YYYY-MM-DD 字符串判定（脏值/数字/null 一律不认）。 */
export const isDateStr = (v) => typeof v === 'string' && DATE_RE.test(v);

/**
 * 提取离线模块的交易日字段。三模块形态各异，此处收敛唯一识别口：
 *   · 宽度 breadth-latest.json  → meta.tradeDate（顶层 date 为冗余备份）
 *   · 主线 backtest.json        → meta.tradeDate
 *   · 账本 dual_track_latest.json → day.date
 * 找不到合法日期字符串 → null（调用方按判脏处理）。
 */
export function moduleTradeDate(m) {
  if (m == null || typeof m !== 'object') return null;
  const cands = [m?.meta?.tradeDate, m?.date, m?.day?.date];
  return cands.find(isDateStr) ?? null;
}

/**
 * 消费端守卫（核心判据唯一出处）。
 * @param {string|null} moduleDate  模块档日期（moduleTradeDate 提取）
 * @param {string|null} archiveDate 档案锚日（archive.all_days 末日 / signals.meta.tradeDate）
 * @returns {{ok:boolean, reason:null|string, moduleDate:string|null, archiveDate:string|null}}
 *   ok=false 时 reason ∈ {'stale'（严格落后≥1日）, 'module-date-missing', 'anchor-missing'}
 */
export function guardModuleFreshness(moduleDate, archiveDate) {
  if (!isDateStr(archiveDate)) {
    return { ok: false, reason: 'anchor-missing', moduleDate: isDateStr(moduleDate) ? moduleDate : null, archiveDate: null };
  }
  if (!isDateStr(moduleDate)) {
    return { ok: false, reason: 'module-date-missing', moduleDate: null, archiveDate };
  }
  if (moduleDate < archiveDate) {
    return { ok: false, reason: 'stale', moduleDate, archiveDate };
  }
  return { ok: true, reason: null, moduleDate, archiveDate };
}

/** 对象级组合：读档对象 + 档案锚 → 守卫结论（省一次手工 pick）。 */
export function guardModule(m, archiveDate) {
  return guardModuleFreshness(moduleTradeDate(m), archiveDate);
}

/**
 * CI 门禁探测表（scripts/freshness.mjs --require-fresh 用）。
 * file 相对于存档所在目录解析（--archive 测试目录同构）。
 */
export const MODULE_PROBES = [
  { key: 'breadth', label: '宽度扫描', file: 'breadth-latest.json', field: 'meta.tradeDate' },
  { key: 'mainline', label: '主线回测', file: 'backtest.json', field: 'meta.tradeDate' },
  { key: 'dual_track', label: '双轨账本', file: 'paper/dual_track_latest.json', field: 'day.date' },
];

/**
 * CI 门禁判定（纯函数，读档由调用方负责）。
 * @param {Array<{key:string,label:string,date:string|null}>} modules
 * @param {{now?:Date, holidays?:Array, assess?:Function}} o
 * @returns {Array<{key,label,date,state,behindSessions,publishDeadline}>}
 *   state：fresh / pending / behind（同主档 assessFreshness 语义）；日期缺失 → unknown。
 */
export function assessModulesFreshness(modules, { now = new Date(), holidays = [], assess = assessFreshness } = {}) {
  return (Array.isArray(modules) ? modules : []).map((m) => {
    if (!m || !isDateStr(m.date)) {
      return { key: m?.key, label: m?.label, date: null, state: 'unknown', behindSessions: null, publishDeadline: null };
    }
    const f = assess({ tradeDate: m.date }, now, holidays);
    return {
      key: m.key, label: m.label, date: m.date,
      state: f.state, behindSessions: f.behindSessions ?? null, publishDeadline: f.publishDeadline ?? null,
    };
  });
}

/** 门禁红名单：真滞后（behind）或日期缺失（unknown，档不存在/字段缺失）。 */
export const modulesBehind = (assessed) =>
  (Array.isArray(assessed) ? assessed : []).filter((x) => x && (x.state === 'behind' || x.state === 'unknown'));
