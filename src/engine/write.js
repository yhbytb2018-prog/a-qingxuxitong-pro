// 引擎：存档写盘 + 切片生成（从 src/pipeline.js 拆出，2026-10-05 批次3 4.1）。
//
// 拆分纪律：函数体**逐字搬移**、零语义改动——写盘形态（码表压缩 + deflate + 紧凑 JSON）
// 由审计断言（"主档写盘态 lhb 已提子"）与 split_archive --check 往返校验锁死，
// 搬移本身不得引入任何行为差异。src/pipeline.js 对本模块 re-export，既有调用方
// import 路径零改动；新代码请直接 import './engine/write.js'。
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { atomicWriteJSON } from '../fsutil.js';
import { validateArchive } from '../validate.js';
import { resolveHolidays } from '../calendar.js';
import { assessFreshness } from '../freshness.js';
import { buildIndex, buildShards, shardName, buildRecent, buildSignals, RECENT_DAYS, RECENT_FILE, SIGNALS_FILE } from '../archive_split.js';
import { buildReasonCodes, encodeArchive } from '../lhb_codec.js';
import { marketAlerts } from '../alerts.js';
import { aggregateByCode } from '../lhb.js';
import { healthReport } from '../health.js';
import { buildSeatSeries, seatSeriesSummary, seatVerdict } from '../seats_daily.js';
import { buildBreadthSeries, breadthSeriesSummary } from '../breadth.js';
import { buildRegimeBlock, buildDivergenceBlock } from '../regime.js';
import { buildDailyReport } from '../daily_report.js';
import { llmSentimentBlock } from '../llm_sentiment.js';
import { dualTrackDisclosureFn } from '../dual_track.js';
import { guardModule } from '../module_freshness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data'); // <root>/data（与 pipeline.js 同一目录）

export function writeArchive(archive, filePath) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const p = filePath || path.join(DATA_DIR, 'archive.json');
  const { ok, errors } = validateArchive(archive);
  if (!ok) {
    throw new Error('校验失败: ' + errors.join('; '));
  }
  // 码表压缩 + 提子：只在**落盘时**生效（内存里始终是中文原文，口径正则才不会失配）。
  // 主档与切片都写压缩态——它们都是读盘产物，读回来统一走 decodeArchive 还原。
  //
  // ⚠ 提子（deflate）必须开启，且与 src/lhb_codec.js 的 writeArchiveSafely 一致。
  //   历史坑：本函数曾漏传 `{ deflate: true }`，于是 pipeline 写出的主档是
  //   `day.lhb` 内联，而 writeArchiveSafely / 存量档是 `day._sub.lhb`——
  //   同一份存档有了两种形态，审计断言（"主档写盘态 lhb 已提子"）在
  //   pipeline 自己写完之后反而变红。两条写盘路径必须产出同一种形态。
  //   本次由 backfill_relative.mjs 走 writeArchive 回写存量档时暴露。
  const codes = buildReasonCodes(archive.all_days);
  const packed = encodeArchive(archive, codes, { deflate: true });
  // 紧凑写盘：`rc` 是数字下标数组，加 2 空格缩进会被 JSON 展开成一行一个数字，
  // 缩进开销足以吃掉码表 92% 的收益（实测 4.99MB → 9.44MB，比压缩前还大）。
  // H-4（2026-10-07）：原子替换（同目录 tmp + rename）——裸写中途被杀会留半截主档，
  // 且下游读到损坏档会静默回退旧快照。
  atomicWriteJSON(p, JSON.stringify(packed));
  // 切片与主档**同源生成**：每次写主档都重建切片，杜绝"两个文件各自演化"。
  // 判据是"写的是默认主档"（按解析后绝对路径比对）——pipeline 恒传默认路径，
  // 必须生成切片；测试/临时 --out 写别的位置时不污染 data/ 下的切片。
  // 历史坑（2026-10-08 实录）：旧判据 `if (!filePath)` 在 pipeline 显式传路径时恒为
  //   false → 本地跑 pipeline 只写主档、切片永不刷新 → 前端一直显示旧交易日。
  let shards = null;
  if (path.resolve(p) === path.join(DATA_DIR, 'archive.json')) {
    try {
      shards = writeShards(packed);
    } catch (e) {
      // 切片失败不得让主档写入回滚（主档是权威源，切片是派生视图）
      console.error('[split] 切片生成失败（主档已写入，前端将回退全量档）:', e.message);
    }
  }
  return { path: p, ok: true, shards, reasonCodes: codes.length };
}

