#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从云端看板存档导出日度因子 CSV，喂给 sentiment_backtest.py 回测
================================================================
背景
----
网页版模型（仓库根 src/）每日收盘后计算**七因子**情绪分并写入 data/archive.json
（all_days[].emotion.factors）。而离线回测工具此前只认 Excel 手工录入的 f1~f5，
真实历史因子分进不了回测。本脚本打通这条链路。

两套因子体系并不等价，请按需选择导出模式：

  【七因子·无损·推荐】网页模型原始因子，直接回测
      python export_from_archive.py --out archive_factors.csv
      python sentiment_backtest.py --factors archive_factors.csv \
          --factor-cols s_net,s_pos,s_brd,s_hot,s_zdt,s_zbl,s_amt \
          --weights 0.2,0.1,0.2,0.1,0.15,0.1,0.15 --fast --xlsx

  【f1~f5·有损映射·仅供旧管线兼容】--legacy5
      python export_from_archive.py --legacy5 --out archive_f5.csv
      python sentiment_backtest.py --factors archive_f5.csv --fast

      ⚠ 该映射是语义近似、非等价变换，会损失信息（见脚本内 LEGACY5 表及输出提示）。
        除需复用旧报告模板外，建议一律用七因子模式。

口径说明
--------
* archive 的 indexes 只有**当日涨跌幅(%)**、没有收盘价。回测只需要收益序列，
  故本脚本用涨跌幅还原净值（基准 100）作为 close 列，并额外输出精确的 ret 列
  （sentiment_backtest 的 asset_ret 优先取 ret 列，可保全首日收益）。
