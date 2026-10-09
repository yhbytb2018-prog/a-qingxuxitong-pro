// P2 告警通道（2026-10-06 拍板）：data/ops-alerts-latest.json 的统一消费端。
//
// ── 定位 ─────────────────────────────────────────────────────────────────────
//   事件生产者（pipeline / rollback_params / rollback_track / 本脚本验收注入）都写
//   ops-alerts-latest.json（writeOpsAlerts 通道，cap=50 历史）；本脚本是**唯一推送端**——
//   只消费、不判定、不自造口径（与 opsalerts.js「不新增判定口径」同一纪律）。
//
// ── 分级动作（用户规格）──────────────────────────────────────────────────────
//   warn ：日志 + 终端高亮（黄底）——模拟盘阶段够用，不推送
//   error：日志 + 终端高亮（红底）+ Webhook 推送（企微机器人 text 消息，env OPS_WEBHOOK，
//          与 src/opsalerts.js::pushOpsAlerts 同一通道；钉钉/飞书只需换 payload 适配层）
//   info ：日志一行（不高亮不推送——数据质量告知，非告警）
//
// ── 防风暴（用户规格：同一 error 事件 5 分钟内不重复推送）────────────────────
//   事件指纹 = md5(kind + '|' + source + '|' + detail)。两层去重：
//   ① 游标去重：已见指纹不重发（watcher 重启也不重推——状态持久化
//      data/ops-alerts-push-state.json）；
//   ② 防风暴：同指纹**新事件**（at 更新）距上次推送 < 5 分钟 → 抑制推送、终端与日志
//      照常提示「已抑制」。窗口外 → 正常重推。
//   ⚠ detail 里含时间戳会让指纹次次不同、防风暴失效——生产者纪律：detail 只写业务
//   事实（触发编号/why/仓位/生效日），时间戳放事件顶层 at（回滚脚本已按此执行）。
//
// ── 推送内容（用户规格：触发条件编号 + --why 原文 + 回滚前后仓位快照 + 时间戳）──
//   内容 = 事件自携带（生产者写入 detail）+ 事件 at。回滚类事件的 detail 已含
//   触发编号（R1~R4 / T1~T4）、--why 原文、前后仓位快照（rollback_track.mjs
//   P2 起 enrichment）；本通道不二次拼装，杜绝「报告说 A、推的是 B」。
//
// ── 用法 ─────────────────────────────────────────────────────────────────────
//   node scripts/alert_channel.mjs                     # 单趟：处理当前事件文件后退出
//   node scripts/alert_channel.mjs --watch [秒]        # 常驻轮询（默认 3s ≤ 5s 验收 SLA）
//   node scripts/alert_channel.mjs --inject-test --why "…"   # 验收注入：写一条 error
//                                                      #   测试事件（含触发编号/why/仓位
//                                                      #   快照样例）并立即处理推送
//   未配置 OPS_WEBHOOK → error 级也只高亮+日志，提示「推送跳过（未配置）」——本地零打扰。
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import { atomicWriteJSON } from '../src/fsutil.js';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOpsAlerts } from '../src/opsalerts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALERTS_FILE = path.join(ROOT, 'data', 'ops-alerts-latest.json');
const STATE_FILE = path.join(ROOT, 'data', 'ops-alerts-push-state.json');
const LOG_FILE = path.join(ROOT, 'logs', 'alert_channel.log');
const WEBHOOK_ENV = 'OPS_WEBHOOK';
const STORM_MS = 5 * 60 * 1000;   // 防风暴窗口（用户规格：5 分钟）
const SEEN_TTL_MS = 30 * 86400 * 1000; // 指纹记忆时效（超龄清理）
const MSG_CAP = 2000;             // 企微 text 上限 ~2048 字节，留余量

const args = process.argv.slice(2);
const WATCH = args.includes('--watch');
const INJECT = args.includes('--inject-test');
const watchSec = (() => { const i = args.indexOf('--watch'); const v = i >= 0 ? args[i + 1] : null; const n = parseFloat(v); return Number.isFinite(n) && n >= 1 ? n : 3; })();
const whyArg = (() => { const i = args.indexOf('--why'); return i >= 0 ? args[i + 1] : null; })();

const ts = () => new Date().toISOString();
const fp = (ev) => createHash('md5').update(`${ev.kind}|${ev.source}|${ev.detail || ''}`).digest('hex').slice(0, 16);
const oneLine = (s) => String(s || '').replace(/\r?\n/g, ' ⏎ ');
const C = { err: '\x1b[41;37;1m', warn: '\x1b[43;30;1m', info: '\x1b[2m', off: '\x1b[0m' };

