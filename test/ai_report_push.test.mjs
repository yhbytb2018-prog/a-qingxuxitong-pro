// ═══ S2：AI 报告推送与调度闸门（src/ai_report_push.js）══════════════════
//
// 覆盖：① 指纹稳定性与敏感性（generated_at 剔除 / payload 变化感知）；
//   ② 防风暴：30 天同内容去重、TTL 过期放行、urgent（event:*）免防风暴直达；
//   ③ 状态文件 IO（坏档不炸、roundtrip、TTL/上限修剪）；
//   ④ 四类企微文本渲染（null → —，不冒充 0；超长截断；urgent 标记）；
//   ⑤ pushReports：无 webhook 静默跳过 / fetch 失败不 throw 且不记指纹（下拍
//      自愈重试）/ 成功记指纹并去重二次推送；
//   ⑥ 三调度闸门：盘前（交易日）、盘中（相位 live）、周报（本周最后交易日，
//      节前半周也能正确判定，不写死周五）；
//   ⑦ isoWeekStart（周报周一起点推导）+ 候选池 intraday_chg（不在强势榜 = null ≠ 0）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PUSH_CONSTS, fingerprintOf, shouldPush, pruneState, recordPushed,
  loadPushState, savePushState, renderPushText, pushReports,
  gatePreMarket, gateIntraday, gateWeekly,
} from '../src/ai_report_push.js';
import { isoWeekStart, buildCandidatePool } from '../src/ai_report.js';

// ── 夹具：最小信封（推送/渲染只消费这些字段）──────────────────────────
const mkReport = (over = {}) => ({
  schema_version: '1.0',
  report_type: 'post_market',
  trigger: 'schedule',
  urgent: false,
  date: '2026-09-30',
  generated_at: '2026-09-30T13:05:00.000Z',
  generated_by: 'ci',
  status: 'degraded',
  payload: {
    date: '2026-09-30',
    pnl_daily: 0.0002,
    pnl_cumulative: -0.015,
    close_drawdown: 0.1379,
    market_context: { up_down: '2600/2400/400', zt_dt: '52/3', pain: '晋级失败 40%' },
    backtest_deviation: { live_cum: -0.015, backtest_v52: -0.015, delta: 0, note: '执行轨 vs 回测 v52 锚点' },
    simulation_stock: {
      sentiment_cycle: { phase: 'fermentation', phase_label: '发酵期', regime_raw: 'recover', highest_chain: 6, broken_limit_ratio: 0.1875 },
      position_suggestion: 'neutral',
      candidate_pool: [{ code: '600825', name: '新华传媒', intraday_chg: null }],
    },
  },
  missing_notes: [{ field: 'grid_triggers', reason: '系统无网格交易引擎', ref: 'src/grid_parallel.js' }],
  ...over,
});

// ── 1. 指纹 ───────────────────────────────────────────────────────────
test('fingerprintOf：generated_at/易变字段不进指纹，payload 变化必换指纹', () => {
  const r = mkReport();
  const same = mkReport({ generated_at: '2026-09-30T18:35:00.000Z', generated_by: 'browser', data_health: { sources: { dual_track: 'stale' } } });
  assert.equal(fingerprintOf(r), fingerprintOf(same), '易变字段剔除 → 重跑同内容同指纹');
  const changed = mkReport({ payload: { ...r.payload, pnl_daily: 0.031 } });
  assert.notEqual(fingerprintOf(r), fingerprintOf(changed), '内容真变了 → 新指纹（宁可重推真变化）');
  const urgent = mkReport({ trigger: 'event:circuit_breaker', urgent: true });
  assert.notEqual(fingerprintOf(r), fingerprintOf(urgent), 'trigger 进指纹（事件版是另一份报告）');
});

