// 双轨披露块组装（P2-β 渲染接线 · 2026-10-06 拍板）
//
// 定位：signals-latest.json 的 dualTrack 段**唯一生产出处**。框架见
// docs/dual_track_framework.md §三——V5.2 独跑（轨道 A）+ V5.3 全程陪跑披露
// （轨道 B 参考线）+ shift 次日帽影子记账（轨道 C）。
//
// ⚠ 数字唯一出处纪律：本模块**不重算任何双轨数字**——三轨仓位/分歧/影子/账本
//   全部原样搬运 tools/backtest/paper_dual_track.mjs 产出的
//   data/paper/dual_track_latest.json::day。这里做的是「读盘 + 搬运 + 口径注解」，
//   在这里重算等于造第二套口径（"报告说 A、算的是 B"的 R4 事故源）。
//
// 接线形态：与 health/seats/pain 同款**注入**纪律——本模块导出注入函数，
// 两条写盘路径（src/engine/write.js 与 scripts/split_archive.mjs）用**同一注入**
// 调 buildSignals(archive, { dualTrackFn })，保证两路径产出的 signals-latest.json
// 逐字段一致（否则 split_archive --check 报形态分裂）。
//
// 缺失语义：data/paper/dual_track_latest.json 不存在/损坏 → 返回 null。
// null = "未生成"（旁路工具还没跑），**不是**"轨道一致"——渲染层必须显式区分
// （本项目铁律：没检查 ≠ 没问题）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { guardModuleFreshness } from './module_freshness.js';

// 披露口径注解（沿用 DISCLAIMER 口径，轨道 B/C 是风控参考不是买卖信号）
const DISCLOSURE_NOTE = '轨道 B/C 为风控参考与影子记账，非买卖信号；分歧=当日保费敞口，账本 P2 起累计。'
  + '数字唯一出处 tools/backtest/paper_dual_track.mjs，本段只搬运不重算。';

/**
 * A_fallback 回滚横幅文案（六要素）的唯一出处（E2E 终测 2026-10-05 抓出双模板漂移后收口）。
 * 消费端：rollback_track.mjs::writeMirror（回滚时刻写入）+ paper_dual_track.mjs 镜像自愈
 * （每日重写）——两处各自拼串 = 文案漂移（回滚时六要素、自愈后剩四要素的实录事故）。
 * @param {object} fallback track_state.json::fallback（since/effectiveDate/trigger/why）
 * @param {string} commit 冻结快照 commit（如 bd77fed）
 * @returns {string} activeTrackNote 全文；fallback 缺席时各要素 [未记录]/[待确认] 兜底
 */
export function buildTrackNote(fallback, commit) {
  const fb = (fallback && typeof fallback === 'object') ? fallback : {};
  return `轨道已回滚至 A_fallback（V5.2 冻结快照 @${commit || '[未记录]'}）`
    + ` · 回滚于 ${fb.since || '[未记录]'} · 生效 ${fb.effectiveDate || '[待确认]'}`
    + ` · 触发 ${fb.trigger || '?'} · 原因：${fb.why || '[未记录]'}`
    + ' · 唯一事实源 data/paper/track_state.json（本字段为展示镜像，抓取重写后由 paper_dual_track 每日自愈）';
}

/**
 * summary.total 面 → cum 块的提取（唯一出处，check_contract 一致性守卫复用同一函数——
 * 两处各自实现 = 第二套口径，R4 事故源）。summary 是审计面 optional（门禁失败时账本
 * 仍会写出供尸检），缺席 → 各位 null（未生成语义，绝不补 0）。
 * @param {object} summary dual_track_latest.json::summary（可缺席）
 * @returns {{trackA:number|null, trackB:number|null, trackC:object|null}} 累计收益面
 */