// 生成「索引 + 按年分片 + 近 N 日滚动窗」。与 scripts/split_archive.mjs 共用
// src/archive_split.js，保证两条路径产出的切片结构完全一致（不存在两套拆法）。
export function writeShards(archive, dir = DATA_DIR) {
  const index = buildIndex(archive);
  const shards = buildShards(archive);
  const years = Object.keys(shards).sort();
  // ② 离线模块新鲜度守卫的档案锚（2026-10-08 第三批）：宽度/主线/账本三模块只在
  //   CI build 里产出，本步读盘注入时若档日期落后于档案日（smoke 拦 build / 模块步骤
  //   失败被 continue-on-error 吞掉），旧值不得顶替当日值进 signals——一律置 missing
  //   走中性（与 s_amt 缺失 → 中性 50 同路径）。判据纯字符串比较，假期同停不误杀。
  const archiveDate = (archive?.all_days || []).slice(-1)[0]?.trade_date ?? null;
  atomicWriteJSON(path.join(dir, 'archive-index.json'), JSON.stringify(index));
  for (const y of years) {
    atomicWriteJSON(path.join(dir, shardName(y)), JSON.stringify(shards[y]));
  }
  // 滚动窗：走势图/抽屉只需最近 30 个交易日，不该为它拉整年分片（2026 年分片仍 >4MB）
  // 注入 aggregateByCode：主档不再持久化 lhb_aggr（体积纪律，见 recalc_lhb_daily.mjs），
  //   而滚动窗「最新日」是展示层唯一入口，需带 lhb_aggr 一屏。这里现从当日 lhb 聚合，
  //   只算 1 天，代价 O(条数)。本模块保持零业务依赖（与 marketAlertsFn 同款注入）。
  const recent = buildRecent(archive, RECENT_DAYS, { aggregateFn: aggregateByCode });
  atomicWriteJSON(path.join(dir, RECENT_FILE), JSON.stringify(recent));
  // 最轻档：只含最新日 + 动量 + 大盘告警 + 数据健康（~14KB）。给"不跑前端只看今日结论"的读者。
  // marketAlerts / healthReport 都是**纯函数**，注入进来而不是让本模块 import 业务依赖 —— 保持 archive_split 无业务依赖。
  // 健康报告注入 assessFreshness + meta：新鲜度那一项需要日历与"当前时刻"，
  //   两者都只有管线这边有（前端没有日历文件），故必须在这里算好随文件下发。
  const signals = buildSignals(archive, {
    assumedTotal: 100000,
    marketAlertsFn: marketAlerts,
    healthFn: (ds, o) => healthReport(ds, {
      ...o,
      assessFn: assessFreshness,
      holidays: resolveHolidays(),
    }),
    // 席位属性（#1）：纯函数，只读 summary.seats，无网络依赖 → 每次写档都刷新，
    //   历史随有数据的天数自然增长（接口只保留最近数日，见 src/seats_daily.js 头注）。
    seatSeriesFn: (ds) => {
      const series = buildSeatSeries(ds);
      return { series, summary: seatSeriesSummary(series, { totalDays: ds.length }), verdict: seatVerdict(series) };
    },
    // 亏钱效应（#2）：需要**全市场真实行情**，本函数是同步的、不能 await，
    //   故这里只读已落盘的 pains 缓存（由 scripts/fetch_pain.mjs 在收盘后写入）。
    //   读不到就是 null —— 绝不在此现造，否则会把失败伪装成"今天很平静"。
    painFn: () => {
      try {
        const p = path.join(dir, 'pain-latest.json');
        if (!existsSync(p)) return null;
        return JSON.parse(readFileSync(p, 'utf8'));
      } catch { return null; }
    },
    // 双轨披露块（P2-β 渲染接线）：读已落盘的 data/paper/dual_track_latest.json
    //   （由 tools/backtest/paper_dual_track.mjs 每日产出）。与 split_archive.mjs 用
    //   **同一工厂产物**（同一注入 = 两路径产出逐字段一致，否则 --check 报形态分裂）。
    //   读不到就是 null（前端显示"未生成"，绝不渲染成"轨道一致"）；
    //   ②守卫：账本 day.date 落后于档案锚 → 同样置 null（旧值不进当日 signals）。
    dualTrackFn: dualTrackDisclosureFn(dir, archiveDate),
    // 市场宽度（#3）：读已落盘的 breadth-latest.json / breadth-daily.json
    //   （由 scripts/fetch_breadth.mjs 在收盘后分片抓全市场 K 线后汇总）。
    //   同样**只读不现算**：宽度要扫全市场 K 线，不可能在同步写盘路径里做；
    //   读不到就是 null，绝不伪造一个"宽度正常"。
    breadthFn: () => {
      try {
        const p = path.join(dir, 'breadth-latest.json');
        if (!existsSync(p)) return null;
        const snapshot = JSON.parse(readFileSync(p, 'utf8'));
        // ② 新鲜度守卫：宽度档日期落后于档案锚 → 旧值不进 signals（null = 前端
        //   「未计算」，与档缺失同一语义）。真滞后由 CI 的 freshness --require-fresh
        //   门禁另行标红；这里只保证「不冒充当日值」。
        const g = guardModule(snapshot, archiveDate);
        if (!g.ok) {
          console.warn(`[split] 宽度档未过新鲜度守卫（${g.reason}：${g.moduleDate ?? '(无日期)'} vs 档案日 ${archiveDate ?? '(无)'}）→ breadth 置 missing`);
          return null;
        }
        // 逐日序列（可选）：有了才下发，没有就只给快照。
        let series = [];
        let summary = null;
        const dp = path.join(dir, 'breadth-daily.json');
        if (existsSync(dp)) {
          const daily = JSON.parse(readFileSync(dp, 'utf8'));
          series = buildBreadthSeries(daily.rows || []);
          // 覆盖率分母用**档案里的交易日数**（不是宽度序列长度）——否则滤空行后恒为 100%，
          // 会虚报覆盖（seats_daily 踩过同一个坑）。
          summary = breadthSeriesSummary(series, { totalDays: (archive.all_days || []).length });
        }
        return { snapshot, series, summary, verdict: snapshot.verdict || null };
      } catch { return null; }
    },
    // 跨源一致性互证（#2）：读已落盘的 crosscheck-latest.json
    //   （由 scripts/fetch_crosscheck.mjs 联网取第二行业源后写入）。
    //   本函数同步、不能 await，故**只读不现抓**——读不到就是 null，
    //   前端显示"未互证"，**绝不把"没做互证"渲染成"两源一致"**（本项目铁律：没检查 ≠ 没问题）。
    crosscheckFn: () => {
      try {
        const p = path.join(dir, 'crosscheck-latest.json');
        if (!existsSync(p)) return null;
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        // 体积纪律：signals 是最轻档（<50KB 预算），而 crosscheck 的逐行业明细（72+ 行）
        //   在**首屏面板上并不需要**——面板只展示 KPI + flagged（越界项）。
        //   rows 仍留在 crosscheck-latest.json 里（供审计/人工复核按需拉取），
        //   此处只裁剪下发给首屏的那一份，避免"为了一个面板把轻量档吹大"。
        const { rows, ...brief } = raw;
        return { ...brief, rowCount: Array.isArray(rows) ? rows.length : 0 };
      } catch { return null; }
    },
    // LLM 舆情参考（V5.3 P2 试点）：只读已落盘的 llm-sentiment-latest.json
    //   （由 scripts/fetch_llm_sentiment.mjs 收盘后调 LLM 写入）。
    //   **只读不现调**——同步写盘路径不能 await LLM；读不到就是 null，
    //   前端显示"未生成"，绝不把"没跑 LLM"渲染成"舆情中性"。
    //   转换（±5 截断/生效三规则/证据日期防伪）走 src/llm_sentiment.js 唯一出处，
    //   判定用的 score/tradeDate 取档案最新日——证据与结论对齐同一天。
    llmFn: () => {
      try {
        const p = path.join(dir, 'llm-sentiment-latest.json');
        if (!existsSync(p)) return null;
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        const all = archive.all_days || [];
        const last = all[all.length - 1] || null;
        return llmSentimentBlock(raw, {
          score: last?.emotion?.value ?? last?.emotion?.score ?? null,
          tradeDate: last?.trade_date ?? null,
        });
      } catch { return null; }
    },
    // 拐点标签（#4）：**纯函数、只读档案**（不读盘、不联网）→ 每次写档都刷新，
    //   与 scripts/split_archive.mjs 用**同一份** buildRegimeBlock，保证两路形态一致。
    regimeFn: (ds) => buildRegimeBlock(ds),
    // 宽度背离告警（#3 决策）：与 regime 同源同形态。**独立于日报**注入——
    //   日报生成失败不该把背离一起带走（两者失败域不同）。
    //   宽度读数从已落盘的 breadth-daily.json 读（与上面 breadthFn 同一份文件、
    //   同一套 buildBreadthSeries 汇总），不存在"两处各算一次宽度"。
    divergenceFn: (ds) => {
      let breadth = null;
      try {
        const bp = path.join(dir, 'breadth-latest.json');
        if (existsSync(bp)) {
          const snapshot = JSON.parse(readFileSync(bp, 'utf8'));
          // ② 新鲜度守卫（与 breadthFn 同判据同出处）：宽度档落后 → breadth 置 null，
          //   背离判定走「无宽度读数」中性路径，绝不用旧宽度给当日情绪定背离结论。
          const g = guardModule(snapshot, archiveDate);
          if (g.ok) {
            let series = [];
            const dp = path.join(dir, 'breadth-daily.json');
            if (existsSync(dp)) series = buildBreadthSeries(JSON.parse(readFileSync(dp, 'utf8')).rows || []);
            // verdict 取 breadth-latest.json 的**对象形态** { level, label, detail }——
            //   buildBreadthSeries 产出的是字符串 verdict，只够上色、没有 label 文案可比对。
            //   与上面 breadthFn 读同一份文件，不存在"两处各算一次宽度"。
            breadth = { snapshot, series, verdict: snapshot.verdict || null };
          } else {
            console.warn(`[split] 宽度档未过新鲜度守卫（${g.reason}：${g.moduleDate ?? '(无日期)'} vs 档案日 ${archiveDate ?? '(无)'}）→ 背离判定 breadth 置 null 走中性`);
          }
        }
      } catch { breadth = null; }
      return buildDivergenceBlock(ds, breadth);
    },
    // 每日日报（#4）：纯渲染，输入是上面各段已算好的素材 → 同源同形态。
    reportFn: (payload) => buildDailyReport(payload),
  });
  if (signals) atomicWriteJSON(path.join(dir, SIGNALS_FILE), JSON.stringify(signals));
  // 清理被淘汰的年份分片（年份集合会变），避免前端拉到过期数据
  try {
    const keep = new Set([...years.map((y) => shardName(y)), RECENT_FILE, SIGNALS_FILE]);
    for (const f of readdirSync(dir)) {
      if (/^archive-\d{4}\.json$/.test(f) && !keep.has(f)) {
        unlinkSync(path.join(dir, f));
        console.log('[split] 删除过期分片', f);
      }
    }
  } catch { /* 目录读取失败不致命 */ }
  return {
    index: 'archive-index.json',
    recent: RECENT_FILE,
    signals: SIGNALS_FILE,
    years,
    totalDays: (archive.all_days || []).length,
    recentDays: recent.days.length + (recent.latest ? 1 : 0),
  };
}
