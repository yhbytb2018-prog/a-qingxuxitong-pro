#!/usr/bin/env node
// ── 前后端接口契约门禁（V5.3 同步机制 · 2026-10-05）────────────────────────
//
// 用途：校验磁盘数据档 vs schemas/*.json 契约（单一数据源）。
//   后端漏产/改名/裁字段 → required 红；类型漂移 → type 红；
//   前端加消费字段 → 契约先改 → 后端没跟上 → 同样红。
// 两端谁脱轨都会在这里现形——这就是「字段名不一致静默渲染空白」类 bug
// （missingNote→missingReason，commit 57a12b7）的常驻拦截器。
//
// 用法：
//   node scripts/check_contract.mjs            # 校验全部档（默认）
//   node scripts/check_contract.mjs backtest   # 只校验某个档（名称匹配）
//
// 接线：
//   · daily.yml build 段（写盘后立即校验——坏档不进提交）
//   · test/contract.test.mjs（node --test 门禁自动带上）
//
// 缺档处理：档不存在 = 红而非跳过（与 check_frontend 的 --require-jsdom 同理：
//   门禁静默降级 = 假绿）。唯一例外：intraday.json 盘中才有，非交易时段允许缺
//   ——但只在「非 live 相位」下放行（读 archive-index.meta.phase 判断），并显式打印跳过原因。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateContract, formatContractErrors } from '../src/contract.js';
import { cumFromSummary } from '../src/dual_track.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 档名 → 契约文件（数据档与契约同名映射，新增档必须补契约，否则下面的完整性
// 守卫会红——「新档没契约」本身就是同步缺口）。
// 条目形态：
//   'name'            = data/{name}.json ↔ schemas/{name}.schema.json（缺席即红）
//   { name, data, optionalReason } = 子目录档 + 设计性缺席（缺席打印原因跳过，
//     存在则结构校验——track_state.json 缺席 = 轨道 A 常态，非缺口）。
//   { name, dir, skip, optionalReason } = 目录形态：dir 下每个 .json（skip 名单
//     除外）逐个按同名契约校验——报告档按 {type}_{date}.json 一天多份，单文件
//     形态装不下（ai-report · 2026-10-07 补登记）。
const CONTRACTED = [
  'signals-latest',
  'backtest',
  'version-regression',
  'archive-index',
  'global',
  'intraday',
  { name: 'track-state', data: 'data/paper/track_state.json', optionalReason: '轨道 A 常态（无回滚状态属设计，P2-β 契约）' },
  { name: 'track-fallback-params', data: 'data/paper/track_fallback_params.json', optionalReason: '首次回滚前未提取快照属设计（rollback_track.mjs 运行时自动提取）' },
  { name: 'dual-track-latest', data: 'data/paper/dual_track_latest.json', optionalReason: '首日跑 tools/backtest/paper_dual_track.mjs 前无账本属设计（P2-β 渲染接线契约）' },
  // P3 应急联系人（2026-10-06 宣告确认）：**required 非 optional**——用户已确认联系人
  // 与值班链，此后缺席/损坏 = 红（告警 @ 链断裂是静默事故，门禁常驻拦截）。
  { name: 'emergency-contacts', data: 'config/emergency_contacts.json' },
  // S1 AI 报告信封（2026-10-07 补登记）：S1 引入 schemas/ai-report.schema.json 时
  // 漏登清单，10-07 18:30 build 首跑契约守卫爆孤儿红（此前 build 均在 S1 之前
  // 的代码上跑）。data/reports/ 下报告档一天多份（{type}_{date}.json），走目录
  // 形态逐个校验；index.json（目录索引）与 push_state.json（推送状态）自有
  // 结构非报告信封，在 skip 名单。
  { name: 'ai-report', dir: 'data/reports', skip: ['index.json', 'push_state.json'], optionalReason: '首跑前无报告档属设计（S2 四挂点首次运行后才产出）' },
];

