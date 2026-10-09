// 参数回滚门禁：params.live → 任一历史版本的唯一合法反向通道（与 promote_params.mjs 成对，
// 2026-10-06 拍板，P1）。晋升走样本外门禁；回滚走**紧急通道**——不设统计门禁（回滚
// 本身就是"承认门禁被实盘证伪"，再设门禁等于要求病人先跑体检才准进急诊），但代价是
// **全程留痕 + 三重验证 + 双保险备份**，且必须显式 --why。
//
// ── 用法 ────────────────────────────────────────────────────────────────────
//   node scripts/rollback_params.mjs                        # 只读：列版本 + 当前 live 对齐状态
//   node scripts/rollback_params.mjs --to baseline --why "..."   # 回滚到 V5.2 基线（entry 0）
//   node scripts/rollback_params.mjs --to prev --why "..."      # 回滚到上一版本
//   node scripts/rollback_params.mjs --to 2 --why "..."         # 回滚到 changelog 序号 2 的快照
//   （--who 可选，缺省取 git user.name）
//
// ── 什么时候执行回滚（触发条件，唯一出处）──────────────────────────────────
//   R1 晋升被证伪：晋升后新样本上 OOS rankKey 持续劣化（用 scripts/backtest.mjs
//      口径复核 ≥2 周），确认是参数劣化而非噪声；
//   R2 实盘尸检定性：模拟盘逼线（12% 心理止损线）启动尸检，**尸检结论指向参数/机制
//      失效**（如信号持续错向、阈值口径漂移），而非市场极端 Beta；
//   R3 执行面误判：未来若 regime 帽/T1 等进入执行层后出现系统性误判
//      （回滚到不含该机制的快照即等效关闭——压仓类规则退出天然干净）；
//   R4 口径分裂：出现「报告说 A、算的是 B」的 live 漂移（治理测试红且无法当场解释）。
//
//   ⚠ 什么情况【不】回滚（同样重要，防手抖）：
//   · 市场极端 Beta（V 型急跌/连崩）本身不是回滚理由——P0 止损沙盘已证明：样本内
//     急跌全 V 型，熔断/清仓劣于降仓链死扛（SEG4 慢刀 -12.87% vs 无风控 -19.47%）；
//   · 数据链路故障（抓取失败/源失效）→ 参数没坏，先修数据（ops-alerts 已有对应事件）；
//   · 单日回撤心理不适 → 走尸检流程，不走回滚。
//
// ── 安全设计（紧急但不裸奔）────────────────────────────────────────────────
//   ① 先备份：回滚前把当前 live 五块快照写 data/params_rollback_backup.json
//      （保留不删——changelog 之外的第二恢复通道，磁盘级双保险）；
//   ② changelog 留痕：rollback entry 带 liveBefore 快照 → 回滚本身可逆
//      （回滚的回滚 = 再 rollback --to 指向回滚前 entry）；
//   ③ 三重验证（回滚后自动执行，任一失败大声报警并给出恢复指令）：
//      a. config 结构校验（子进程重新加载 src/config.js——权重和/阈值序/键集合）；
//      b. 引擎锚点：回滚到 baseline 时与 data/backtest.json::v52 全样本对账
//      （-1.50%/13.79%）；非 baseline 目标跑 OOS 引擎烟雾（指标有限数）；
//      c. 治理守卫（node --test test/params_governance.test.mjs——镜像逐位锁定 +
//      changelog 台账一致；最后跑，因为它校验的是 pass 回写后的 changelog 最终态）；
//   ④ 通知：rollback 事件写入 data/ops-alerts-latest.json（复用 writeOpsAlerts
//      通道，cap=50 历史）——Webhook/邮件通道接通后此事件流自动同源，无需改造。
//
//   目标耗时：单命令 < 10s（远低于 5 分钟 SLA）；真正的 5 分钟预算留给人读
//   只读预览 + 决策 --why。
import { readFileSync, writeFileSync } from 'node:fs';
import { atomicWriteJSON } from '../src/fsutil.js';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../src/config.js';
import { writeOpsAlerts } from '../src/opsalerts.js';
import { decodeArchive } from '../src/lhb_codec.js';
import { BASE_PARAMS, scoreWith, poolBacktest, rankKey } from '../src/backtest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BLOCKS = ['weights', 'thresholds', 'stops', 'lookback', 'costModel'];
const args = process.argv.slice(2);
const toArg = (() => { const i = args.indexOf('--to'); return i >= 0 ? args[i + 1] : null; })();
const whyArg = (() => { const i = args.indexOf('--why'); return i >= 0 ? args[i + 1] : null; })();
const whoArg = (() => { const i = args.indexOf('--who'); return i >= 0 ? args[i + 1] : null; })();
const r4 = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4);
const deepEqual = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
const snapOf = (blocks) => Object.fromEntries(BLOCKS.map((b) => [b, JSON.parse(JSON.stringify(blocks[b]))]));

