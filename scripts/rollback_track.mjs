// 轨道回滚门禁（P1 · 2026-10-06 拍板）：轨道 A → A_fallback 的唯一合法切换通道。
//
// ── 语义（与 rollback_params.mjs 的分工）────────────────────────────────────
//   · rollback_params.mjs = **参数级**回滚（config.json params.live → changelog 快照）
//   · 本脚本 = **轨道级**回滚（执行面轨道 A → A_fallback 冻结快照，不动 config.json）
//   A_fallback = V5.2 基线配置快照，冻结在 bd77fed 提交（"指数收益回填（P0）"）——
//   之后的任何参数晋升/漂移都被快照隔离。两套互补：参数回滚改全局口径；轨道回滚
//   只切执行面，全局配置保持不动。
//
// ── 触发条件（任一满足即执行；唯一出处，与头注释一致）──────────────────────
//   T1 轨道 A 单日亏损 > 5%（dayReturns.A < -0.05）
//   T2 轨道 A 连续 3 日累计亏损 > 8%（末日 3 日窗和 < -0.08）
//   T3 轨道 A 最大回撤触及 15%（ddTrigger 已压仓但仍恶化：当前回撤 ≥ 0.15）
//   T4 人工一键（应急联系人手动执行：--trigger manual + --why 证据）
//   --trigger auto = 评估 T1~T3 取命中；全不中 → 拒绝（提示改用 manual + 理由）。
//   口径声明：P2_START=null（模拟盘未启动）期间，评估基于全样本重放末值
//   （archive 最新交易日，2026-09-30）而非实时资金曲线；实盘接线后 = 每日数据更新
//   → paper_dual_track.mjs 重放 → 本评估自动以最新交易日为末值，无需改代码。
//
// ── 回滚动作（用户规格逐条落地）────────────────────────────────────────────
//   ① active_track: A → A_fallback
//      唯一事实源 = data/paper/track_state.json（pipeline 不触碰，paper_dual_track
//      每次运行读取）。⚠ 不能只写 signals-latest.json——它是抓取管道每轮重写的产物，
//      字段会被冲掉 = 假回滚。故 signals-latest.json 的 active_track 是**展示镜像**：
//      本脚本写入 + paper_dual_track 在 fallback 态每日自愈（见该工具尾部）；
//      schema 契约允许额外字段（additionalProperties 未设，check_contract 实测绿），
//      正式字段化走 P2-β schema 契约流程。
//   ② A_fallback 参数 = data/paper/track_fallback_params.json（bd77fed 冻结五块，
//      首次运行自动提取；每次运行与 git 对账——被手改 → 用 git 版本覆写并警告）
//   ③ 次日开盘前生效（effectiveDate = 最新交易日的次一交易日，calendar 判定；
//      找不到 → null + [待确认] 标注，人工启动前确认）。当日持仓不动（T+1 约束）：
//      重放口径为全史统一参数（幂等重放不变），当前 train ≡ 快照 → 切换零差异，
//      仓位天然无跳变；未来"晋升后又回滚"场景下切换日前的历史按快照口径重放
//      （非当时真实路径）——如实披露。分段重放已裁决 No-Go（2026-10-06）：
//      推迟到 P2-β 之后的迭代再议。
//   ④ 回滚后验证 = 跑 paper_dual_track.mjs：fallback 模式下门禁①（轨道A ↔ v52
//      锚点 -1.50%/13.79%）同时是**快照完整性守卫**——快照损坏即门禁红即拒写盘。
//
// ── 回滚后通知（告警通道未接通前 = 日志文件 + 终端双保险）──────────────────
//   · logs/rollback_{timestamp}.json：触发原因 / 回滚前仓位 / 回滚后目标仓位 /
//     验证结果 / 恢复通道（git 不忽略 *.json，留痕入库）
//   · data/ops-alerts-latest.json：params-track-rollback 事件（复用 writeOpsAlerts
//     通道，Webhook 接通后同源推送零改造）
//   · signals-latest.json 镜像字段（active_track / activeTrackNote）
//
// ── 恢复条件（用户规格）────────────────────────────────────────────────────
//   回滚后连续 5 个交易日无异常亏损（单日 >5% / 3日累计 >8% 均未触发，且回撤未创
//   fallback 期新高）→ 只读模式显示 RESTORE-READY；人工审核后 --restore 手动切回。
//   未 READY 需人工强行恢复 → --restore --force（裁决权在人，但留痕）。
//
// ── 用法 ────────────────────────────────────────────────────────────────────
//   node scripts/rollback_track.mjs                                  # 只读：状态+触发评估+恢复就绪
//   node scripts/rollback_track.mjs --apply --trigger auto  --why "…"
//   node scripts/rollback_track.mjs --apply --trigger manual --why "…"
//   node scripts/rollback_track.mjs --restore --why "…"[ --force]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { atomicWriteJSON } from '../src/fsutil.js';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTradingDay } from '../src/calendar.js';
import { writeOpsAlerts } from '../src/opsalerts.js';
import { buildTrackNote } from '../src/dual_track.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAPER = path.join(ROOT, 'data', 'paper');
const STATE_FILE = path.join(PAPER, 'track_state.json');
const SNAP_FILE = path.join(PAPER, 'track_fallback_params.json');
const DT_FILE = path.join(PAPER, 'dual_track.json');
const DTL_FILE = path.join(PAPER, 'dual_track_latest.json');
const SIG_FILE = path.join(ROOT, 'data', 'signals-latest.json');
const LOGS = path.join(ROOT, 'logs');
const FREEZE_COMMIT = 'bd77fed';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const RESTORE = args.includes('--restore');
const FORCE = args.includes('--force');
const whyArg = (() => { const i = args.indexOf('--why'); return i >= 0 ? args[i + 1] : null; })();
const triggerArg = (() => { const i = args.indexOf('--trigger'); return i >= 0 ? args[i + 1] : null; })();
const whoArg = (() => { const i = args.indexOf('--who'); return i >= 0 ? args[i + 1] : null; })();
let who = whoArg;
if (!who) { try { who = execSync('git config user.name').toString().trim() || 'unspecified'; } catch { who = 'unspecified'; } }

