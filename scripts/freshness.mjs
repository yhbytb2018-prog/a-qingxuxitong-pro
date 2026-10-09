// 数据新鲜度 CLI（离线，不联网）——用来回答「数据到底滞没滞后」，而不是只看 meta.stale 这个旧标记。
//
//   node scripts/freshness.mjs                 查看判定（只读，不改文件）
//   node scripts/freshness.mjs --write         把判定字段写回存档（只动 meta，绝不碰数据）
//   node scripts/freshness.mjs --require-fresh 判定为 behind（真滞后）时以退出码 1 结束，供 CI 当门禁
//   node scripts/freshness.mjs --archive <p>   指定存档路径（默认 data/archive.json）
//
// 为什么需要它：管道在「跳过 / 非交易日」路径上不产生新数据，旧口径只在那时保留 meta 不动，
// 于是 stale 会粘着不动（页面长期误报）。这个脚本可按同一套日历口径重算并刷新。
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../src/config.js';
import { resolveHolidays, calendarLine } from '../src/calendar.js';
import { decodeArchive, writeArchiveSafely } from '../src/lhb_codec.js';
import { assessFreshness, applyFreshnessMeta, applyPhaseMeta, marketPhase, PHASE_NOTE,
  freshnessKey, bjDate, bjTime, staleReasonText } from '../src/freshness.js';
import { moduleTradeDate, MODULE_PROBES, assessModulesFreshness, modulesBehind } from '../src/module_freshness.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const REQUIRE_FRESH = argv.includes('--require-fresh');
const ai = argv.indexOf('--archive');
const P = resolve(ai >= 0 ? argv[ai + 1] : join(ROOT, 'data', 'archive.json'));

const nowArg = argv.indexOf('--at'); // 测试用：按指定时刻评估
const now = nowArg >= 0 ? new Date(argv[nowArg + 1]) : new Date();

if (!existsSync(P)) {
  console.error('[freshness] 未找到存档:', P);
  process.exit(2);
}
const a = decodeArchive(JSON.parse(readFileSync(P, 'utf8')));
const meta = a.meta || {};
const tradeDate = meta.tradeDate
  || a.signals?.tradeDate
  || (a.all_days || []).slice(-1)[0]?.trade_date
  || null;

const f = assessFreshness({ tradeDate }, now, resolveHolidays());
const ph = marketPhase(now, resolveHolidays());
const STATE_TEXT = {
  fresh: '数据为最新已收盘会话',
  pending: '落后 1 个交易日，但预期更新时刻未到（正常等待 18:30 首抓 / 21:00 补抓）',
  behind: '已过预期更新时刻仍然落后（真滞后，需处置）',
  unknown: '存档无交易日信息',
};
const PHASE_TEXT = {
  pre: '开盘前（今日行情尚未产生）',
  live: '盘中（行情实时可得，但情绪分/分位/因子仍为上一收盘日口径）',
  closed: '收盘后 / 非交易日（当日已定盘）',
};

console.log('[freshness] 存档', P);
console.log('  评估时刻（北京）  ', bjDate(now), bjTime(now));
console.log('  市场相位 phase    ', ph.phase, '→', PHASE_TEXT[ph.phase] || '', ph.isTradingDay ? '(交易日)' : '(非交易日)');
console.log('  相位口径说明      ', PHASE_NOTE[ph.phase] || '');
console.log('  存档交易日        ', tradeDate ?? '(无)');
console.log('  最近已收盘交易日  ', f.latestClosed ?? '(无)');
console.log('  落后交易日数      ', f.behindSessions);
console.log('  预期更新时刻      ', f.publishDeadline
  ? `${f.publishDeadline}（北京 ${bjDate(new Date(f.publishDeadline))} ${bjTime(new Date(f.publishDeadline))}）`
  : '(无)');
