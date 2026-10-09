// ③ 策略回测核心（纯函数，与 scripts/backtest_strategies.mjs 共用；单测锁时点纪律）。
//
// 逐笔交易模型：
//   · entryOf(i)/exitOf(i) 只接收**信号日下标 i**——构造上保证它们无法触碰 T+1 及以后的
//     数据（调用方传入的闭包也只被允许读 days[i] 的当日收盘字段）；
//   · 成交一律 T+1 开盘价（kline[kIdx[i]+1].open）；到期出场为第 N 日收盘价；
//     提前离场为信号次日开盘价；
//   · 持有期重叠的后续信号忽略（不加仓不滚动）；
//   · 成本与 V5.2 同口径（config.backtest.costs）。
import config from './config.js';

export const COSTS = config.backtest.costs;
export const ROUND_COST = COSTS.comm * 2 + COSTS.stamp + COSTS.slip * 2;

const r4 = (v) => (v != null ? Math.round(v * 1e4) / 1e4 : null);

/** 净值序列 + 逐笔收益 → 年化/最大回撤/夏普/胜率/盈亏比。 */
export function metrics(nav, tradeRets) {
  const n = nav.length;
  if (n < 2) return { total: null, annual: null, maxDd: null, sharpe: null, winRate: null, plRatio: null };
  let peak = nav[0], maxDd = 0;
  for (const v of nav) { peak = Math.max(peak, v); if (peak > 0) maxDd = Math.max(maxDd, (peak - v) / peak); }
  const total = nav[n - 1] - 1;
  const annual = Math.pow(nav[n - 1], 252 / Math.max(n - 1, 1)) - 1;
  const rets = [];
  for (let i = 1; i < n; i++) rets.push(nav[i] / nav[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(rets.length - 1, 1));
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : null;
  const wins = tradeRets.filter((r) => r > 0), losses = tradeRets.filter((r) => r <= 0);
  const winRate = tradeRets.length ? wins.length / tradeRets.length : null;
  let plRatio = null;
  if (wins.length && losses.length) {
    const aw = wins.reduce((a, b) => a + b, 0) / wins.length;
    const al = Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length);
    if (al > 0) plRatio = aw / al;
  }
  return {
    total: r4(total), annual: r4(annual), maxDd: r4(maxDd),
    sharpe: sharpe != null ? Math.round(sharpe * 100) / 100 : null,
    winRate: r4(winRate), plRatio: r4(plRatio),
  };
}

/**
 * 逐笔交易构建。
 * @param days      信号日序列（升序；entryOf/exitOf 只按下标读当日收盘字段）
 * @param kIdx      days[i] → 主K线下标（null=无锚点跳过）；附加属性 _klineLen=主K线长度
 * @param entryOf   (i)=>bool —— T 日入场判定（只许读 days[i]）
 * @param exitOf    (j)=>bool|null —— T' 日提前离场判定（只许读 days[j]；null=无提前离场）
 * @param holdN     持有 N 日（entryK 起第 N 个 K 线日收盘出场）
 * @param membersOf (i)=>string[]|null —— 组合策略的成员标的（null=单标的用主K线）
 * @returns trades  [{signalDay, entryK, exitK, exitAtOpen, members}]
 */
export function buildTrades(days, kIdx, entryOf, exitOf, holdN, membersOf) {
  const LEN = kIdx._klineLen;
  const trades = [];
  let lastExitK = -1;
  for (let i = 0; i < days.length; i++) {
    const k = kIdx[i];
    if (k == null) continue;
    const entryK = k + 1;                       // T+1 开盘成交
    if (entryK + holdN - 1 >= LEN) continue;    // 持有期未走完（最新信号），不计入
    if (!entryOf(i)) continue;
    if (entryK <= lastExitK) continue;          // 持仓中，重叠信号忽略
    let exitK = entryK + holdN - 1;
    let exitAtOpen = false;
    if (exitOf) {
      for (let j = i + 1; j < days.length; j++) {
        const kj = kIdx[j];
        if (kj == null) continue;
        if (kj + 1 > exitK) break;              // 判定点超出持有期即停
        if (kj + 1 <= entryK) continue;
        if (exitOf(j)) { exitK = kj + 1; exitAtOpen = true; break; }
      }
    }
    trades.push({ signalDay: days[i].trade_date, entryK, exitK, exitAtOpen, members: membersOf ? membersOf(i) : null });
    lastExitK = exitK;
  }
  return trades;
}

/** 逐笔净收益（扣成本）。klineOf(null)=主K线；klineOf(sym)=成员K线（缺行情剔除计数）。 */
export function tradeReturns(trades, klineOf) {
  return trades.map((t) => {
    if (!t.members) {
      const main = klineOf(null);
      const e = main[t.entryK] && main[t.entryK].open;
      const x = t.exitAtOpen ? (main[t.exitK] && main[t.exitK].open) : (main[t.exitK] && main[t.exitK].close);
      if (!(e > 0) || !(x > 0)) return { ret: null, members: 0, dropped: 1 };
      return { ret: (x / e) * (1 - ROUND_COST) - 1, members: 1, dropped: 0 };
    }
    const rets = []; let dropped = 0;
    for (const sym of t.members) {
      const kl = klineOf(sym);
      const e = kl && kl[t.entryK] && kl[t.entryK].open;
      const x = t.exitAtOpen ? (kl && kl[t.exitK] && kl[t.exitK].open) : (kl && kl[t.exitK] && kl[t.exitK].close);
      if (!(e > 0) || !(x > 0)) { dropped++; continue; }
      rets.push((x / e) * (1 - ROUND_COST) - 1);
    }
    return rets.length
      ? { ret: rets.reduce((a, b) => a + b, 0) / rets.length, members: rets.length, dropped }
      : { ret: null, members: 0, dropped };
  });
}

/** 净值曲线：主K线区间 [k0,k1] 逐日合成（持仓日组合收益 / 空仓日 0）。 */
export function buildNav(trades, klineOf, k0, k1) {
  const main = klineOf(null);
  const nav = [];
  let cur = 1;
  for (let t = k0; t <= k1; t++) {
    const tr = trades.find((x) => t >= x.entryK && t <= x.exitK);
    if (tr) {
      let dayRet = 0;
      if (!tr.members) {
        const base = t === tr.entryK ? main[t].open : main[t - 1].close;
        if (base > 0) dayRet = main[t].close / base - 1;
      } else {
        const rets = [];
        for (const sym of tr.members) {
          const kl = klineOf(sym);
          if (!kl || !kl[t]) continue;
          const base = t === tr.entryK ? kl[t].open : (kl[t - 1] ? kl[t - 1].close : kl[t].open);
          if (base > 0 && kl[t].close > 0) rets.push(kl[t].close / base - 1);
        }
        if (rets.length) dayRet = rets.reduce((a, b) => a + b, 0) / rets.length;
      }
      cur *= 1 + dayRet;
    }
    nav.push(cur);
  }
  return nav;
}
