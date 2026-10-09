#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成跨语言一致性夹具 test/fixtures/parity_v52.json。

用 Python 版（tools/backtest/sentiment_backtest.py，已多轮验证）计算 positions / turnover_cost /
_metrics 以及多标的等权合成的期望值，供 src/backtest.js 的 Node 单测逐位比对，
防止 JS 移植出现语义漂移。改动任一端的回测语义后必须重跑本脚本并提交新夹具：

    <gui312 venv python> make_parity_fixture.py
"""
import json
import os
import sys
from dataclasses import asdict

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sentiment_backtest as sb  # noqa: E402

FIXTURE = os.path.normpath(os.path.join(HERE, "..", "..", "test", "fixtures", "parity_v52.json"))
ASSETS = (("A", 1), ("B", 2), ("C", 3))

N = 40
SCORES = np.array([
    58, 70, 82, 66, 45, 30, 22, 12, 50, 67,
    72, 88, 90, 61, 47, 33, 20, 26, 55, 63,
    71, 79, 84, 69, 52, 41, 28, 18, 35, 60,
    68, 75, 81, 64, 48, 36, 25, 15, 44, 57,
], dtype=float)
RETS = np.round(np.random.default_rng(20260930).normal(0.001, 0.012, N), 6)
RETS[6] = -0.09      # 触发 -8% 止损
RETS[25] = -0.075    # 接近止损线但未触发
assert len(SCORES) == N

# 四个参数组合：基准 / 仅成本 / 全增强 / 更紧的仓位上限与降仓阈值
# 【V5.3】v53：右侧二次确认（confirm_days=1）+ regime 逐日仓位帽子（max_pos_by_day）——
# 锁定新语义的跨语言一致性（默认关闭时与旧夹具组逐位一致，故旧组保留不动）。
MAX_POS_BY_DAY = np.concatenate([
    np.full(10, 1.0),        # 主升段（climax 帽子 1.0）
    np.full(8, 0.5),         # 中性段（neutral 0.5）
    np.full(6, 0.3),         # 切换期段（shift 0.3 强制降仓）
    np.full(9, 0.2),         # 冰点/退潮段（0.2）
    np.full(7, 1.0),         # 回暖段
]).astype(float)
assert len(MAX_POS_BY_DAY) == N
PARAM_SETS = {
    "base": {},
    "cost_only": dict(comm=0.0003, stamp=0.0005, slip=0.0002),
    "full": dict(comm=0.0003, stamp=0.0005, slip=0.0002, max_pos_chg=0.2,
                 stop_loss=-0.08, dd_trigger=-0.15, max_pos=1.0),
    "tight": dict(comm=0.0003, stamp=0.0005, slip=0.0002, max_pos_chg=0.35,
                  stop_loss=-0.05, dd_trigger=-0.08, max_pos=0.6),
    "v53": dict(comm=0.0003, stamp=0.0005, slip=0.0002, max_pos_chg=0.2,
                stop_loss=-0.08, dd_trigger=-0.15, max_pos=1.0,
                confirm_days=1, max_pos_by_day=MAX_POS_BY_DAY.tolist()),
}
TH = dict(hi=sb.BASE_HI, lo=sb.BASE_LO, panic=sb.PANIC, overheat=sb.OVERHEAT)

ASSET_RETS = {}
for name, seed in ASSETS:
    rr = np.round(np.random.default_rng(seed).normal(0.0008, 0.012, N), 6)
    if name == "B":
        rr[10] = -0.085            # 单标的独立触发止损
    ASSET_RETS[name] = rr


def leg(rr, scores, **kw):
    """单个标的：仓位 → 成本 → 策略收益（与 JS runBacktest 单腿同义）"""
    pos_kw = {k: kw[k] for k in ("max_pos", "stop_loss", "dd_trigger", "max_pos_chg",
                                  "confirm_days", "max_pos_by_day", "take_profit") if k in kw}
    p = sb.positions(pd.Series(scores), ret=pd.Series(rr), **TH, **pos_kw)
    cost = sb.turnover_cost(p, kw.get("comm", 0.0), kw.get("stamp", 0.0), kw.get("slip", 0.0))
    return p, cost, pd.Series(rr) * p.values - cost


single, pool = {}, {}
for key, kw in PARAM_SETS.items():
    p, cost, strat = leg(RETS, SCORES, **kw)
    opens = int(((p > 0) & (p.shift(1) == 0)).sum())
    single[key] = {
        "params": {**TH, **kw},
        "positions": [round(float(x), 10) for x in p.tolist()],
        "cost": [round(float(x), 12) for x in cost.tolist()],
        "strat": [round(float(x), 12) for x in strat.tolist()],
        "metrics": asdict(sb._metrics(strat, p, opens)),
    }
    legs = [leg(ASSET_RETS[a], SCORES, **kw) for a, _ in ASSETS]
    strat_pool = np.mean([x[2].values for x in legs], axis=0)
    pos_pool = np.mean([x[0].values for x in legs], axis=0)
    opens_pool = sum(int(((x[0] > 0) & (x[0].shift(1) == 0)).sum()) for x in legs)
    pool[key] = {
        "params": {**TH, **kw},
        "strat": [round(float(x), 12) for x in strat_pool.tolist()],
        "pos": [round(float(x), 10) for x in pos_pool.tolist()],
        "metrics": asdict(sb._metrics(pd.Series(strat_pool), pd.Series(pos_pool), opens_pool)),
    }

out = {
    "meta": {
        "generatedBy": "tools/backtest/make_parity_fixture.py",
        "pythonTool": "tools/backtest/sentiment_backtest.py",
        "note": "JS 移植期望值：positions / turnover_cost / _metrics / 多标的等权合成",
        "n": N,
    },
    "scores": [float(x) for x in SCORES],
    "rets": [float(x) for x in RETS],
    "assets": {a: [float(x) for x in ASSET_RETS[a]] for a, _ in ASSETS},
    "single": single,
    "pool": pool,
}

# ── 【V5.3】止盈跨语言锁定（tp 段）：确定性触发路径，不用随机序列 ──────────
# 随机 40 日序列累计涨幅到不了 8%（σ=1.2%），止盈根本不触发就成了瞎夹具；
# 这里构造明确路径：partial 走"+8% 减半 → +15% 清仓 → 信号仍在重开"，
# trail 走"浮盈激活 → 回撤 4%/23% 不触发（防误杀） → 回撤 38.6% 触发离场"。
TP_N = 20
TP_SCORES = np.full(TP_N, 70.0)  # 持续强信号：隔离止盈语义（信号路径不添乱）
TP_PARTIAL_RETS = np.concatenate([np.full(16, 0.01), np.full(4, 0.005)])
# 1.03^4≈1.1255（≥activate 1.05 激活）；-4% → 回撤 4%；-20%×2 → 回撤 38.6% ≥ 30% 触发
TP_TRAIL_RETS = np.concatenate([np.full(4, 0.03), [-0.04], np.full(2, -0.20), np.full(13, 0.01)])
assert len(TP_PARTIAL_RETS) == TP_N and len(TP_TRAIL_RETS) == TP_N

TP_CASES = {
    "partial": dict(
        scores=TP_SCORES, rets=TP_PARTIAL_RETS,
        kw=dict(take_profit=dict(mode="partial", ladder=[[1.08, 0.5], [1.15, 0.0]]))),
    "trail": dict(
        scores=TP_SCORES, rets=TP_TRAIL_RETS,
        kw=dict(take_profit=dict(mode="trailing", trail=0.3, activate=1.05))),
}

out["tp"] = {}
for name, c in TP_CASES.items():
    p, cost, strat = leg(c["rets"], c["scores"], **c["kw"])
    opens = int(((p > 0) & (p.shift(1) == 0)).sum())
    out["tp"][name] = {
        "params": {**TH, **c["kw"]},
        "scores": [float(x) for x in c["scores"]],
        "rets": [float(x) for x in c["rets"]],
        "positions": [round(float(x), 10) for x in p.tolist()],
        "cost": [round(float(x), 12) for x in cost.tolist()],
        "strat": [round(float(x), 12) for x in strat.tolist()],
        "metrics": asdict(sb._metrics(strat, p, opens)),
    }


os.makedirs(os.path.dirname(FIXTURE), exist_ok=True)
with open(FIXTURE, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print(f"夹具已写出 {FIXTURE}")
for k, v in single.items():
    m = v["metrics"]
    print(f"  single.{k}: 总收益={m['total_ret']} 夏普={m['sharpe']} 回撤={m['max_dd']} 开仓={m['trades']}")
for k, v in pool.items():
    m = v["metrics"]
    print(f"  pool.{k}:   总收益={m['total_ret']} 夏普={m['sharpe']} 回撤={m['max_dd']} 开仓={m['trades']}")
for k, v in out["tp"].items():
    m = v["metrics"]
    pos = v["positions"]
    print(f"  tp.{k}:     开仓={m['trades']} 仓位路径(去重)={[x for i, x in enumerate(pos) if i == 0 or x != pos[i-1]]}")