console.log('  判定              ', f.state, '→', STATE_TEXT[f.state] || '');
console.log('  旧字段 meta.stale ', meta.stale === true ? 'true（在旧口径下写入，可能已过时）' : String(meta.stale));
if (meta.fallbackReason) console.log('  上次回退原因      ', meta.fallbackReason);
if (meta.lastAttempt) console.log('  最近一次尝试      ', `${meta.lastAttempt.outcome} @ ${meta.lastAttempt.at}${meta.lastAttempt.reason ? ' | ' + meta.lastAttempt.reason : ''}`);
if (meta.note) console.log('  数据说明(note)    ', meta.note);
console.log('  判定依据          ', `日历 ${calendarLine(resolveHolidays())}；收盘 15:00；预期更新 19:30`);

if (WRITE) {
  const before = freshnessKey(meta);
  const nf = applyFreshnessMeta(meta, tradeDate, now, resolveHolidays(), {
    outcome: 'freshness-cli',
    reason: 'scripts/freshness.mjs --write 重算判定',
  });
  applyPhaseMeta(meta, now, resolveHolidays());
  if (freshnessKey(meta) === before) {
    console.log('[freshness] 判定字段无实质变化，未写入');
  } else {
    // 必须重编码写回（直接 stringify 会把压缩档解压成 9.2MB 且丢掉 rc 的可读性）
    writeArchiveSafely(P, a, { writeFileSync, renameSync, unlinkSync });
    console.log('[freshness] 已写回判定字段 →', nf.state, '| phase =', meta.phase, '| stale =', nf.stale,
      staleReasonText(nf) ? '| ' + staleReasonText(nf) : '');
  }
}

if (REQUIRE_FRESH) {
  // ② 离线模块门禁（2026-10-08 第三批）：宽度/主线/账本三模块只在 build 里产出，
  //   build 被拦（smoke 挂）或模块步骤失败被吞时旧值顶替当日值——收尾门禁把
  //   「今日未刷新」红出来（exit 1 = 本次运行标红通知，数据在前一步已提交不丢）。
  //   判定复用 assessFreshness 相位语义：18:30 首抓窗口的「还没到点」= pending
  //   不误伤；过预期更新时刻仍落后 = behind 才红。模块档缺失/字段缺失 = unknown 同样红
  //   （无法自证新鲜即判脏）。判据锚定档案日期体系，假期同停天然不误杀。
  //   仅 --require-fresh 模式执行：18:30 的中途判定（无此 flag）时宽度还没抓，
  //   此时打印模块判定只会制造「恒滞后」噪音。
  const moduleList = MODULE_PROBES.map((m) => {
    const mp = join(dirname(P), m.file);
    let date = null;
    if (existsSync(mp)) {
      try { date = moduleTradeDate(JSON.parse(readFileSync(mp, 'utf8'))); } catch { date = null; }
    }
    return { key: m.key, label: m.label, date };
  });
  const assessed = assessModulesFreshness(moduleList, { now, holidays: resolveHolidays() });
  console.log('[freshness] 离线模块门禁（宽度/主线/账本，档案日期体系，假期同停不误杀）');
  for (const a of assessed) {
    const mark = (a.state === 'behind' || a.state === 'unknown') ? '✗' : '✓';
    const extra = a.state === 'behind' ? `（落后 ${a.behindSessions} 个交易日）`
      : a.state === 'unknown' ? '（日期缺失：档不存在或字段缺失）' : '';
    console.log(`  ${mark} ${a.label.padEnd(4, '　')} ${a.date ?? '(无日期)'}  ${a.state}${extra}`);
  }
  const bad = modulesBehind(assessed);
  if (bad.length) {
    console.error(`[freshness] 离线模块门禁失败：${bad.map((b) => b.label).join('、')}今日未刷新——旧值不得顶替当日值`);
    process.exit(1);
  }
}

if (REQUIRE_FRESH && f.state === 'behind') {
  console.error(`[freshness] 门禁失败：数据滞后 —— ${staleReasonText(f)}`);
  process.exit(1);
}