// ── 1.5 MA20 降级红警（2026-10-08 推送前校验 ①）─────────────────────
// 主验证链：renderPushText 消费 report.payload.ma20_degraded——降级版（s_amt
// 中性 50）推送必现红警行；正常版（s_amt=44）不显示不添乱（老档无此键 → falsy 兼容）。
test('MA20 降级红警：ma20_degraded=true 推送含红警行，false 不含', () => {
  const base = mkReport();
  const degraded = renderPushText(mkReport({ payload: { ...base.payload, ma20_degraded: true } }));
  assert.match(degraded, /MA20 降级版/, '降级版红警行一定在');
  assert.match(degraded, /中性 50/, '量能因子中性 50 文案在场');
  const normal = renderPushText(base);
  assert.doesNotMatch(normal, /MA20/, '正常推送不出现 MA20 警示字样');
});

// ── 2. 防风暴判定 ─────────────────────────────────────────────────────
test('shouldPush：新内容放行 / 30 天内同内容拦截 / TTL 过期放行 / urgent 直达', () => {
  const r = mkReport();
  const fp = fingerprintOf(r);
  const hourAgo = '2026-10-06T12:00:00.000Z';
  assert.equal(shouldPush(r, { pushed: [] }, new Date('2026-10-06T13:00:00Z')).push, true, '空状态 → 新内容');
  const state = { pushed: [{ fingerprint: fp, type: 'post_market', date: r.date, pushed_at: hourAgo }] };
  assert.equal(shouldPush(r, state, new Date('2026-10-06T13:00:00Z')).push, false, '1 小时前推过同内容 → 拦');
  const stale = { pushed: [{ fingerprint: fp, type: 'post_market', date: r.date, pushed_at: '2026-09-01T00:00:00Z' }] };
  assert.equal(shouldPush(r, stale, new Date('2026-10-06T13:00:00Z')).push, true, '31 天前推过 → TTL 已过放行');
  const urgent = mkReport({ trigger: 'event:circuit_breaker', urgent: true });
  assert.equal(shouldPush(urgent, state, new Date('2026-10-06T13:00:00Z')).push, true, 'urgent 免防风暴直达（决议 3）');
});

// ── 3. 状态修剪与记录 ─────────────────────────────────────────────────
test('pruneState/recordPushed：TTL 清理 + 上限截断（保最新）+ 追加幂等可链', () => {
  const now = new Date('2026-10-06T13:00:00Z');
  const arr = Array.from({ length: PUSH_CONSTS.STATE_CAP + 5 }, (_, i) => ({
    fingerprint: `fp${i}`, pushed_at: new Date(now.getTime() - i * 3600_000).toISOString(),
  }));
  const pruned = pruneState({ pushed: arr }, now);
  assert.equal(pruned.pushed.length, PUSH_CONSTS.STATE_CAP, '上限截断');
  assert.equal(pruned.pushed[0].fingerprint, 'fp0', '保最新在前');
  const aged = pruneState({ pushed: [{ fingerprint: 'x', pushed_at: '2026-09-01T00:00:00Z' }] }, now);
  assert.equal(aged.pushed.length, 0, '超龄清理');
  const rec = recordPushed({ pushed: [] }, { fingerprint: 'ab', type: 'intraday', date: '2026-10-06' }, now);
  assert.equal(rec.pushed.length, 1);
  assert.equal(rec.pushed[0].pushed_at, now.toISOString());
});

