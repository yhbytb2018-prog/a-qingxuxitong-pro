#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 Sentiment V5.0 每日因子采集 Excel 模板（tools/backtest/SentimentV5_factor_template.xlsx）
表头第2行为机器可读英文列名，另存为 CSV 后可直接喂 sentiment_backtest.py（--factors）。
用法：python make_template.py"""
import os
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

OUT = os.path.join(os.path.dirname(__file__), "SentimentV5_factor_template.xlsx")
N_ROWS = 600

wb = Workbook()
ws = wb.active
ws.title = "SentimentV5每日因子"

# ── 标题行 ──
ws.merge_cells("A1:K1")
ws["A1"] = "Sentiment V5.0 每日因子采集表（五核心因子 0~100，B~F 手工录入，G~I 自动计算）"
ws["A1"].font = Font(bold=True, size=13)
ws["A1"].alignment = Alignment(horizontal="center")

# ── 第2行：机器可读表头（与回测 CSV 对齐）──
machine = ["date", "f1", "f2", "f3", "f4", "f5", "close", "score", "risk", "signal", "note"]
for c, name in enumerate(machine, 1):
    cell = ws.cell(row=2, column=c, value=name)
    cell.font = Font(bold=True, color="FFFFFF")
    cell.fill = PatternFill("solid", fgColor="4472C4")
    cell.alignment = Alignment(horizontal="center")

# ── 第3行：中文说明 ──
labels = ["日期", "F1情绪定位", "F2盈亏效应", "F3广度量能", "F4题材结构", "F5主线板块结构",
          "回测标的收盘", "综合SCORE", "风险等级", "交易信号", "备注/辅助模块"]
for c, name in enumerate(labels, 1):
    cell = ws.cell(row=3, column=c, value=name)
    cell.font = Font(bold=True)
    cell.fill = PatternFill("solid", fgColor="D9E1F2")
    cell.alignment = Alignment(horizontal="center")

# ── 数据区公式（G~I 自动计算）──
for r in range(4, 4 + N_ROWS):
    ws.cell(row=r, column=8, value=f"=IF(COUNT(B{r}:F{r})=5,B{r}*0.25+C{r}*0.25+D{r}*0.2+E{r}*0.2+F{r}*0.1,\"\")")
    ws.cell(row=r, column=9, value=(
        f'=IF(H{r}="","",IF(H{r}>=80,"极低风险(过热)",IF(H{r}>=65,"低风险",'
        f'IF(H{r}>=45,"中等风险",IF(H{r}>=25,"高风险","极高风险")))))'))
    ws.cell(row=r, column=10, value=(
        f'=IF(H{r}="","",IF(H{r}>=80,"过热禁止新开",IF(H{r}>=65,"开仓",'
        f'IF(H{r}<=24,"清仓",IF(H{r}<=44,"减仓","持有观望")))))'))

# ── B~F 数据有效性 0~100 ──
dv = DataValidation(type="decimal", operator="between", formula1=0, formula2=100,
                    allow_blank=True, showErrorMessage=True,
                    errorTitle="超出范围", error="因子分须在 0~100 之间")
ws.add_data_validation(dv)
dv.add(f"B4:F{3 + N_ROWS}")

# ── 列宽/格式 ──
widths = [12, 11, 11, 11, 11, 13, 13, 11, 13, 13, 30]
for c, w in enumerate(widths, 1):
    ws.column_dimensions[get_column_letter(c)].width = w
ws.freeze_panes = "A4"

# ── 使用说明 sheet ──
info = wb.create_sheet("使用说明")
lines = [
    ["Sentiment V5.0 因子采集模板 · 使用说明"],
    [""],
    ["1. 每日收盘后，把人工/离线模型统计的五大因子分填入 B~F 列（0~100），"],
    ["   G列自动算综合分（权重 情绪0.25/盈亏0.25/广度0.20/题材0.20/主线结构0.10），"],
    ["   H/I 列自动输出风险等级与交易信号（V5五档表口径）。"],
    ["2. J 列填回测标的收盘价（主线指数或等权主线篮子）——回测必需，勿漏。"],
    ["3. K 列填辅助模块定性信息（政策/宏观/地缘等），不参与打分。"],
    ["4. 导出回测数据：文件 → 另存为 → CSV，第2行英文表头与回测脚本列名"],
    ["   (date,f1..f5,close) 完全一致，可直接："],
    ["   python sentiment_backtest.py --factors 导出的.csv"],
    ["5. 鲁棒性测试（噪声扰动/训练验证分段/牛熊失效场景）已内置于"],
    ["   sentiment_backtest.py，无需单独脚本。"],
]
for r, row in enumerate(lines, 1):
    for c, v in enumerate(row, 1):
        info.cell(row=r, column=c, value=v)
info["A1"].font = Font(bold=True, size=12)
info.column_dimensions["A"].width = 80

wb.save(OUT)
print("written:", OUT)
