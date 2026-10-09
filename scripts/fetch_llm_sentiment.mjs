// V5.3 P2 试点：LLM 舆情因子采集（事件抽取 + 情感打分 → ±5 参考修正的证据落盘）。
//
// 数据流（照 pain/breadth/crosscheck 三段式先例）：
//   本脚本（收盘后跑）→ data/llm-sentiment-latest.json
//   → src/engine/write.js llmFn（只读 + llmSentimentBlock 转换）
//   → signals-latest.llm + 研判简报「八、舆情参考」节。
//
// 输入（不新增数据源，需求 P2 前提）：档案最新日的题材结构（themes/themeList/
// momentum 三态）+ 强势股 reason 文本（getharden 已落盘，唯一带自然语言诱因的源）
// + summary 结构计数 + pain verdict（可选）。构造紧凑 prompt 喂 LLM。
//
// LLM 接入：OpenAI 兼容 chat/completions 协议（deepseek/qwen/glm/本地 ollama 均兼容），
//   读环境变量 LLM_API_URL / LLM_API_KEY / LLM_MODEL。缺配置 → 打印指引退出非 0
//   （缺=显式：不假装跑过 LLM，绝不落一个 sentiment=0 的空档冒充"舆情中性"）。
//
// 需求硬约束在消费端执行（src/llm_sentiment.js）：±5 上限、原分不动、观望区/
//   反向不生效、不独立生成买卖信号。本脚本只负责**证据生产与留痕**：
//   asOfDate 必须等于档案最新交易日（防伪：昨天的舆情不能冒充今天）。
//
// 用法：node scripts/fetch_llm_sentiment.mjs [--archive data/archive.json]
//   环境变量：LLM_API_URL（如 https://api.deepseek.com/v1）
//             LLM_API_KEY、LLM_MODEL（如 deepseek-chat）
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { atomicWriteJSON } from '../src/fsutil.js';
import { decodeArchive } from '../src/lhb_codec.js';
import { bjStamp } from '../src/time.js';
import { fetchWithRetry } from '../src/util.js';

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ARCHIVE = argOf('--archive', 'data/archive.json');
const OUT = new URL('../data/llm-sentiment-latest.json', import.meta.url);

const API_URL = process.env.LLM_API_URL || '';
const API_KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || '';

// ── 1. 从档案拼当日舆情素材（全部已落盘，零新增数据源）────────────────────
const arch = decodeArchive(JSON.parse(readFileSync(ARCHIVE, 'utf8')));
const days = (arch.all_days || []).filter((d) => d && d.trade_date);
if (!days.length) { console.error('[llm-sent] 档案无交易日，退出'); process.exit(1); }
const day = days[days.length - 1];

const themes = day.themes || {};
const themeList = (day.themeList || []).slice(0, 10)
  .map((t) => `${t.tag}(${t.count}只,强度${t.strength ?? '?'}${t.streak ? `,连${t.streak}` : ''})`);
const momentum = arch.signals?.momentum || day.momentum || {};
const mom = [
  ...((momentum.fresh || []).slice(0, 5).map((m) => `新晋:${m.theme}`)),
  ...((momentum.continuing || []).slice(0, 5).map((m) => `延续:${m.theme}`)),
  ...((momentum.fading || []).slice(0, 5).map((m) => `退潮:${m.theme}`)),
];
const hotReasons = (day.hot || []).slice(0, 15)
  .map((h) => `${h.name}(${h.change_pct != null ? h.change_pct + '%' : '?'}：${h.reason || '?'})`);
const s = day.summary || {};
let pain = null;
try {
  if (existsSync('data/pain-latest.json')) {
    const pj = JSON.parse(readFileSync('data/pain-latest.json', 'utf8'));
    pain = pj.verdict ? `${pj.verdict.label}（${pj.verdict.reason || ''}）` : null;
  }
} catch { pain = null; }

const brief = [
  `交易日：${day.trade_date}`,
  `综合情绪分：${day.emotion?.value ?? '缺失'}`,
  `涨停 ${s.zt_count ?? '?'} 家 / 跌停 ${s.dt_count ?? '?'} 家 / 炸板率 ${s.zbl_pct ?? '?'}% / 最高连板 ${s.max_lb ?? '?'}`,
  `两市成交额 ${s.amount_yi ?? '?'} 亿`,
  pain ? `亏钱效应：${pain}` : null,
  `题材梯队：${themeList.join('；') || '缺失'}`,
  `题材动量：${mom.join('；') || '缺失'}`,
  `强势股（涨幅+诱因）：${hotReasons.join('；') || '缺失'}`,
].filter(Boolean).join('\n');