// ── 4. 状态文件 IO ────────────────────────────────────────────────────
test('loadPushState/savePushState：roundtrip / 缺档空态 / 坏 JSON 空态不炸', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airpt-state-'));
  try {
    const f = join(dir, 'push_state.json');
    assert.deepEqual(loadPushState(f), { schema_version: '1.0', pushed: [] }, '缺档 → 空态');
    writeFileSync(f, '{bad json', 'utf8');
    assert.deepEqual(loadPushState(f), { schema_version: '1.0', pushed: [] }, '坏 JSON → 空态不 throw');
    const state = recordPushed(loadPushState(f), { fingerprint: 'fp1', type: 'post_market', date: '2026-09-30' }, new Date('2026-10-06T13:00:00Z'));
    savePushState(f, state);
    assert.equal(loadPushState(f).pushed[0].fingerprint, 'fp1', 'save → load roundtrip');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 5. 文本渲染（四类）────────────────────────────────────────────────
test('renderPushText：四类各成版式；null → — 不冒充 0；缺失披露进尾注', () => {
  const post = renderPushText(mkReport());
  assert.match(post, /【AI 报告 · 盘后】2026-09-30/);
  assert.match(post, /当日盈亏 \+0\.02%/);
  assert.match(post, /收盘回撤 \+13\.79%/);
  assert.match(post, /情绪周期: 发酵期\(recover\)/);
  assert.match(post, /缺失披露 1 项 · 数据状态 degraded/, '降级状态如实进尾注');

  const pre = renderPushText(mkReport({
    report_type: 'pre_market',
    payload: { date: '2026-09-30', pnl_daily: null, pnl_cumulative: null, prev_nav: null, overseas: [{ key: 'a50', chgPct: 0.0009 }], overnight_exposure: { posGap: null }, simulation_stock: null },
    missing_notes: [],
  }));
  assert.match(pre, /【AI 报告 · 盘前】2026-09-30/);
  assert.match(pre, /前日盈亏 — · 累计 —/, 'null → —，不冒充 0');
  assert.match(pre, /A50 \+0\.09%/);
  assert.match(pre, /缺失披露 0 项/);
  assert.ok(pre.includes('数据截至 2026-09-30 收盘\n'), '盘前恒标数据截至（前收口径，头部日期即数据日期）');
  assert.ok(!pre.includes('假期无更新'), '常规隔夜（gap≤3 自然日）不加假期附注');
  const preHoliday = renderPushText(mkReport({
    report_type: 'pre_market', date: '2026-09-30', generated_at: '2026-10-08T01:05:00.000Z',
    payload: { date: '2026-09-30', pnl_daily: null, pnl_cumulative: null, prev_nav: null, overseas: [], overnight_exposure: { posGap: null }, simulation_stock: null },
    missing_notes: [],
  }));
  assert.ok(preHoliday.includes('数据截至 2026-09-30 收盘（距生成 8 天，假期无更新）'), '节后首日（gap>3）附假期无更新——10-08 盘前实况');

  // S3-5 外围收盘聚合行：有值渲染（cnh null → —）、老档/全缺整行省略、上限内
  const preFull = renderPushText(mkReport({
    report_type: 'pre_market',
    payload: { date: '2026-09-30', pnl_daily: null, pnl_cumulative: null, prev_nav: null, overseas: [{ key: 'a50', chgPct: 0.001853 }],
      overnight_exposure: { posGap: 4, us_close: { dji: 0.004942, spx: 0.005786, ixic: 0.004458 }, cn_overnight: { hxc: 0.003142, fxi: -0.002363 }, cnh_chgPct: null },
      simulation_stock: null },
    missing_notes: [],
  }));
  assert.match(preFull, /外围收盘: 道 \+0\.49% · 标普 \+0\.58% · 纳指 \+0\.45% · 金龙 \+0\.31% · FXI -0\.24% · 离岸人民币 —/, '聚合一行 + null → —');
  assert.ok(preFull.length <= PUSH_CONSTS.MSG_CAP, '企微 text 上限内（2000 留余量）');
  assert.ok(!pre.includes('外围收盘'), '无新字段段（fixture 夹具）→ 整行省略，不留一排 — 噪音行');

  const intra = renderPushText(mkReport({
    report_type: 'intraday', trigger: 'event:circuit_breaker', urgent: true,
    payload: { date: '2026-09-30', drawdown_vs_threshold: { dd_now: 0.088, distance_pp: 0.2, basis: '归档轨 trackA.maxDd' }, pnl_daily: 0.0002, pnl_cumulative: -0.015, overseas: [], simulation_stock: { ...mkReport().payload.simulation_stock, candidate_pool: [{ code: '600825', name: '新华传媒', intraday_chg: 3.3 }] } },
    missing_notes: [],
  }));
  assert.match(intra, /【AI 报告 · 盘中】2026-09-30 · event:circuit_breaker/, 'urgent 触发源进标题');
  assert.match(intra, /运行回撤 \+8\.80% · 距 DD 档位 0\.2pp/);
  assert.match(intra, /候选池盘中\(强势榜在列\)/, '强势榜在列候选股进盘中版式');

  const week = renderPushText(mkReport({
    report_type: 'weekly',
    payload: { date: '2026-09-30', week_return: -0.011, max_drawdown_week: 0.02, profit_trade_ratio: 0.4, win_rate: null, trend_switch_hits: 2, trend_switch_effect: { shadow_note: 'trackC 影子线累计 -0.9 vs 执行轨 -1.5' } },
    missing_notes: [],
  }));
  assert.match(week, /【AI 报告 · 周报】截至 2026-09-30/);
  assert.match(week, /周收益 -1\.10% · 周最大回撤 \+2\.00% · 盈利日占比 \+40\.00%/);
  assert.match(week, /胜率 —（剧本口径，绑定缺席则 null）/, '胜率 null 口径如实披露');
  assert.match(week, /趋势切换 2 次/);

  // 超长截断：缺失披露塞爆 → 不超企微上限
  const fat = mkReport({ missing_notes: Array.from({ length: 200 }, (_, i) => ({ field: `f${i}`, reason: 'r'.repeat(30), ref: '-' })) });
  assert.ok(renderPushText(fat).length <= PUSH_CONSTS.MSG_CAP, '超长截断至上限内');
});

// ── 6. pushReports（fetch 注入零网络）─────────────────────────────────
test('pushReports：无 webhook 跳过 / 成功记指纹 / 二次去重 / 失败不记指纹自愈 / 不 throw', async () => {
  const r = mkReport();
  const dir = mkdtempSync(join(tmpdir(), 'airpt-push-'));
  const stateFile = join(dir, 'push_state.json');
  try {
    // 无 webhook → 静默跳过
    const none = await pushReports([r], { env: {}, stateFile });
    assert.equal(none.pushed, 0);
    assert.equal(none.skipped, 1);
    assert.match(none.results[0].reason, /未配置 OPS_WEBHOOK/);

    const calls = [];
    const fetchOk = { ok: true };
    const ok1 = await pushReports([r], { env: { OPS_WEBHOOK: 'https://example.test/hook' }, fetchImpl: async (u, init) => { calls.push({ u, init }); return fetchOk; }, stateFile, now: new Date('2026-10-06T13:00:00Z') });
    assert.equal(ok1.pushed, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].u, 'https://example.test/hook');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.msgtype, 'text');
    assert.match(body.text.content, /【AI 报告 · 盘后】/, '企微 text 消息体');
    assert.equal(loadPushState(stateFile).pushed.length, 1, '成功记指纹');

    // 同内容二次推送 → 指纹去重
    const ok2 = await pushReports([r], { env: { OPS_WEBHOOK: 'https://example.test/hook' }, fetchImpl: async () => fetchOk, stateFile, now: new Date('2026-10-06T13:30:00Z') });
    assert.equal(ok2.pushed, 0);
    assert.match(ok2.results[0].reason, /duplicate_fingerprint/);

    // 失败（网络断 / HTTP 500）→ 不 throw、不记指纹 → 下拍重试自愈
    for (const bad of [async () => { throw new Error('网络断'); }, async () => ({ ok: false, status: 500 })]) {
      const fdir = mkdtempSync(join(tmpdir(), 'airpt-retry-'));
      try {
        const fail = await pushReports([r], { env: { OPS_WEBHOOK: 'https://x.test' }, fetchImpl: bad, stateFile: join(fdir, 's.json'), now: new Date('2026-10-06T14:00:00Z') });
        assert.equal(fail.pushed, 0);
        assert.match(fail.results[0].reason, /重试/);
        assert.equal(loadPushState(join(fdir, 's.json')).pushed.length, 0, '失败不记指纹');
      } finally { rmSync(fdir, { recursive: true, force: true }); }
    }
    // urgent 免防风暴：同内容已推过也直达
    const urgent = mkReport({ trigger: 'event:trend_switch', urgent: true });
    const okU = await pushReports([urgent], { env: { OPS_WEBHOOK: 'https://example.test/hook' }, fetchImpl: async () => fetchOk, stateFile, now: new Date('2026-10-06T13:30:00Z') });
    assert.equal(okU.pushed, 1, 'urgent 同内容也直达（trigger 进指纹故本就为新；双保险）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 6b. 企微 errcode 解析：HTTP OK 但 errcode≠0（93xxx 静默丢包）→ 不记指纹、重试自愈 ──
test('pushReports：企微 HTTP 200 + errcode≠0 静默丢包 → 不记指纹、不抛、reason 暴露 errcode', async () => {
  const r = mkReport();
  const dir = mkdtempSync(join(tmpdir(), 'airpt-errcode-'));
  const stateFile = join(dir, 's.json');
  try {
    // 模拟企微：HTTP 200 + errcode=93000（机器人被拉起/群解散——企微的"假成功"陷阱）
    const failWechat = async () => ({
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ errcode: 93000, errmsg: '机器人被移除，请先补群' }),
    });
    const fail = await pushReports([r], { env: { OPS_WEBHOOK: 'https://x.test' }, fetchImpl: failWechat, stateFile, now: new Date('2026-10-08T13:30:00Z') });
    assert.equal(fail.pushed, 0, 'errcode≠0 → 不算成功');
    assert.match(fail.results[0].reason, /errcode=93000/, 'reason 暴露 errcode，便于排查（这是漏洞修复的核心证据）');
    assert.match(fail.results[0].reason, /未记指纹/, '同 HTTP 失败：失败不记指纹');
    assert.equal(loadPushState(stateFile).pushed.length, 0, '状态文件干净（不记指纹 → 下拍重试自愈）');

    // 模拟正常：HTTP 200 + errcode=0 → 成功 + 记指纹（与未升级前行为一致）
    const okWechat = async () => ({
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ errcode: 0, errmsg: 'ok' }),
    });
    const ok = await pushReports([r], { env: { OPS_WEBHOOK: 'https://x.test' }, fetchImpl: okWechat, stateFile, now: new Date('2026-10-08T13:30:00Z') });
    assert.equal(ok.pushed, 1, 'errcode=0 → 推送成功');
    assert.match(ok.results[0].reason, /new_content/);
    assert.equal(loadPushState(stateFile).pushed.length, 1, '记指纹');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 6c. 缺 .json/.text 的旧 mock 仍能跑通（防御性解析不打破现有注入约定）────
test('pushReports：fetchImpl 返回 { ok, status } 无 body 方法时，行为与未升级前一致', async () => {
  const r = mkReport();
  const dir = mkdtempSync(join(tmpdir(), 'airpt-legacy-mock-'));
  try {
    // 失败路径（先做，避免被后置成功去重）：{ ok:false, status:502 } → 走原 HTTP reason
    const bad = await pushReports([r], { env: { OPS_WEBHOOK: 'https://x.test' }, fetchImpl: async () => ({ ok: false, status: 502 }), stateFile: join(dir, 'bad.json'), now: new Date('2026-10-08T13:30:00Z') });
    assert.equal(bad.pushed, 0);
    assert.match(bad.results[0].reason, /HTTP 502/, '无 body 方法时仍报 HTTP reason');

    // 成功路径（独立 stateFile）：{ ok: true } 无 .json → 仍应算成功（errcode 未暴露 → 不算失败）
    const ok = await pushReports([r], { env: { OPS_WEBHOOK: 'https://x.test' }, fetchImpl: async () => ({ ok: true }), stateFile: join(dir, 'ok.json'), now: new Date('2026-10-08T13:30:00Z') });
    assert.equal(ok.pushed, 1, '无 body 方法 + res.ok=true → 成功（与升级前兼容）');
    assert.equal(loadPushState(join(dir, 'ok.json')).pushed.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 7. 调度闸门 ───────────────────────────────────────────────────────
test('gatePreMarket/gateIntraday：交易日 + 相位三态（判据与 snapshot_intraday 同源）', () => {
  const THU_PRE = new Date('2026-10-08T01:05:00Z');  // 北京周四 09:05（pre）
  const THU_LIVE = new Date('2026-10-08T02:00:00Z'); // 北京周四 10:00（live）
  const THU_POST = new Date('2026-10-08T07:30:00Z'); // 北京周四 15:30（closed）
  const SAT = new Date('2026-10-10T01:05:00Z');      // 北京周六 09:05
  assert.equal(gatePreMarket(THU_PRE, []).ok, true, '交易日 09:05 → 出盘前报告');
  assert.equal(gatePreMarket(SAT, []).ok, false, '周六 → 跳过');
  assert.equal(gatePreMarket(THU_PRE, ['2026-10-08']).ok, false, '节假日列表命中 → 跳过');
  assert.equal(gateIntraday(THU_LIVE, []).ok, true, '盘中 10:00 → 出盘中报告');
  assert.equal(gateIntraday(THU_PRE, []).ok, false, '09:05 相位 pre → 跳过（盘中报告不抢盘前语义）');
  assert.equal(gateIntraday(THU_POST, []).ok, false, '15:30 相位 closed → 跳过');
});

test('gateWeekly：周五放行 / 周中拦截 / 节前最后交易日放行（不写死周五）', () => {
  assert.equal(gateWeekly('2026-10-09', []).ok, true, '普通周五 → 本周最后交易日');
  assert.equal(gateWeekly('2026-10-08', []).ok, false, '周四且周五开市 → 等周五');
  assert.equal(gateWeekly('2026-10-07', ['2026-10-08', '2026-10-09']).ok, true, '周四 + 周五休市 → 周四即最后交易日（节前半周）');
  assert.equal(gateWeekly('2026-10-09', ['2026-10-09']).ok, true, '周五本身休市不发生于本判据（tradeDate 来自真实数据，休市日无数据）');
  assert.equal(gateWeekly('国庆假期', []).ok, false, '非法日期 → 拦');
  assert.match(gateWeekly('2026-10-08', []).reason, /2026-10-09/, '拦截理由给出等待日');
});

// ── 8. isoWeekStart + 候选池盘中联查 ──────────────────────────────────
test('isoWeekStart：周三/周五/周一/非法 → 正确周一或 null', () => {
  assert.equal(isoWeekStart('2026-09-30'), '2026-09-28', '周三 → 本周一');
  assert.equal(isoWeekStart('2026-10-09'), '2026-10-05', '周五 → 本周一');
  assert.equal(isoWeekStart('2026-10-05'), '2026-10-05', '周一 → 自身');
  assert.equal(isoWeekStart('2026-10-04'), '2026-09-28', '周日 → 上周一（ISO 周归属）');
  assert.equal(isoWeekStart(null), null);
  assert.equal(isoWeekStart('bad'), null);
});

test('buildCandidatePool intraday_chg：在强势榜取真值 / 不在榜 null ≠ 0 / 未注入恒 null', () => {
  const signals = { pain: { advance: { failRate: 0.4, detail: [
    { code: '600825', lb: 6, chg: 9.99, kept: true },
    { code: '000678', lb: 3, chg: 9.98, kept: true },
  ] } } };
  const noHot = buildCandidatePool(signals, {});
  assert.equal(noHot[0].intraday_chg, null, '未注入（盘前/盘后语义）→ null');
  const hot = buildCandidatePool(signals, { intradayHot: { '600825': 5.2 } });
  assert.equal(hot[0].intraday_chg, 5.2, '强势榜在列 → 盘中真值');
  assert.equal(hot[1].intraday_chg, null, '不在强势榜 → null（缺席 ≠ 不涨，严格区分）');
  const badHot = buildCandidatePool(signals, { intradayHot: { '600825': 'NaN-ish' } });
  assert.equal(badHot[0].intraday_chg, null, '非数值守卫 → null');
});
