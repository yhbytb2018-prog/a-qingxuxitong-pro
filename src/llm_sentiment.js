// LLM 舆情因子（V5.3 P2 试点）：±5 参考修正——**原分不动，仅报告参考**。
//
// 职责边界（与 Python 工具 --alerts「每项扣 12 分、原分不动仅报告参考」同语义）：
//   · 本模块输出的是"参考修正分"（original + adj → modified），**绝不写回**
//     emotion.value——回测信号、regime 判定、历史 golden 夹具全部零漂移。
//     若未来要升级为正式调整项，唯一通道是 promote_params 门禁 + 样本外验证
//     （先把参考分跑起来积累数据，再谈转正——P2 试点定位）。
//   · 权重约束（需求原文）：±5% 上限、不独立生成买卖信号、必须与原有量价/
//     基本面因子**同时满足**才生效。落地为三条硬规则：
//       ① |adj| ≤ 5（LLM 原始 sentiment ∈ [-1,1] × 5 后截断）；
//       ② 原分须"有方向"（≥lo=65 偏多持有档，或 <hi=44 偏空减仓档）——
//          44~65 观望区原因子无方向，舆情单方面不生效（防"舆情独立开信号"）；
//       ③ adj 符号必须与原分方向一致（同向增强才生效；反向 = 原因子与舆情
//          矛盾，按"信号矛盾保守处理"纪律保持原分，仅在文案中提示分歧）。
//   · 缺失显式化（项目铁律）：无缓存/结构坏/证据日期与目标日不符 → null，
//     前端显示"未生成"，绝不把"没跑 LLM"渲染成"舆情中性"。
//
// 数据流（照 pain/breadth/crosscheck 先例三段式）：
//   scripts/fetch_llm_sentiment.mjs（收盘后跑，调 LLM 落盘 data/llm-sentiment-latest.json）
//   → src/engine/write.js 注入 llmFn（只读缓存 + 本模块转换）
//   → buildSignals 透传 → 研判简报「八、舆情参考」节。
// 本模块纯函数、零依赖、不读盘（读盘在注入方），可单测。

import { DEFAULT_TH } from './backtest.js';

export const LLM_ADJ_LIMIT = 5; // 参考修正上限（±5 分，需求硬约束）

// 生效方向门槛复用交易档位语义（唯一出处 src/backtest.js::DEFAULT_TH）：
// ≥lo=65 = 持有档（偏多），<hi=44 = 减仓/清仓档（偏空）。
// 不自造新阈值——舆情生效门槛与交易档位共享同一套分界，可解释性最强。
const directionOf = (score) => {
  if (!Number.isFinite(+score)) return null;
  if (+score >= DEFAULT_TH.lo) return 'bullish';
  if (+score < DEFAULT_TH.hi) return 'bearish';
  return null; // 44~65 观望区：原因子无方向
};

const clampAdj = (x) => Math.max(-LLM_ADJ_LIMIT, Math.min(LLM_ADJ_LIMIT, x));

/**
 * 把 fetch_llm_sentiment.mjs 落盘的报告转成研判参考块。
 * @param {object|null} report 落盘的 llm-sentiment-latest.json（null=未生成）
 * @param {object} ctx { score: 当日综合分(0-100), tradeDate: 档案最新交易日 }
 * @returns {object|null} null = 无有效证据（前端显示"未生成"）；否则参考块
 */
export function llmSentimentBlock(report, { score, tradeDate } = {}) {
  if (!report || typeof report !== 'object') return null;
  // 证据日期防伪（crosscheck 先例）：落盘 asOfDate 必须等于目标交易日——
  // LLM 报告是"某一天"的舆情快照，昨天的结论不能冒充今天的证据。
  if (!report.asOfDate || report.asOfDate !== tradeDate) return null;
  const raw = Number(report.sentiment);
  if (!Number.isFinite(raw) || raw < -1 || raw > 1) return null;

  const adj = clampAdj(Math.round(raw * LLM_ADJ_LIMIT * 10) / 10); // 保留 1 位小数
  const dir = directionOf(score);
  const llmDir = raw > 0 ? 'bullish' : (raw < 0 ? 'bearish' : null);
  // 生效判定：原分有方向 且 舆情同向（规则②③）
  let effective = false;
  let effectNote;
  if (dir == null) {
    effectNote = `原分 ${score} 处观望区（${DEFAULT_TH.hi}~${DEFAULT_TH.lo}），原因子无方向——舆情单方面不生效`;
  } else if (llmDir == null) {
    effectNote = 'LLM 舆情中性（sentiment=0），无修正';
  } else if (llmDir === dir) {
    effective = true;
    effectNote = `同向增强：原分 ${score} ${dir === 'bullish' ? '偏多' : '偏空'}，舆情 ${llmDir === 'bullish' ? '正面' : '负面'} → 参考分上浮/下调 ${adj > 0 ? '+' : ''}${adj}`;
  } else {
    effectNote = `方向矛盾：原分 ${score} ${dir === 'bullish' ? '偏多' : '偏空'} vs 舆情 ${llmDir === 'bullish' ? '正面' : '负面'}——保守起见保持原分，仅提示分歧`;
  }

  const original = Number.isFinite(+score) ? Math.round(+score * 10) / 10 : null;
  return {
    asOfDate: report.asOfDate,
    generatedAt: report.generatedAt || null,
    model: report.model || null,
    // LLM 原始输出与截断后的参考修正（|adj| ≤ 5 恒成立）
    sentimentRaw: Math.round(raw * 100) / 100,
    adj,
    // 生效三规则的可审计输出
    effective,
    effectNote,
    direction: dir,
    original,
    modified: effective && original != null
      ? Math.max(0, Math.min(100, Math.round((original + adj) * 10) / 10))
      : null, // 不生效时无修正分——null 显式化，不是等于 original
    // 事件抽取（LLM 输出，只透传不加工；上限防体积膨胀由 fetch 脚本裁）
    events: Array.isArray(report.events) ? report.events.slice(0, 8) : [],
    confidence: Number.isFinite(+report.confidence) ? Math.round(+report.confidence * 100) / 100 : null,
    reason: typeof report.reason === 'string' ? report.reason.slice(0, 200) : null,
    note: 'LLM 舆情试点（P2）：±5 分参考修正、原分不动、不独立生成买卖信号；'
      + '仅与原因子同向时生效，观望区/反向一律不生效。事件源以落盘文件留痕为准。',
  };
}
