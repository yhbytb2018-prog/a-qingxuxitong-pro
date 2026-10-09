// ─────────────────────────────────────────────────────────────────────────────
// 共享模块（旁路实验用）：引擎克隆 positions() + halfBoostByDay 钩子
// ─────────────────────────────────────────────────────────────────────────────
// src/backtest.js 的 positions() 逐位拷贝，唯一差异：半仓分支的基座 0.5 在触发日被
// halfBoostByDay[i] 替代（null/缺失 → 0.5，与引擎逐位一致）。
// 使用纪律：每个引用方必须自带双门禁——
//   ① halfBoostByDay=null 时克隆与引擎 positions() 逐位相等（全资产全序列）；
//   ② E0/V53A 池级结果与 data/backtest.json 对账（容差对齐取整精度）。
// 引用方：tools/backtest/experiment_momentum_boost.mjs（动量加速实验）
//         tools/backtest/experiment_boost_stress.mjs（加速体检/压力测试）
import { DEFAULT_TH } from '../../src/backtest.js';

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

export function positionsBoost(scores, rets, p = { }) {
  const {
    hi = DEFAULT_TH.hi, lo = DEFAULT_TH.lo,
    panic = DEFAULT_TH.panic, overheat = DEFAULT_TH.overheat,
    maxPos = 1.0, stopLoss = 0, ddTrigger = 0, maxPosChg = 0,
    confirmDays = 0, maxPosByDay = null, takeProfit = null,
    halfBoostByDay = null,
  } = p;
  const tpLadder = takeProfit && takeProfit.mode === 'partial' && Array.isArray(takeProfit.ladder)
    ? takeProfit.ladder : null;
  const tpTrail = takeProfit && takeProfit.mode === 'trailing'
    ? { trail: takeProfit.trail ?? 0.3, activate: takeProfit.activate ?? 1.05 } : null;
  const tpOn = !!(tpLadder || tpTrail);
  const n = scores.length;
  const raw = new Array(n).fill(0);
  let held = false;
  let eq = 1, peak = 1, prevTarget = 0;
  let pending = 0;
  let legCum = 1;
  let legPeak = 1;
  let tpTier = 0;
  for (let i = 0; i < n; i++) {
    const v = scores[i];
    if (rets) {
      eq *= 1 + prevTarget * rets[i];
      peak = Math.max(peak, eq);
    }
    if (tpOn && prevTarget === 0) { legCum = 1; legPeak = 1; tpTier = 0; }
    if (tpOn && rets && prevTarget > 0) {
      legCum *= 1 + rets[i];
      legPeak = Math.max(legPeak, legCum);
    }
    let cap = maxPos;
    if (ddTrigger < 0 && rets) {
      const curDd = 1 - eq / peak;
      if (curDd >= -ddTrigger) cap = 0.4 * maxPos;
      else if (curDd >= 0.6 * -ddTrigger) cap = 0.7 * maxPos;
    }
    if (maxPosByDay != null && i < maxPosByDay.length
        && maxPosByDay[i] != null && Number.isFinite(+maxPosByDay[i])) {
      cap = Math.min(cap, Math.max(0, +maxPosByDay[i]));
    }
    if (tpLadder && held) {
      while (tpTier < tpLadder.length && legCum >= tpLadder[tpTier][0]) tpTier++;
    }
    if (tpLadder && tpTier > 0) cap = Math.min(cap, tpLadder[tpTier - 1][1] * maxPos);
    let trailHit = false;
    if (tpTrail && held && legPeak >= tpTrail.activate) {
      if (1 - legCum / legPeak >= tpTrail.trail) trailHit = true;
    }
    const stopHit = stopLoss < 0 && held && rets && rets[i] <= stopLoss;
    if (v > panic && !held) pending++;
    else pending = 0;
    let target;
    if (stopHit || trailHit) target = 0;
    else if (v >= overheat) target = held ? cap : 0;
    else if (v >= lo) target = cap;
    // ▼▼ 唯一改动：半仓基座 0.5 → 触发日的 halfBoostByDay[i]（null=0.5 原语义）▼▼
    else if (v > panic) {
      const hb = halfBoostByDay != null && i < halfBoostByDay.length
        && halfBoostByDay[i] != null && Number.isFinite(+halfBoostByDay[i]);
      const base = hb ? Math.min(Math.max(0, +halfBoostByDay[i]), maxPos) : 0.5;
      target = (held || pending > confirmDays) ? base * cap : 0;
    }
    // ▲▲ 唯一改动结束 ▲▲
    else target = 0;
    if (maxPosChg > 0 && !stopHit && !trailHit) {
      target = clamp(target, prevTarget - maxPosChg, prevTarget + maxPosChg);
    }
    held = target > 0;
    raw[i] = target;
    prevTarget = target;
  }
  return raw.map((_, i) => (i === 0 ? 0 : raw[i - 1])); // T+1 生效
}