const T1_D = -0.05, T2_D = -0.08, T2_W = 3, T3_D = 0.15, RESTORE_DAYS = 5;
const ts = () => new Date().toISOString();
const stamp = () => ts().replace(/[:.]/g, '-').slice(0, 19);
const pct = (x) => (x * 100).toFixed(2) + '%';

// ── 状态读写 ──
function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function writeState(st) {
  st.updatedAt = ts();
  mkdirSync(PAPER, { recursive: true });
  atomicWriteJSON(STATE_FILE, JSON.stringify(st, null, 2) + '\n');
}
const state = readState();
const activeTrack = state?.activeTrack === 'A_fallback' ? 'A_fallback' : 'A';

// ── A_fallback 冻结快照（ensure + git 对账）──
function ensureSnapshot() {
  const raw = execSync(`git show ${FREEZE_COMMIT}:config.json`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const cfgB = JSON.parse(raw);
  // bd77fed 期 train ≡ live（基线冻结双对齐，2026-10-06 实测五块逐位一致）
  const params = cfgB.params.train;
  if (!params || !params.weights) throw new Error(`${FREEZE_COMMIT} 快照缺 params.train`);
  let snap = null;
  try { snap = JSON.parse(readFileSync(SNAP_FILE, 'utf8')); } catch { /* 首次提取 */ }
  const canonical = JSON.stringify(params);
  if (snap && JSON.stringify(snap.params) !== canonical) {
    console.warn(`[track] ⚠ 快照文件与 git ${FREEZE_COMMIT} 不一致（被手改？）——已用 git 版本覆写。`);
    snap = null;
  }
  if (!snap) {
    snap = { commit: FREEZE_COMMIT, extractedAt: ts(), params };
    atomicWriteJSON(SNAP_FILE, JSON.stringify(snap, null, 2) + '\n');
    console.log(`[track] A_fallback 快照已提取冻结 → ${path.relative(ROOT, SNAP_FILE)}（@${FREEZE_COMMIT}）`);
  }
  return snap;
}

// ── 双轨账本读取 + 触发评估 ──
function readLedger() {
  const dt = JSON.parse(readFileSync(DT_FILE, 'utf8'));
  const days = dt.days || [];
  if (days.length < 3) throw new Error('dual_track.json 样本不足（<3 日）——先跑 paper_dual_track.mjs');
  return { dt, dates: days.map((d) => d.date), rets: days.map((d) => d.dayReturns.A) };
}
function drawdownNow(rets) {
  let nav = 1, peak = 1;
  for (const r of rets) { nav *= 1 + r; peak = Math.max(peak, nav); }
  return { dd: 1 - nav / peak, nav };
}
function evaluateTriggers({ dates, rets }) {
  const n = rets.length;
  const last = rets[n - 1];
  const w3 = rets.slice(n - T2_W).reduce((a, b) => a + b, 0);
  const { dd } = drawdownNow(rets);
  const t1 = { hit: last < T1_D, value: last, date: dates[n - 1] };
  const t2 = { hit: w3 < T2_D, value: w3, window: `${dates[n - T2_W]}~${dates[n - 1]}` };
  const t3 = { hit: dd >= T3_D, value: dd };
  const hits = [t1.hit && 'T1', t2.hit && 'T2', t3.hit && 'T3'].filter(Boolean);
  return { t1, t2, t3, hits, lastDate: dates[n - 1] };
}
function printTriggers(ev, p2Started) {
  console.log(`\n── 触发条件评估（末日 ${ev.lastDate}）${p2Started ? '' : ' ⚠ P2 未启动：全样本重放末值，非实时资金曲线'} ──`);
  console.log(`  T1 单日亏损>5%   : ${pct(ev.t1.value)}  ${ev.t1.hit ? '→ 触发' : ''}`);
  console.log(`  T2 3日累计>8%    : ${pct(ev.t2.value)}（${ev.t2.window}）  ${ev.t2.hit ? '→ 触发' : ''}`);
  console.log(`  T3 回撤触及15%   : ${pct(ev.t3.value)}  ${ev.t3.hit ? '→ 触发' : ''}`);
  console.log(`  T4 人工一键      : --trigger manual`);
}

// ── 恢复就绪评估（fallback 态专用）──
function restoreReadiness({ dates, rets }, effectiveDate) {
  const i0 = dates.findIndex((d) => d >= effectiveDate);
  if (i0 < 0) return { ready: false, reason: `生效日 ${effectiveDate} 之后尚无账目（等首个 fallback 交易日）`, days: 0 };
  const seg = rets.slice(i0);
  const days = seg.length;
  const ddSeg = drawdownNow(seg);
  const bad = [];
  for (let i = 0; i < seg.length; i++) if (seg[i] < T1_D) bad.push(`${dates[i0 + i]} 单日 ${pct(seg[i])}`);
  for (let i = T2_W - 1; i < seg.length; i++) {
    const w = seg.slice(i - T2_W + 1, i + 1).reduce((a, b) => a + b, 0);
    if (w < T2_D) bad.push(`${dates[i0 + i - T2_W + 1]}~${dates[i0 + i]} 3日 ${pct(w)}`);
  }
  if (bad.length) return { ready: false, reason: `异常亏损未清零：${bad.slice(0, 3).join('；')}${bad.length > 3 ? ' …' : ''}`, days };
  if (days < RESTORE_DAYS) return { ready: false, reason: `fallback 期仅 ${days} 个交易日（需连续 ${RESTORE_DAYS} 日无异常）`, days };
  return { ready: true, reason: `连续 ${days} 个交易日无异常亏损（T1/T2 零触发，fallback 期回撤 ${pct(ddSeg.dd)}）`, days };
}

// ── 镜像写入 / 移除 ──
function writeMirror(snap, fallback) {
  const sig = JSON.parse(readFileSync(SIG_FILE, 'utf8'));
  sig.active_track = 'A_fallback';
  // 文案唯一出处 src/dual_track.js::buildTrackNote（E2E 终测抓出「模板六要素、
  // 调用只传两参 → since/why 落 [未记录]」的传参缺口后收口）
  sig.activeTrackNote = buildTrackNote(fallback, snap.commit);
  atomicWriteJSON(SIG_FILE, JSON.stringify(sig, null, 2) + '\n');
}
function clearMirror() {
  if (!existsSync(SIG_FILE)) return;
  const sig = JSON.parse(readFileSync(SIG_FILE, 'utf8'));
  if (!('active_track' in sig) && !('activeTrackNote' in sig)) return;
  delete sig.active_track;
  delete sig.activeTrackNote;
  atomicWriteJSON(SIG_FILE, JSON.stringify(sig, null, 2) + '\n');
}

// ── 次一交易日（calendar 判定；找不到 → null + 人工确认）──
function nextTradingDay(afterDate) {
  const base = new Date(`${afterDate}T00:00:00Z`).getTime();
  for (let i = 1; i <= 15; i++) {
    const iso = new Date(base + i * 86400000).toISOString().slice(0, 10);
    let ok = false;
    try { ok = isTradingDay(iso); } catch { ok = false; }
    if (ok) return iso;
  }
  return null;
}

// ── 只读模式 ──
if (!APPLY && !RESTORE) {
  const snap = activeTrack === 'A_fallback' ? ensureSnapshot() : null;
  console.log('═══ 轨道状态（data/paper/track_state.json） ═══');
  console.log(`  activeTrack : ${activeTrack}${activeTrack === 'A' ? '（常态；或状态文件不存在）' : ''}`);
  if (snap) {
    const fb = state.fallback;
    console.log(`  冻结快照    : @${snap.commit}（提取于 ${snap.extractedAt}）`);
    console.log(`  生效日      : ${fb.effectiveDate || '[待确认：calendar 未覆盖，启动前人工确认]'}`);
    console.log(`  触发        : ${fb.trigger}（${fb.triggerDetail || ''}）`);
    console.log(`  回滚理由    : ${fb.why}`);
    console.log(`  回滚日志    : ${fb.log}`);
    console.log(`  恢复就绪    : ${(() => {
      const L = readLedger();
      const rr = restoreReadiness(L, fb.effectiveDate || L.dates[L.dates.length - 1]);
      return (rr.ready ? 'READY' : 'NOT-READY') + `——${rr.reason}`;
    })()}`);
  }
  try {
    const L = readLedger();
    printTriggers(evaluateTriggers(L), !!L.dt.p2Start);
  } catch (err) { console.error(`[track] ⚠ 无法评估触发条件：${err.message}`); }
  console.log('\n执行回滚：node scripts/rollback_track.mjs --apply --trigger auto|manual|T1|T2|T3 --why "…"');
  console.log('人工恢复：node scripts/rollback_track.mjs --restore --why "…"（READY 后；强行加 --force）');
  process.exit(0);
}

// ── --apply：回滚 A → A_fallback ──
if (APPLY) {
  if (RESTORE) { console.error('[track] --apply 与 --restore 互斥。'); process.exit(1); }
  if (activeTrack === 'A_fallback') {
    console.error('[track] 已处于 A_fallback 态——拒绝重复回滚（防状态污染；恢复走 --restore）。');
    process.exit(1);
  }
  if (!whyArg || !whyArg.trim()) { console.error('[track] --why 必填（触发证据 + 理由，留痕纪律）。'); process.exit(1); }
  const snap = ensureSnapshot();
  const L = readLedger();
  const ev = evaluateTriggers(L);
  printTriggers(ev, !!L.dt.p2Start);

  let trigger = null, triggerDetail = null;
  if (triggerArg === 'manual' || triggerArg === 'T4') { trigger = 'T4'; triggerDetail = '人工一键（应急联系人手动执行）'; }
  else if (triggerArg === 'auto') {
    if (!ev.hits.length) {
      console.error(`[track] --trigger auto：T1~T3 全未命中（末日 ${ev.lastDate}）——拒绝回滚。\n           若确需人工介入：--trigger manual --why "<证据>"。`);
      process.exit(1);
    }
    trigger = ev.hits[0];
    triggerDetail = { T1: `单日 ${pct(ev.t1.value)}`, T2: `3日累计 ${pct(ev.t2.value)}`, T3: `当前回撤 ${pct(ev.t3.value)}` }[trigger];
  } else if (['T1', 'T2', 'T3'].includes(triggerArg)) {
    const m = { T1: ev.t1, T2: ev.t2, T3: ev.t3 }[triggerArg];
    if (!m.hit) console.warn(`[track] ⚠ 显式 ${triggerArg} 但当前评估未命中（${pct(m.value)}）——按人工指定执行，留痕。`);
    trigger = triggerArg;
    triggerDetail = `人工指定 ${triggerArg}（当前值 ${pct(m.value)}）`;
  } else {
    console.error('[track] --trigger 必须是 auto | manual | T1 | T2 | T3。'); process.exit(1);
  }

  // 回滚前仓位快照（当日持仓不动 = 留证）
  const before = JSON.parse(readFileSync(DTL_FILE, 'utf8')).day;
  const effectiveDate = nextTradingDay(ev.lastDate);
  const logFile = `logs/rollback_${stamp()}.json`;

  // 写状态（执行面切换本体）
  writeState({
    activeTrack: 'A_fallback',
    fallback: {
      since: ts(),
      effectiveDate,
      effectiveNote: effectiveDate ? `次一交易日（calendar 判定，基于存档末日 ${ev.lastDate}）` : '[待确认] calendar 未覆盖存档末日之后的日期——模拟盘启动前人工确认',
      trigger, triggerDetail, why: whyArg.trim(), who,
      snapshotCommit: snap.commit,
      log: logFile,
    },
    history: [...(state?.history || []), { at: ts(), event: 'rollback', trigger, why: whyArg.trim(), who, effectiveDate, log: logFile }],
  });
  console.log(`\n[track] ✅ 执行面已切换：A → A_fallback（生效日 ${effectiveDate || '[待确认]'}，当日持仓不动——T+1 约束）`);

  // 验证：跑 paper_dual_track（fallback 模式；门禁① = 快照完整性守卫）
  console.log('[track] 验证：重放双轨账本（fallback 参数面 + 三重门禁）…');
  try {
    execSync('node tools/backtest/paper_dual_track.mjs', { cwd: ROOT, stdio: 'pipe' });
    console.log('[track] 验证 ✓ 双轨账本 fallback 模式门禁全绿（轨道A ↔ v52 锚点 = 快照完整性）');
  } catch (err) {
    console.error(`[track] 验证 ✗ 双轨重放失败：${String(err.message).split('\n')[0]}\n           ⚠ 快照或账本异常——立即人工介入（state 已切，可 --restore 回退）。`);
    writeOpsAlerts([{
      at: ts(), severity: 'error', kind: 'track-rollback-verification-failed', source: 'rollback_track.mjs',
      detail: `A_fallback 切换后双轨重放门禁失败——人工介入（恢复：--restore --force --why "验证失败回退"）`,
    }], path.join(ROOT, 'data', 'ops-alerts-latest.json'));
    process.exit(1);
  }

  // 回滚后目标仓位 + 差异声明
  const after = JSON.parse(readFileSync(DTL_FILE, 'utf8')).day;
  const zeroDiff = JSON.stringify(before.trackA.targetPos) === JSON.stringify(after.trackA.targetPos);

  // 回滚日志（规格第 3 条：触发原因 / 回滚前仓位 / 回滚后目标仓位）
  mkdirSync(LOGS, { recursive: true });
  atomicWriteJSON(path.join(ROOT, logFile), JSON.stringify({
    at: ts(), event: 'rollback', who,
    trigger: { key: trigger, detail: triggerDetail, evaluatedAt: ev.lastDate, t1: ev.t1.value, t2: ev.t2.value, t3: ev.t3.value },
    why: whyArg.trim(),
    action: {
      from: 'A', to: 'A_fallback',
      fallbackSnapshot: { commit: snap.commit, file: path.relative(ROOT, SNAP_FILE) },
      effectiveDate, tPlus1: '当日持仓不动，次日开盘前生效',
      stateFile: path.relative(ROOT, STATE_FILE),
    },
    positionsBefore: { date: before.date, targetPos: before.trackA.targetPos, poolPos: before.trackA.poolPos },
    positionsAfterFallback: { date: after.date, targetPos: after.trackA.targetPos, poolPos: after.trackA.poolPos },
    diffNote: zeroDiff
      ? '零差异：当前 params.train ≡ bd77fed 冻结快照（基线未晋升）——回滚是机制性预置，仓位与收益路径不变'
      : '有差异：params.train 已与快照分叉（晋升后回滚场景）——切换日前历史按快照口径重放（非当时真实路径；分段重放已裁决 No-Go，推迟到 P2-β 之后迭代）',
    verification: 'paper_dual_track.mjs fallback 模式三重门禁全绿（门禁① = 快照完整性守卫）',
    restore: { condition: `连续 ${RESTORE_DAYS} 个交易日无异常亏损后，人工审核 --restore 切回`, command: 'node scripts/rollback_track.mjs --restore --why "…"' },
  }, null, 2) + '\n', 'utf8');

  // 镜像 + ops 通知（双保险：日志文件 + 终端输出 + ops 事件流）
  try {
    writeMirror(snap, { since: ts(), effectiveDate, trigger, why: whyArg.trim() });
    console.log('[track] 镜像已写 signals-latest.json（active_track = A_fallback；抓取重写后由 paper_dual_track 自愈）');
  } catch (err) { console.error(`[track] ⚠ 镜像写入失败（不阻塞回滚本体）：${err.message}`); }
  try {
    writeOpsAlerts([{
      at: ts(), severity: 'warn', kind: 'params-track-rollback', source: 'rollback_track.mjs',
      // P2 告警通道内容规格（2026-10-06）：触发编号 + --why 原文 + 前后仓位快照 + at 时间戳
      // ——事件自携带，alert_channel.mjs 只转发不拼装。detail 不含时间戳（防指纹失效）。
      detail: `轨道 A → A_fallback（V5.2 冻结快照 @${snap.commit}）· 触发 ${trigger}（${triggerDetail}）· 生效 ${effectiveDate || '[待确认]'} · 理由：${whyArg.trim()} · 仓位 前${JSON.stringify(before.trackA.targetPos)} 后${JSON.stringify(after.trackA.targetPos)} · 日志 ${logFile}`,
    }], path.join(ROOT, 'data', 'ops-alerts-latest.json'));
    console.log('[track] ops 告警事件已写入 data/ops-alerts-latest.json（severity=warn）');
  } catch (err) { console.error(`[track] ⚠ ops 通知失败（不阻塞回滚本体）：${err.message}`); }

  console.log(`\n[track] ✅ 回滚完成：日志 ${logFile}（触发原因/前仓位/后仓位全留痕）`);
  console.log('           恢复通道：--restore（READY 后）| 参数级回滚另见 scripts/rollback_params.mjs');
  process.exit(0);
}

// ── --restore：人工切回 A_fallback → A ──
if (RESTORE) {
  if (activeTrack !== 'A_fallback') { console.error('[track] 当前非 A_fallback 态，无可恢复。'); process.exit(1); }
  if (!whyArg || !whyArg.trim()) { console.error('[track] --why 必填（恢复审核理由，留痕纪律）。'); process.exit(1); }
  const L = readLedger();
  const eff = state.fallback.effectiveDate || L.dates[L.dates.length - 1];
  const rr = restoreReadiness(L, eff);
  console.log(`── 恢复就绪评估（生效日 ${eff} 起）──`);
  console.log(`  ${rr.ready ? 'READY' : 'NOT-READY'}：${rr.reason}`);
  if (!rr.ready && !FORCE) {
    console.error('[track] 恢复就绪条件未满足——拒绝恢复（人工强行：--restore --force --why "…"）。');
    process.exit(1);
  }
  if (!rr.ready && FORCE) console.warn('[track] ⚠ --force 强行恢复（就绪条件未满足，裁决留痕）。');

  const logFile = `logs/restore_${stamp()}.json`;
  const before = JSON.parse(readFileSync(DTL_FILE, 'utf8')).day;
  writeState({
    activeTrack: 'A',
    fallback: null,
    history: [...(state.history || []), { at: ts(), event: 'restore', why: whyArg.trim(), who, readiness: rr, forced: !rr.ready && FORCE, log: logFile }],
  });
  console.log('\n[track] ✅ 执行面已切换：A_fallback → A（恢复当前 params.train 参数面）');

  console.log('[track] 验证：重放双轨账本（A 态参数面 + 三重门禁）…');
  try {
    execSync('node tools/backtest/paper_dual_track.mjs', { cwd: ROOT, stdio: 'pipe' });
    console.log('[track] 验证 ✓ 双轨账本 A 态门禁全绿');
  } catch (err) {
    console.error(`[track] 验证 ✗ 双轨重放失败：${String(err.message).split('\n')[0]}`);
    process.exit(1);
  }

  mkdirSync(LOGS, { recursive: true });
  atomicWriteJSON(path.join(ROOT, logFile), JSON.stringify({
    at: ts(), event: 'restore', who, why: whyArg.trim(),
    readiness: rr, forced: !rr.ready && FORCE,
    action: { from: 'A_fallback', to: 'A', stateFile: path.relative(ROOT, STATE_FILE) },
    positionsBefore: { date: before.date, targetPos: before.trackA.targetPos, poolPos: before.trackA.poolPos },
    verification: 'paper_dual_track.mjs A 态三重门禁全绿',
  }, null, 2) + '\n', 'utf8');
  try { clearMirror(); console.log('[track] 镜像已清除（signals-latest.json 恢复常态）'); } catch (err) { console.error(`[track] ⚠ 镜像清除失败：${err.message}`); }
  try {
    writeOpsAlerts([{
      at: ts(), severity: 'info', kind: 'params-track-restore', source: 'rollback_track.mjs',
      detail: `轨道 A_fallback → A（人工审核恢复${FORCE ? '，--force 强行（就绪未满足）' : ''}）· 理由：${whyArg.trim()} · 日志 ${logFile}`,
    }], path.join(ROOT, 'data', 'ops-alerts-latest.json'));
  } catch (err) { console.error(`[track] ⚠ ops 通知失败：${err.message}`); }
  console.log(`\n[track] ✅ 恢复完成：日志 ${logFile}`);
  process.exit(0);
}