// ── 1. 读 changelog：版本链事实基准 ─────────────────────────────────────────
const logPath = path.join(ROOT, 'params_changelog.json');
const log = JSON.parse(readFileSync(logPath, 'utf8'));
if (!Array.isArray(log.entries) || !log.entries.length) {
  console.error('[rollback] params_changelog.json 无 entries —— 无可回滚版本，终止。');
  process.exit(1);
}
const live = config.params.live;
const liveSnap = snapOf(live);
const entries = log.entries;

// 每个 entry 必须有完整 liveAfter 五块（否则版本链断裂，回滚到它会产出残缺 live）
entries.forEach((e, i) => {
  const ok = e.liveAfter && BLOCKS.every((b) => e.liveAfter[b] && typeof e.liveAfter[b] === 'object');
  if (!ok) {
    console.error(`[rollback] entry ${i}（${e.at}）liveAfter 快照残缺 —— 版本链断裂，终止（先修复 changelog）。`);
    process.exit(1);
  }
});

const alignedIdx = (() => {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (BLOCKS.every((b) => deepEqual(live[b], entries[i].liveAfter[b]))) return i;
  }
  return -1;
})();

// ── 2. 只读模式：列版本 + 对齐状态 ──────────────────────────────────────────
function describe(i) {
  const e = entries[i];
  const tag = i === 0 ? ' [BASELINE=V5.2]' : (e.validation?.type === 'rollback' ? ' [回滚]' : ' [晋升]');
  return `${String(i).padStart(3)}  ${e.at}  ${(e.who || '?').padEnd(12)}${tag}  ${(e.what || '').slice(0, 52)}`;
}
console.log('═══ params.live 版本链（params_changelog.json） ═══');
entries.forEach((_, i) => console.log(describe(i) + (i === alignedIdx ? '   ← 当前 live 对齐此版' : '')));
if (alignedIdx < 0) {
  console.log('⚠ 当前 config.json params.live 与任何历史快照都不一致（手动改动漂移？治理测试应已红）。');
}
if (!toArg) {
  console.log('\n只读模式（未改任何文件）。执行回滚：node scripts/rollback_params.mjs --to baseline|prev|<序号> --why "..."');
  console.log('触发条件（R1~R4 / 不回滚清单）见本脚本头注释。回滚 = 紧急动作，--why 必填。');
  process.exit(0);
}

// ── 3. 解析回滚目标 ────────────────────────────────────────────────────────
let targetIdx = -1;
if (toArg === 'baseline') targetIdx = 0;
else if (toArg === 'prev') {
  // prev = 按时间倒序第一个 liveAfter ≠ 当前 live 的版本（正常态即"上一版"；
  // 若当前 live 已漂移，则 prev = 最后一个 entry 的快照——回到最近的已知好版本）
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!BLOCKS.every((b) => deepEqual(live[b], entries[i].liveAfter[b]))) { targetIdx = i; break; }
  }
  if (targetIdx < 0) { console.error('[rollback] prev 解析失败：无可用目标。'); process.exit(1); }
} else if (/^\d+$/.test(toArg)) {
  targetIdx = parseInt(toArg, 10);
  if (targetIdx < 0 || targetIdx >= entries.length) {
    console.error(`[rollback] 序号 ${targetIdx} 超出范围（0~${entries.length - 1}）。`);
    process.exit(1);
  }
} else {
  console.error(`[rollback] 无法识别 --to "${toArg}"（支持 baseline / prev / 序号）。`);
  process.exit(1);
}
const target = entries[targetIdx];
const targetSnap = snapOf(target.liveAfter);
if (BLOCKS.every((b) => deepEqual(live[b], targetSnap[b]))) {
  console.error(`[rollback] 目标版本（entry ${targetIdx}）与当前 live 完全一致 —— no-op，拒绝执行（防重复回滚污染 changelog）。`);
  process.exit(1);
}
if (!whyArg || !whyArg.trim()) {
  console.error('[rollback] --why 必填（触发条件 R1~R4 之一 + 具体证据；changelog 留痕纪律）。');
  process.exit(1);
}
const changed = BLOCKS.filter((b) => !deepEqual(live[b], targetSnap[b]));
console.log(`\n[rollback] 目标：entry ${targetIdx}（${target.at}，${target.what?.slice(0, 60)}）`);
console.log(`          差异块：${changed.join(' / ')}`);
console.log(`          理由：${whyArg.trim()}`);