// ── 日志（append；*.log 被 gitignore——推送留痕在 state.history + ops 事件文件）──
function log(line) {
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `[${ts()}] ${line}\n`, 'utf8');
  } catch { /* 日志失败不阻塞通道 */ }
}

// ── P3 应急联系人（config/emergency_contacts.json · 契约 schemas/emergency-contacts.schema.json）──
// 读取容错：缺席/损坏/形态不对 → null（通道降级为不 @ 但照常推送——通道自身故障
// 不能阻塞告警源，与 pushWebhook 的 try/catch 同一纪律）。缺配置只记日志提示。
export function loadEmergencyContacts(root = ROOT) {
  try {
    const c = JSON.parse(readFileSync(path.join(root, 'config', 'emergency_contacts.json'), 'utf8'));
    if (c && c.primary && typeof c.primary.phone === 'string' && c.primary.phone.trim()) return c;
    console.warn('  ⚠ config/emergency_contacts.json 形态不对（primary.phone 缺失）——推送将不 @ 联系人');
  } catch { /* 缺席/损坏 → 降级不 @ */ }
  return null;
}

// 推送 payload 构造（纯函数，test/contract.test.mjs 负向演练）：
//   · contacts 在场 → text.mentioned_mobile_list = [primary.phone]（企微按手机号 @）
//     + 内容附值班链（primary + 30 分钟无响应升级 secondary）；
//   · contacts 缺席 → 无 mentioned 字段（不 @），内容照常——降级不静默：
//     processOnce 会提示补配置。
export function buildPushPayload(ev, contacts) {
  const lines = [
    `【A股情绪系统 PRO · 告警通道 ERROR】`,
    `[ERROR] ${ev.kind}（${ev.source}）`,
    oneLine(ev.detail),
    `at: ${ev.at || ts()}`,
    `—— P2 告警通道 · 防风暴 5 分钟 · 唯一消费源 data/ops-alerts-latest.json`,
  ];
  if (contacts && contacts.primary) {
    lines.push(`值班：${contacts.primary.name}（${contacts.primary.role}）`
      + (contacts.secondary ? ` · 30 分钟无响应 → 备份 ${contacts.secondary.name}（${contacts.secondary.role}）` : ''));
  }
  const content = lines.join('\n');
  const body = content.length > MSG_CAP ? content.slice(0, MSG_CAP) + '…' : content;
  const text = { content: body };
  if (contacts && contacts.primary && contacts.primary.phone) {
    text.mentioned_mobile_list = [contacts.primary.phone];
  }
  return { msgtype: 'text', text };
}

// ── 推送（企微 text；任何失败不抛出——通道自身故障不能阻塞告警源）─────────────
const CONTACTS = loadEmergencyContacts();

async function pushWebhook(ev) {
  const url = process.env[WEBHOOK_ENV];
  if (!url) return { skipped: true, reason: `${WEBHOOK_ENV} 未配置` };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPushPayload(ev, CONTACTS)),
    });
    if (!res.ok) return { error: `webhook HTTP ${res.status}` };
    return { pushed: true };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

// ── 状态（游标 + 防风暴记忆）──
function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { seen: {}, history: [] }; }
}
function saveState(st) {
  st.updatedAt = ts();
  st.history = (st.history || []).slice(-100); // 推送史 cap=100（审计用）
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  atomicWriteJSON(STATE_FILE, JSON.stringify(st, null, 2) + '\n');
}