// ── 跨档一致性守卫（P2-β · 纯函数，test/contract.test.mjs 负向演练同一逻辑）────
// 轨道回滚状态（事实源）↔ signals-latest.active_track（展示镜像）的绑定规则，
// 以及 track_state 自身的条件语义（小子集 schema 无 if/then，在此锁死）：
//   · A_fallback 态：镜像必须在场且值正确 + activeTrackNote 在场（降级客户端提示）+ fallback 段为对象；
//   · A 态：fallback 必须 null（残留=脏）+ signals 不得带 active_track（A 态零 diff 纪律）。
export function crossCheckTrackMirror(trackState, signalsLatest) {
  const fails = [];
  const st = trackState;
  const sig = signalsLatest;
  if (!st || typeof st !== 'object') return fails; // 缺席 = 轨道 A 常态（合法态，另有 optionalReason 打印）
  const at = st.activeTrack;
  if (at === 'A_fallback') {
    if (!sig || sig.active_track !== 'A_fallback') {
      fails.push('[contract] 一致性：track_state=A_fallback 但 signals-latest 缺 active_track 镜像（A_fallback 态镜像必须在场——paper_dual_track.mjs 自愈未跑？跑一遍 tools/backtest/paper_dual_track.mjs）');
    } else if (typeof sig.activeTrackNote !== 'string' || !sig.activeTrackNote.trim()) {
      fails.push('[contract] 一致性：A_fallback 态 activeTrackNote 必须在场且非空（降级客户端的提示文案，契约 schemas/signals-latest.schema.json）');
    }
    if (!(st.fallback && typeof st.fallback === 'object')) {
      fails.push('[contract] 一致性：activeTrack=A_fallback 时 fallback 段必须为对象（条件语义，头注见 schemas/track-state.schema.json）');
    }
  } else if (at === 'A') {
    if (st.fallback != null) {
      fails.push('[contract] 一致性：activeTrack=A 时 fallback 必须为 null（旧回滚元数据残留 = 状态脏；重跑 rollback_track.mjs --restore 或修 state）');
    }
    if (sig && 'active_track' in sig) {
      fails.push('[contract] 一致性：轨道 A 常态下 signals-latest 不得带 active_track（A 态零 diff 纪律；残留镜像 = rollback --restore 未清干净或手写漂移）');
    }
  } else {
    fails.push(`[contract] 一致性：track_state.activeTrack 非法值 ${JSON.stringify(at)}（enum: A | A_fallback；读取端降级策略=默认 A + warn）`);
  }
  return fails;
}

// ── 跨档一致性守卫（P2-β 渲染接线 · 纯函数，test/contract.test.mjs 负向演练同一逻辑）──
// 双轨账本（数字唯一出处）↔ signals-latest.dualTrack（披露块搬运）的绑定规则：
//   · 账本在场（day 段可判）→ 披露块必须在场且逐字段一致（day/cum/trackState/asOf）；
//   · 披露块在场 → 账本必须在场（凭空披露 = 口径分裂事故）；
//   · 一致性 = JSON.stringify 深比较（搬运端持引用组装，键序同源 → 磁盘两档必然逐位一致，
//     stringify 不一致就是真分裂——「报告说 A、算的是 B」的 R4 常驻拦截器）。
//   · cum 的期望值由 cumFromSummary(lt.summary) 生成（src/dual_track.js 单一出处，
//     守卫与搬运共用同一提取逻辑——两处各写 = 第二套口径）。
export function crossCheckDualTrack(latest, signalsLatest) {
  const fails = [];
  const lt = latest;
  const sig = signalsLatest;
  const ledgerOk = lt && typeof lt === 'object' && lt.day && typeof lt.day === 'object';
  const dt = sig && typeof sig === 'object' ? sig.dualTrack : undefined;
  if (ledgerOk) {
    if (!dt) {
      fails.push('[contract] 一致性：dual_track_latest.json 在场但 signals-latest 缺 dualTrack 披露块'
        + '（写盘路径未注入 dualTrackFn？重跑 pipeline 或 scripts/split_archive.mjs；注入实现 src/dual_track.js）');
      return fails;
    }
    // day 全量镜像（dayReturns 已随 36KB 预算重估恢复搬运）→ 纯深比较，无白名单例外
    if (JSON.stringify(dt.day) !== JSON.stringify(lt.day)) {
      fails.push('[contract] 一致性：signals.dualTrack.day 与 dual_track_latest.json::day 不一致（R4 口径分裂：报告说 A、算的是 B；重跑写盘路径刷新披露块）');
    }
    // cum（累计收益）：summary.total 面搬运一致性
    const expCum = cumFromSummary(lt.summary);
    if (JSON.stringify(dt.cum) !== JSON.stringify(expCum)) {
      fails.push('[contract] 一致性：signals.dualTrack.cum 与账本 summary.total 面不一致（累计收益搬运失真——含缺 cum 段的旧档；重跑写盘路径刷新披露块）');
    }
    const ltTrack = (lt.trackState && lt.trackState.activeTrack) || 'A';
    if (!dt.trackState || dt.trackState.activeTrack !== ltTrack) {
      fails.push(`[contract] 一致性：signals.dualTrack.trackState.activeTrack=${JSON.stringify(dt.trackState && dt.trackState.activeTrack)} 与账本 ${JSON.stringify(ltTrack)} 不一致`);
    }
    if (dt.asOf !== lt.day.date) {
      fails.push(`[contract] 一致性：signals.dualTrack.asOf=${JSON.stringify(dt.asOf)} ≠ 账本末日 ${JSON.stringify(lt.day.date)}`);
    }
  } else if (dt) {
    // 账本不可判（缺席/损坏）但披露块在场 = 凭空披露
    fails.push('[contract] 一致性：dual_track_latest.json 缺席/无可判 day 段，但 signals-latest 带 dualTrack 披露块（凭空披露——先跑 tools/backtest/paper_dual_track.mjs 再重写盘）');
  }
  return fails;
}