// ── 4a. 备份当前 live（第二恢复通道，先于任何写操作）────────────────────────
const backupPath = path.join(ROOT, 'data', 'params_rollback_backup.json');
atomicWriteJSON(backupPath, JSON.stringify({
  at: new Date().toISOString(),
  note: '回滚前 live 快照（rollback_params.mjs 自动备份；恢复 = rollback --to 指向回滚 entry，或手工取本文件五块）',
  liveBefore: liveSnap,
}, null, 2) + '\n', 'utf8');
console.log(`[rollback] 当前 live 已备份 → ${path.relative(ROOT, backupPath)}`);

// ── 4b. 机器重写 config.json（live 五块 + 顶层双写镜像，与 promote 同一写法）──
const cfgPath = path.join(ROOT, 'config.json');
const json = JSON.parse(readFileSync(cfgPath, 'utf8'));
if (!json.params?.live || !json.params?.train) {
  console.error('[rollback] config.json 缺 params.live/train 双套结构 —— 拒绝改写（防误伤）。');
  process.exit(1);
}
json.params.live = targetSnap;
json.weights = targetSnap.weights;
json.lookback = targetSnap.lookback;
json.backtest.thresholds = targetSnap.thresholds;
json.backtest.costs = targetSnap.costModel;
json.backtest.rolling = targetSnap.lookback.rolling;
json.backtest.maxPos = targetSnap.stops.maxPos;
json.backtest.stopLoss = targetSnap.stops.stopLoss;
json.backtest.ddTrigger = targetSnap.stops.ddTrigger;
json.backtest.maxPosChg = targetSnap.stops.maxPosChg;
json.momentumRecent = targetSnap.lookback.momentumRecent;
json.momentumPrev = targetSnap.lookback.momentumPrev;
atomicWriteJSON(cfgPath, JSON.stringify(json, null, 2) + '\n');
console.log('[rollback] config.json params.live 已更新（顶层双写镜像同步）');

// ── 4c. 追加 changelog entry（liveBefore 快照 → 回滚可逆）───────────────────
let who = whoArg;
if (!who) {
  try { who = execSync('git config user.name').toString().trim() || 'unspecified'; }
  catch { who = 'unspecified'; }
}
entries.push({
  at: new Date().toISOString(),
  who,
  what: `回滚 live 参数 → entry ${targetIdx} 快照（${(target.what || '').slice(0, 40)}）`,
  why: whyArg.trim(),
  // pass 由三重验证结果回写（见第 5.5 步）：失败 = false → 治理守卫红（「未过门禁不许
  // 留 live 状态」对回滚同样成立——回滚验证没过也是一种未过门禁的 live 变更）。
  validation: { type: 'rollback', targetIdx, targetAt: target.at, trigger: 'manual-R1~R4', pass: null },
  liveBefore: liveSnap,
  liveAfter: targetSnap,
});
atomicWriteJSON(logPath, JSON.stringify(log, null, 2) + '\n');
console.log('[rollback] params_changelog.json 已追加回滚记录（entry ' + (entries.length - 1) + '，含 liveBefore → 本操作可逆）');