* 当日因子或指数缺失的记录会被跳过并计入报告，不做插值填充（避免把假数据喂进回测）。
"""
import argparse
import json
import os
import sys

import pandas as pd

FACTOR_COLS = ["s_net", "s_pos", "s_brd", "s_hot", "s_zdt", "s_zbl", "s_amt"]
FACTOR_CN = {"s_net": "龙虎榜净额", "s_pos": "涨跌家数", "s_brd": "板块行业涨比",
             "s_hot": "涨停强度", "s_zdt": "涨跌停对比", "s_zbl": "封板质量", "s_amt": "量能"}

INDEX_MAP = {"上证指数": "ret_sh", "深证成指": "ret_sz", "创业板指": "ret_cyb"}
INDEX_CHOICES = ["等权"] + list(INDEX_MAP.keys())

# 七因子 → V5.0 五因子：语义近似的**有损**映射，仅用于兼容旧管线/旧报告模板。
# f1 情绪定位直接取综合分（它本身已是七因子加权结果 → 与其余 f2~f5 存在共线性）。
LEGACY5 = {
    "f1": ("情绪定位", ["score"], None),
    "f2": ("盈亏效应", ["s_net"], None),
    "f3": ("广度量能", ["s_pos", "s_amt"], "mean"),   # 广度 + 量能
    "f4": ("题材结构", ["s_hot", "s_zdt"], "mean"),   # 涨停强度 + 涨跌停对比
    "f5": ("主线板块结构", ["s_brd", "s_zbl"], "mean"),  # 板块涨比 + 封板质量
}


def load_archive(path):
    if not os.path.exists(path):
        raise SystemExit(f"存档不存在: {path}")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def build_frame(arch):
    rows, skipped = [], []
    for day in arch.get("all_days", []):
        date = day.get("trade_date")
        e = day.get("emotion") or {}
        fac = e.get("factors") or {k: e.get(k) for k in FACTOR_COLS}
        idx = day.get("indexes") or {}

        miss = [k for k in FACTOR_COLS if fac.get(k) is None]
        if miss:
            skipped.append((date, "因子缺失 " + ",".join(miss)))
            continue

        row = {"date": date}
        row.update({k: float(fac[k]) for k in FACTOR_COLS})
        row["score"] = float(e.get("value", e.get("score", 0.0)))
        row["emotion_pct_rank"] = e.get("pct_rank")
        # 口径必须带后缀：lhb_daily_net 是喂给 s_net 因子的当日榜净额（权威）；
        # lhb_all_net 含「连续N个交易日」区间累计榜，是区间累计值，仅供对照，禁止当作日度净额使用。
        row["lhb_daily_net"] = e.get("lhb_daily_net")
        row["lhb_all_net"] = (day.get("summary") or {}).get("lhb_all_net")

        got = 0
        for cn, key in INDEX_MAP.items():
            v = idx.get(cn)
            row[key] = (float(v) / 100.0) if v is not None else None
            got += 1 if v is not None else 0
        if got == 0:
            skipped.append((date, "指数涨跌幅全缺"))
            continue
        rows.append(row)

    if not rows:
        raise SystemExit("存档中没有任何可用交易日（emotion/indexes 均缺失）")
    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["date"])
    return df.sort_values("date").reset_index(drop=True), skipped


def add_target_series(df, index):
    """加 ret（组合/标的日收益）与 close（净值，基准 100，供 daily_table/plot 使用）"""
    keys = list(INDEX_MAP.values())
    if index == "等权":
        df["ret"] = df[keys].mean(axis=1, skipna=True)
    else:
        key = INDEX_MAP[index]
        if df[key].isna().all():
            raise SystemExit(f"存档缺少 {index} 的涨跌幅数据")
        df["ret"] = df[key].fillna(0.0)
    df["close"] = (1 + df["ret"].fillna(0.0)).cumprod() * 100.0
    return df


def add_legacy5(df):
    for col, (cn, srcs, agg) in LEGACY5.items():
        sub = df[srcs]
        df[col] = sub.mean(axis=1) if (agg == "mean" and len(srcs) > 1) else sub.iloc[:, 0]
    return df


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="archive.json → 回测因子 CSV")
    ap.add_argument("--archive", default=os.path.join(here, "..", "..", "data", "archive.json"),
                    help="存档路径（默认 ../../data/archive.json）")
    ap.add_argument("--out", default="archive_factors.csv", help="输出 CSV 路径")
    ap.add_argument("--index", default="等权", choices=INDEX_CHOICES,
                    help="回测标的：等权（三指数等权合成，默认）或单个指数")
    ap.add_argument("--legacy5", action="store_true",
                    help="额外输出 f1~f5 有损映射列（兼容旧管线；不推荐）")
    args = ap.parse_args()

    arch = load_archive(args.archive)
    meta = arch.get("meta") or {}
    df, skipped = build_frame(arch)
    df = add_target_series(df, args.index)
    if args.legacy5:
        df = add_legacy5(df)

    out_cols = (["date"] + FACTOR_COLS + ["score", "ret", "close"]
                + list(INDEX_MAP.values()) + ["emotion_pct_rank", "lhb_daily_net", "lhb_all_net"])
    if args.legacy5:
        out_cols += list(LEGACY5.keys())
    df[out_cols].to_csv(args.out, index=False, encoding="utf-8-sig")

    span = f"{df['date'].iloc[0]:%Y-%m-%d} ~ {df['date'].iloc[-1]:%Y-%m-%d}"
    print(f"已导出 {args.out}")
    print(f"  交易日 {len(df)} 天｜区间 {span}｜标的 {args.index}")
    print(f"  存档 meta：tradeDate={meta.get('tradeDate')} stale={meta.get('stale')} "
          f"generatedAt={meta.get('generatedAt')}")
    if meta.get("stale"):
        print("  ⚠ 存档标记 stale=true：该因子分来自回退档，回测结论仅作管线自检。")
    if skipped:
        print(f"  跳过 {len(skipped)} 天（不插值）：")
        for d, why in skipped[:8]:
            print(f"    - {d}: {why}")
        if len(skipped) > 8:
            print(f"    … 其余 {len(skipped) - 8} 天")
    if args.legacy5:
        print("  ⚠ 已附加 f1~f5 有损映射：f1=综合分(与其余共线)/f2=s_net/"
              "f3=mean(s_pos,s_amt)/f4=mean(s_hot,s_zdt)/f5=mean(s_brd,s_zbl)")
    print(f"  样本仅 {len(df)} 个交易日，年化/夏普统计意义有限，不构成投资建议。")


if __name__ == "__main__":
    main()