// ── 单趟处理 ──
async function processOnce() {
  let events = [];
  try {
    const j = JSON.parse(readFileSync(ALERTS_FILE, 'utf8'));
    events = Array.isArray(j.events) ? j.events : [];
  } catch {
    return { processed: 0 }; // 无文件/损坏 → 静默（通道未启用前生产者可能不存在）
  }
  const state = readState();
  let pushed = 0, highlighted = 0, suppressed = 0;
  const now = Date.now();

  for (const ev of events) {
    const h = fp(ev);
    const prev = state.seen?.[h];
    const isNew = !prev || (ev.at && ev.at > prev.at); // 同指纹但 at 更新 = 新发生
    if (!isNew) continue;

    const sev = ev.severity || 'info';
    const tag = `[${sev.toUpperCase()}] ${ev.kind}（${ev.source}）`;
    const summary = `${tag} ${oneLine(ev.detail)}`;

    if (sev === 'error' || sev === 'warn') {
      const color = sev === 'error' ? C.err : C.warn;
      console.log(`${color} ${summary} ${C.off}`);
      highlighted++;
      log(`${sev.toUpperCase()} ${summary}`);
    } else {
      log(`INFO ${summary}`);
    }

    let storm = false;
    let pushOk = false;
    if (sev === 'error') {
      if (prev?.lastPushAt && now - prev.lastPushAt < STORM_MS) {
        storm = true;
        suppressed++;
        console.log(`  ↳ 防风暴：同指纹 ${Math.round((now - prev.lastPushAt) / 1000)}s 前已推送，5 分钟窗口内抑制（本条仅高亮+日志）`);
        log(`STORM-SUPPRESSED ${tag}`);
      } else {
        const r = await pushWebhook(ev);
        if (r.pushed) {
          pushOk = true;
          pushed++;
          state.history.push({ at: ts(), kind: ev.kind, source: ev.source, fp: h });
          console.log('  ↳ 已推送 Webhook');
        } else if (r.skipped) {
          console.log(`  ↳ 推送跳过：${WEBHOOK_ENV} 未配置（error 级仅高亮+日志）`);
        } else {
          console.error(`  ↳ 推送失败：${r.error}（不阻塞通道；同指纹不自动重试，人工重推用 --inject-test 复刻）`);
          log(`PUSH-FAILED ${tag} ${r.error}`);
        }
      }
    }
    state.seen[h] = {
      at: ev.at || ts(),
      firstSeenAt: prev?.firstSeenAt || ts(),
      lastPushAt: storm ? prev.lastPushAt : (pushOk ? now : null),
    };
  }

  // 超龄指纹清理（防 state 无限膨胀）
  if (state.seen) {
    for (const [h, v] of Object.entries(state.seen)) {
      if (v.lastPushAt && now - v.lastPushAt > SEEN_TTL_MS && (!v.at || now - Date.parse(v.at) > SEEN_TTL_MS)) delete state.seen[h];
    }
  }
  if (pushed || highlighted || suppressed) saveState(state);
  return { processed: highlighted + suppressed, pushed, suppressed };
}

// ── 验收注入（用户规格验收标准：手动注入 error → 5 秒内 Webhook → 内容完整）──
function injectTest() {
  const why = (whyArg || 'P2 告警通道验收注入（默认 why）').trim();
  const detail = [
    `验收注入：触发条件 T1（轨道 A 单日亏损 > 5%，模拟值 -5.2%）`,
    `--why 原文：${why}`,
    `仓位快照 前{"上证指数":0.7,"深证成指":0.4,"创业板指":0.4} 后{"上证指数":0.3,"深证成指":0.2,"创业板指":0.2}`,
    `时间戳见事件 at 字段（ISO）；本事件用于验收：5 秒内送达 + 内容完整（触发编号/why/仓位/at 四要素）`,
  ].join(' · ');
  writeOpsAlerts([{ at: ts(), severity: 'error', kind: 'test-acceptance', source: 'alert_channel.mjs', detail }],
    ALERTS_FILE);
  console.log('[alert] 验收 error 事件已注入 data/ops-alerts-latest.json（kind=test-acceptance）');
}

// ── 主流程（isMain 守卫：被 import 时不跑主流程不 exit——buildPushPayload 供
//   test/contract.test.mjs 做负向演练，模块级 process.exit 会杀掉测试进程）──
const isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href; }
  catch { return false; }
})();

if (isMain) {
  if (INJECT) injectTest();

  if (!WATCH) {
    const r = await processOnce();
    if (!INJECT && !r.processed && !r.pushed) console.log('[alert] 无新事件（单趟完成）');
    if (!CONTACTS) console.log('[alert] ⚠ config/emergency_contacts.json 缺席/损坏——error 推送将不 @ 联系人（P3 已确认，补档后重跑）');
    process.exit(0);
  }

  console.log(`[alert] 常驻轮询启动：${watchSec}s 间隔 · 消费 ${path.relative(ROOT, ALERTS_FILE)} · 防风暴 ${STORM_MS / 60000} 分钟 · 推送 ${WEBHOOK_ENV || 'OPS_WEBHOOK'}${process.env[WEBHOOK_ENV] ? '' : '（未配置 → error 级不推送）'} · 值班 ${CONTACTS ? CONTACTS.primary.name : '（缺联系人配置 → 不 @）'}`);
  let lastMtime = 0;
  try { lastMtime = statSync(ALERTS_FILE).mtimeMs; } catch { /* 尚无文件 */ }
  while (true) {
    await new Promise((r) => setTimeout(r, watchSec * 1000));
    let m = lastMtime;
    try { m = statSync(ALERTS_FILE).mtimeMs; } catch { /* 文件消失等下轮 */ }
    if (m !== lastMtime) { lastMtime = m; await processOnce(); }
  }
}