export function cumFromSummary(summary) {
  const s = (summary && typeof summary === 'object') ? summary : {};
  const tot = (o) => (o && Number.isFinite(o.total)) ? o.total : null;
  const tc = (s.trackC && typeof s.trackC === 'object') ? s.trackC : null;
  return {
    trackA: tot(s.trackA),
    trackB: tot(s.trackB),
    trackC: tc ? { '0.3': tot(tc['0.3']), '0.4': tot(tc['0.4']), '0.5': tot(tc['0.5']) } : null,
  };
}

/**
 * 组装 signals-latest 的 dualTrack 披露块（纯搬运，不重算）。
 * @param {object} lt dual_track_latest.json 的解析结果（须含 day 段）
 * @returns {object|null} 披露块；day 缺失/形态不对 → null（未生成语义）
 */
export function dualTrackBlock(lt) {
  if (!lt || typeof lt !== 'object' || !lt.day || typeof lt.day !== 'object') return null;
  const day = lt.day;
  if (!day.date || !day.trackA || !day.trackB) return null; // 半缺是最危险形态，整块降级
  return {
    // asOf = 账本末日。⚠ 它可能与 signals.meta.tradeDate 不同（旁路工具每日跑一次，
    // 盘中抓取时账本停在上一收盘日）——如实披露不隐藏：滞后是实况，伪装成"今日"
    // 才是事故（缺失显式化原则）。
    asOf: day.date,
    generatedAt: lt.generatedAt || null,
    // 三轨披露（框架 §三 + 用户规格"当日净值"）：day **全量镜像**（含 dayReturns——
    //   三轨当日收益 A/B/C0.3/C0.4/C0.5。曾因 32KB 预算剔除，预算重估 36KB 后恢复，
    //   crossCheckDualTrack 随之回归纯 stringify 深比较——守卫更强，白名单更短）。
    day,
    // 累计收益（用户规格 trackA/trackB 累计 + trackC 三线累计）：summary.total 面搬运。
    //   只搬 total——maxDd/sharpe/ledgerEnd 不搬（渲染不用，ledgerEnd 与 day.ledger 纯
    //   重复；体积纪律，提取逻辑唯一出处 cumFromSummary）。
    cum: cumFromSummary(lt.summary),
    // 轨道状态简版（渲染端要知道当前执行面是 A 还是 A_fallback；完整态唯一事实源
    // = data/paper/track_state.json，契约 schemas/track-state.schema.json）
    trackState: {
      activeTrack: (lt.trackState && lt.trackState.activeTrack) || 'A',
      paramsSource: (lt.trackState && lt.trackState.paramsSource) || null,
    },
    note: DISCLOSURE_NOTE,
  };
}

/**
 * 注入函数工厂：两条写盘路径共用（同一注入 = 同一形态）。
 * @param {string} dataDir <root>/data 绝对路径（write.js 的 DATA_DIR / split_archive 的 DATA）
 * @param {string|null} archiveDate 档案锚日（②新鲜度守卫 2026-10-08：账本 day.date 落后于
 *   档案日 → 披露块置 null 走「未生成」——旧值不得顶替当日值进 signals。null = 不设防
 *   （历史调用方兼容），writeShards 一律传 archive.all_days 末日 trade_date）。
 * @returns {Function} () => block|null（签名与 buildSignals 注入约定兼容，忽略入参——
 *   本段数据源是账本文件而非 days，这正是「读盘注入」与「纯函数注入」的唯一差异）
 */
export function dualTrackDisclosureFn(dataDir, archiveDate = null) {
  return () => {
    try {
      const p = join(dataDir, 'paper', 'dual_track_latest.json');
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      if (archiveDate != null) {
        const g = guardModuleFreshness(raw?.day?.date, archiveDate);
        if (!g.ok) {
          console.warn(`[dual-track] 账本档未过新鲜度守卫（${g.reason}：${g.moduleDate ?? '(无日期)'} vs 档案日 ${archiveDate}）→ 披露块置 missing`);
          return null;
        }
      }
      return dualTrackBlock(raw);
    } catch {
      return null; // 文件不存在/JSON 损坏 → 未生成（不伪造、不抛出拖垮整份 signals）
    }
  };
}