// ── 2. 调 LLM（OpenAI 兼容协议）──────────────────────────────────────────
if (!API_URL || !API_KEY || !MODEL) {
  console.error('[llm-sent] ⚠ 缺 LLM 配置，无法采集舆情证据（退出非 0，不落空档）。');
  console.error('  请设置环境变量后重跑：');
  console.error('    LLM_API_URL   OpenAI 兼容服务地址（如 https://api.deepseek.com/v1）');
  console.error('    LLM_API_KEY   API 密钥');
  console.error('    LLM_MODEL     模型名（如 deepseek-chat / glm-4-flash / qwen-plus）');
  console.error('  语义提醒：LLM 输出仅为 ±5 分参考修正的证据（原分不动、不独立生成买卖信号），');
  console.error('  未跑本脚本时研判简报显示「未生成」，不会冒充「舆情中性」。');
  process.exit(2);
}

const SYSTEM = '你是A股市场舆情分析师。基于提供的当日市场结构数据（题材梯队/动量/强势股诱因/'
  + '涨停炸板等），做两件事：1) 事件抽取——识别当日驱动市场情绪的关键事件'
  + '（业绩预告/高管变动/减持/政策/行业催化等，最多8条，每条给 type/target/tone/note）；'
  + '2) 市场舆情情感打分——综合事件方向给出 -1~1 的 sentiment（-1 极度负面，0 中性，1 极度正面）'
  + '与 0~1 的 confidence。只输出一个 JSON 对象，不要任何其他文字。'
  + '格式：{"sentiment":0.0,"confidence":0.0,"reason":"一句话依据","events":[{"type":"","target":"","tone":"positive|negative|neutral","note":""}]}';

const user = `当日市场结构数据如下：\n${brief}\n\n请按要求输出 JSON。`;

const chat = await fetchWithRetry(`${API_URL.replace(/\/$/, '')}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${API_KEY}`,
  },
  timeout: 60000,
  read: async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const text = j?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('返回无 content');
    return text;
  },
}, 3, 2000);

// 从回复中提取 JSON（容忍 ```json 围栏与前后杂文）
const m = chat.match(/\{[\s\S]*\}/);
if (!m) {
  console.error('[llm-sent] ⚠ LLM 回复中未找到 JSON 对象，拒绝落盘（原文前 200 字）：');
  console.error(chat.slice(0, 200));
  process.exit(3);
}
let parsed;
try { parsed = JSON.parse(m[0]); } catch { console.error('[llm-sent] ⚠ JSON 解析失败，拒绝落盘'); process.exit(3); }

const sentiment = Number(parsed.sentiment);
if (!Number.isFinite(sentiment) || sentiment < -1 || sentiment > 1) {
  console.error(`[llm-sent] ⚠ sentiment 超界（${parsed.sentiment}），拒绝落盘`);
  process.exit(3);
}

// ── 3. 落盘（证据留痕：asOfDate 防伪 + 输入摘要供审计）────────────────────
const payload = {
  kind: 'llm-sentiment-latest',
  version: 1,
  asOfDate: day.trade_date,           // 证据属于哪一天（与档案最新交易日严格相等）
  generatedAt: bjStamp(),
  model: MODEL,
  sentiment: Math.round(sentiment * 100) / 100,
  confidence: Number.isFinite(+parsed.confidence) ? Math.round(+parsed.confidence * 100) / 100 : null,
  reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : null,
  events: (Array.isArray(parsed.events) ? parsed.events : []).slice(0, 8),
  // 输入摘要（审计用：证据可追溯到当日档案素材，非模型凭空生成）
  inputDigest: {
    themes: Object.keys(themes).length,
    hotListed: hotReasons.length,
    ztCount: s.zt_count ?? null,
    emotionValue: day.emotion?.value ?? null,
    painVerdict: pain,
  },
  note: '消费端（src/llm_sentiment.js）执行 ±5 上限/原分不动/观望区与反向不生效；'
    + '本文件只是证据留痕，sentiment 原始值不经截断。',
};

atomicWriteJSON(fileURLToPath(OUT), JSON.stringify(payload, null, 1));
console.log(`[llm-sent] ${day.trade_date} 舆情 sentiment=${payload.sentiment}`
  + `（置信度 ${payload.confidence}，事件 ${payload.events.length} 条）`);
console.log(`[llm-sent] 依据：${payload.reason}`);
console.log(`[llm-sent] 写出 ${fileURLToPath(OUT)}——下次写档自动进简报「八、舆情参考」节`);