// ── 5. 三重验证（任一失败大声报警 + 恢复指令）───────────────────────────────
const verifications = [];
function check(name, fn) {
  try { fn(); verifications.push([name, true, null]); console.log(`[rollback] 验证 ✓ ${name}`); }
  catch (err) { verifications.push([name, false, String(err?.message || err)]); console.error(`[rollback] 验证 ✗ ${name}：${err?.message || err}`); }
}

// 5a. config 结构校验（子进程冷加载：权重和/阈值序/键集合/涨跌停布尔）
check('config 结构校验（冷加载 src/config.js）', () => {
  execSync('node -e "import(\'./src/config.js\').then(() => console.log(\'loaded\'))"', { cwd: ROOT, stdio: 'pipe' });
});

// 5b. 引擎锚点 / OOS 烟雾（先跑——治理守卫挪到最后，见 5d 注释）
const isBaseline = targetIdx === 0 && BLOCKS.every((b) => deepEqual(targetSnap[b], entries[0].liveAfter[b]));
try {
  const arch = decodeArchive(JSON.parse(readFileSync(path.join(ROOT, 'data', 'archive.json'), 'utf8')));
  const days = (arch.all_days || []).filter((d) => d && d.trade_date && !(d.emotion && d.emotion._backfill));
  const factorsByDay = days.map((d) => d.emotion?.factors || {});
  const dates = days.map((d) => d.trade_date);
  const ASSETS = config.backtest.assets;
  const retsByAsset = {};
  for (const a of ASSETS) {
    retsByAsset[a] = days.map((d) => { const v = d.indexes?.[a]; return Number.isFinite(v) ? v / 100 : 0; });
  }
  const plainW = {};
  for (const [wk, pk] of Object.entries(config.factorKeyMap)) plainW[pk] = targetSnap.weights[wk];
  const scores = scoreWith(factorsByDay, plainW);
  const p = {
    ...BASE_PARAMS, ...targetSnap.thresholds,
    maxPos: targetSnap.stops.maxPos, stopLoss: targetSnap.stops.stopLoss,
    ddTrigger: targetSnap.stops.ddTrigger, maxPosChg: targetSnap.stops.maxPosChg,
    ...targetSnap.costModel,
  };
  if (isBaseline) {
    // 全样本锚点对账：回滚到基线 = 回到 v52 逐位口径
    check('引擎锚点（全样本 ↔ data/backtest.json::v52）', () => {
      const { perf } = poolBacktest(scores, retsByAsset, p);
      const ref = JSON.parse(readFileSync(path.join(ROOT, 'data', 'backtest.json'), 'utf8')).v52;
      const bad = [];
      if (Math.abs(perf.total - ref.total) > 6e-5) bad.push(`total ${(perf.total * 100).toFixed(2)}%≠${(ref.total * 100).toFixed(2)}%`);
      if (Math.abs(perf.maxDd - ref.maxDd) > 6e-5) bad.push(`maxDd ${(perf.maxDd * 100).toFixed(2)}%≠${(ref.maxDd * 100).toFixed(2)}%`);
      if (bad.length) throw new Error(bad.join('；'));
    });
  } else {
    // 非 baseline：OOS 引擎烟雾（指标必须有限数——缺失禁当真值）
    check('引擎烟雾（OOS 指标有限数）', () => {
      const n = days.length, oosStart = Math.floor(n * 0.8);
      const oosRets = Object.fromEntries(ASSETS.map((a) => [a, retsByAsset[a].slice(oosStart)]));
      const { perf } = poolBacktest(scores.slice(oosStart), oosRets, p);
      const rank = rankKey(perf);
      if (!rank.every(Number.isFinite)) throw new Error(`指标非有限数: ${JSON.stringify(rank)}`);
      console.log(`           OOS(${dates[oosStart]}~): 回撤 ${r4(perf.maxDd)} 夏普 ${(perf.sharpe || 0).toFixed(3)} 年化 ${r4(perf.annual)}`);
    });
  }
} catch (err) {
  verifications.push(['引擎验证（数据装载）', false, String(err?.message || err)]);
  console.error(`[rollback] 验证 ✗ 引擎验证（数据装载）：${err?.message || err}`);
}