// ── 入口 ─────────────────────────────────────────────────────────────────
const filter = process.argv[2] || '';
const failures = [];
let checked = 0;
let skipped = 0;

const isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href; }
  catch { return false; }
})();

if (isMain) {
for (const entry of CONTRACTED) {
  const { name, data: dataRel, dir: dirRel, skip = [], optionalReason } = typeof entry === 'string'
    ? { name: entry, data: `data/${entry}.json`, optionalReason: null }
    : entry;
  if (filter && !name.includes(filter)) continue;
  const schemaPath = join(ROOT, 'schemas', `${name}.schema.json`);

  if (!existsSync(schemaPath)) {
    failures.push(`[contract] 契约缺失：schemas/${name}.schema.json 不存在（CONTRACTED 清单里有它）`);
    continue;
  }

  // 目录形态（ai-report 等）：dir 下每个 .json（skip 除外）逐个按信封契约校验
  if (dirRel) {
    const dirPath = join(ROOT, dirRel);
    if (!existsSync(dirPath)) {
      if (optionalReason) {
        skipped++;
        console.log(`[contract] ${dirRel}/ 缺席（${optionalReason}）——跳过结构校验`);
      } else {
        failures.push(`[contract] 数据目录缺失：${dirRel}/ 不存在（契约要求它在）`);
      }
      continue;
    }
    let schema;
    try { schema = JSON.parse(readFileSync(schemaPath, 'utf8')); } catch (e) {
      failures.push(`[contract] schemas/${name}.schema.json JSON 解析失败：${e.message}`);
      continue;
    }
    const files = readdirSync(dirPath).filter((f) => f.endsWith('.json') && !skip.includes(f)).sort();
    if (!files.length) {
      if (optionalReason) {
        skipped++;
        console.log(`[contract] ${dirRel}/ 无报告档（${optionalReason}）——跳过结构校验`);
      } else {
        failures.push(`[contract] 数据目录为空：${dirRel}/ 无可校验档`);
      }
      continue;
    }
    for (const f of files) {
      const p = join(dirPath, f);
      let data;
      try { data = JSON.parse(readFileSync(p, 'utf8')); } catch (e) {
        failures.push(`[contract] ${dirRel}/${f} JSON 解析失败：${e.message}`);
        continue;
      }
      checked++;
      const errs = validateContract(data, schema);
      if (errs.length) {
        failures.push(formatContractErrors(`${dirRel}/${f}`, errs));
      } else {
        console.log(`[contract] ${dirRel}/${f} ✓ 契约通过`);
      }
    }
    continue;
  }

  const dataPath = join(ROOT, dataRel);
  // intraday：仅 live 相位必须存在（盘后档不产是设计，不是缺口）
  if (!existsSync(dataPath)) {
    if (name === 'intraday') {
      let phase = '(未知)';
      try {
        const idx = JSON.parse(readFileSync(join(ROOT, 'data', 'archive-index.json'), 'utf8'));
        phase = (idx.meta && idx.meta.phase) || '(无)';
      } catch { /* 读不到相位就按未知处理 */ }
      if (phase !== 'live') {
        skipped++;
        console.log(`[contract] ${name}.json 缺席（相位 ${phase} ≠ live，盘中档不产属设计）——跳过`);
        continue;
      }
    }
    if (optionalReason) {
      skipped++;
      console.log(`[contract] ${dataRel} 缺席（${optionalReason}）——跳过结构校验`);
      continue;
    }
    failures.push(`[contract] 数据档缺失：${dataRel} 不存在（契约要求它在；intraday 仅 live 相位例外）`);
    continue;
  }

  let data, schema;
  try { data = JSON.parse(readFileSync(dataPath, 'utf8')); } catch (e) {
    failures.push(`[contract] ${dataRel} JSON 解析失败：${e.message}`);
    continue;
  }
  try { schema = JSON.parse(readFileSync(schemaPath, 'utf8')); } catch (e) {
    failures.push(`[contract] schemas/${name}.schema.json JSON 解析失败：${e.message}`);
    continue;
  }

  checked++;
  const errs = validateContract(data, schema);
  if (errs.length) {
    failures.push(formatContractErrors(dataRel, errs));
  } else {
    console.log(`[contract] ${dataRel} ✓ 契约通过`);
  }
}

// ── 完整性守卫：schemas/ 目录里的契约必须在 CONTRACTED 清单（防孤儿契约：
//   档已下线但契约还挂着，误导后来人）──────────────────────────────────
const CONTRACTED_NAMES = CONTRACTED.map((e) => (typeof e === 'string' ? e : e.name));
for (const f of readdirSync(join(ROOT, 'schemas'))) {
  if (!f.endsWith('.schema.json')) continue;
  const name = f.replace('.schema.json', '');
  if (!CONTRACTED_NAMES.includes(name)) {
    failures.push(`[contract] 孤儿契约：schemas/${f} 不在 check_contract.mjs 的 CONTRACTED 清单里（档下线/改名须同步清单）`);
  }
}

// ── 跨档一致性守卫（P2-β）：轨道状态 ↔ signals-latest 展示镜像 ─────────────
{
  const tsPath = join(ROOT, 'data', 'paper', 'track_state.json');
  const sigPath = join(ROOT, 'data', 'signals-latest.json');
  if (existsSync(tsPath) && existsSync(sigPath)) {
    let st = null, sig = null;
    try { st = JSON.parse(readFileSync(tsPath, 'utf8')); } catch (e) {
      failures.push(`[contract] data/paper/track_state.json JSON 解析失败：${e.message}`);
    }
    try { sig = JSON.parse(readFileSync(sigPath, 'utf8')); } catch (e) {
      failures.push(`[contract] data/signals-latest.json JSON 解析失败：${e.message}`);
    }
    failures.push(...crossCheckTrackMirror(st, sig));
  }
}

// ── 跨档一致性守卫（P2-β 渲染接线）：双轨账本 ↔ signals-latest.dualTrack 披露块 ──
{
  const ltPath = join(ROOT, 'data', 'paper', 'dual_track_latest.json');
  const sigPath = join(ROOT, 'data', 'signals-latest.json');
  if (existsSync(ltPath) && existsSync(sigPath)) {
    let lt = null, sig = null;
    try { lt = JSON.parse(readFileSync(ltPath, 'utf8')); } catch (e) {
      failures.push(`[contract] data/paper/dual_track_latest.json JSON 解析失败：${e.message}`);
    }
    try { sig = JSON.parse(readFileSync(sigPath, 'utf8')); } catch (e) {
      failures.push(`[contract] data/signals-latest.json JSON 解析失败：${e.message}`);
    }
    if (lt && sig) failures.push(...crossCheckDualTrack(lt, sig));
  }
}

if (filter && checked + skipped === 0) {
  console.error(`[contract] 过滤词「${filter}」未命中任何档（可选：${CONTRACTED_NAMES.join(', ')}）`);
  process.exit(2);
}
if (failures.length) {
  console.error(`\n${failures.join('\n')}`);
  console.error(`\n[contract] ✗ 未通过：${failures.length} 个档违例（${checked} 校验 / ${skipped} 跳过）。`);
  console.error('[contract] 修复顺序：先改 schemas/ 契约（若有意变更）→ 同步两端代码 → 重跑本脚本与相关产出脚本。');
  console.error('[contract] 变更流程详见 schemas/signals-latest.schema.json 头注与 README「接口契约」章节。');
  process.exit(1);
}
console.log(`\n[contract] 全部通过：${checked} 个档（${skipped} 跳过）。前后端接口与 schemas/ 契约一致。`);
} // isMain 结束