// ── 5c 回写验证结论到 changelog entry（治理守卫要求最后一条 validation.pass === true，
//       与「未过门禁不许留 live 状态」同一纪律——回滚三重验证没过也必须红） ─────────
//       ⚠ 时序实测踩坑：回写必须在治理守卫**之前**——守卫校验的正是 changelog 最终态，
//         若守卫先跑，此刻 entry 的 pass 还是 null → 守卫必红 → 通知误报 error。
const failed0 = verifications.filter(([, ok]) => !ok);
const rbEntry = entries[entries.length - 1];
rbEntry.validation.pass = failed0.length === 0;
rbEntry.validation.checks = verifications.map(([name, ok]) => ({ name, ok }));
atomicWriteJSON(logPath, JSON.stringify(log, null, 2) + '\n');

// ── 5d 治理守卫最后跑（镜像逐位锁定 + changelog 台账一致性；失败则回写 pass=false，
//       保证 changelog 最终态如实反映「验证未过的 live 变更」→ 守卫持续红逼人工介入）──
{
  const name = '治理守卫（test/params_governance.test.mjs）';
  let ok = true, msg = null;
  try { execSync('node --test test/params_governance.test.mjs', { cwd: ROOT, stdio: 'pipe' }); }
  catch (err) { ok = false; msg = String(err?.message || err).split('\n')[0]; }
  verifications.push([name, ok, msg]);
  rbEntry.validation.checks = verifications.map(([n2, ok2]) => ({ name: n2, ok: ok2 }));
  if (ok) console.log(`[rollback] 验证 ✓ ${name}`);
  else {
    console.error(`[rollback] 验证 ✗ ${name}：${msg}`);
    rbEntry.validation.pass = false;
  }
  atomicWriteJSON(logPath, JSON.stringify(log, null, 2) + '\n');
}
const failed = verifications.filter(([, ok]) => !ok);

// ── 6. 通知：ops 告警事件流（Webhook 接通前 = 日志；接通后同源推送）──────────
const evDetail = failed.length
  ? `live 已回滚至 entry ${targetIdx}（${target.at}），但 ${failed.length} 项验证未过：${failed.map(([n, , m]) => `${n}(${m})`).join('；')} —— 立即人工介入，恢复通道：data/params_rollback_backup.json 或 rollback --to ${entries.length - 2}`
  : `live 已回滚至 entry ${targetIdx}（${target.at}，${(target.what || '').slice(0, 40)}），三重验证全绿；理由：${whyArg.trim()} · 差异块 ${changed.join('/')} · 备份 data/params_rollback_backup.json`;
// P2 告警通道内容规格：触发依据（why 原文）+ 变更面（差异块）+ 恢复通道 + at 时间戳
// ——事件自携带，alert_channel.mjs 只转发不拼装。
try {
  writeOpsAlerts([{
    at: new Date().toISOString(),
    severity: failed.length ? 'error' : 'warn',
    kind: failed.length ? 'params-rollback-verification-failed' : 'params-rollback',
    source: 'rollback_params.mjs',
    detail: evDetail,
  }], path.join(ROOT, 'data', 'ops-alerts-latest.json'));
  console.log(`[rollback] 通知已写入 data/ops-alerts-latest.json（severity=${failed.length ? 'error' : 'warn'}）`);
} catch (err) {
  console.error(`[rollback] ⚠ 通知落盘失败（不阻塞回滚本体）：${err?.message || err}`);
}

// ── 7. 终报 ────────────────────────────────────────────────────────────────
if (failed.length) {
  console.error('\n════════════════════════════════════════════════════════════');
  console.error('[rollback] ⚠ 回滚已执行但验证未全过 —— 当前 live 可能处于坏状态！');
  console.error(`          恢复：node scripts/rollback_params.mjs --to ${entries.length - 2} --why "恢复回滚前状态"`);
  console.error(`          备份：${path.relative(ROOT, backupPath)}`);
  console.error('════════════════════════════════════════════════════════════');
  process.exit(1);
}
console.log('\n[rollback] ✅ 回滚完成（三重验证全绿）：');
console.log(`          live = entry ${targetIdx} 快照（${target.at}）`);
console.log('          changelog 已留痕（liveBefore 在案，本操作可逆）');
console.log('          通知已入 ops 告警事件流');
console.log('          建议随即：node --test "test/*.test.mjs" 全量回归 + git commit 留存。');
process.exit(0);
