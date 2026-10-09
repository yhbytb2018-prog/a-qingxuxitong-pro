// ── 前后端接口契约守卫（V5.3 同步机制 · 2026-10-05）────────────────────────
//
// 三层守卫：
//   ① 磁盘档 vs 契约全绿锚定（门禁本体——接口漂移即红）
//   ② 校验器语义单元（required/类型/枚举/anyOf/$ref/additionalProperties/边界）
//   ③ 负向破坏演练：把 missingNote→missingReason 那次真实事故重演一遍，
//      确认校验器会拦（不会因为「字段存在但名字不对」而漏报）——守卫的守卫。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateContract, formatContractErrors } from '../src/contract.js';
import { crossCheckTrackMirror, crossCheckDualTrack } from '../scripts/check_contract.mjs';
import { cumFromSummary, buildTrackNote } from '../src/dual_track.js';
import { buildPushPayload } from '../scripts/alert_channel.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.meta ? fileURLToPath(import.meta.url) : import.meta.url)), '..');
const load = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

// ── ① 磁盘档全绿锚定：与 scripts/check_contract.mjs 同一套契约 ─────────────
const CONTRACTED = ['signals-latest', 'backtest', 'version-regression', 'archive-index', 'global', 'intraday'];
for (const name of CONTRACTED) {
  test(`契约锚定：data/${name}.json 符合 schemas/${name}.schema.json`, () => {
    assert.ok(existsSync(join(ROOT, `data/${name}.json`)), `data/${name}.json 应存在（intraday 在 CI 本地已生成）`);
    const errs = validateContract(load(`data/${name}.json`), load(`schemas/${name}.schema.json`));
    assert.deepEqual(errs, [], errs.length ? formatContractErrors(name, errs) : '');
  });
}

// P2-β 轨道契约档（与 check_contract.mjs CONTRACTED 对象条目同步）：
// 设计性缺席 = 合法态（track_state 缺席 = 轨道 A 常态；快照在首次回滚时提取），
// 存在则必须过结构契约——「缺席跳过、在场必锁」。
for (const [name, dataPath] of [
  ['track-state', 'data/paper/track_state.json'],
  ['track-fallback-params', 'data/paper/track_fallback_params.json'],
]) {
  test(`契约锚定（P2-β）：${dataPath} 存在时须符合 schemas/${name}.schema.json（缺席=设计态）`, () => {
    if (!existsSync(join(ROOT, dataPath))) return; // 缺席 = 轨道 A 常态 / 快照未提取，跳过
    const errs = validateContract(load(dataPath), load(`schemas/${name}.schema.json`));
    assert.deepEqual(errs, [], errs.length ? formatContractErrors(dataPath, errs) : '');
  });
}

// ── ② 校验器语义单元 ──────────────────────────────────────────────────────
test('校验器：required 缺失报错且带 JSON Pointer 路径', () => {
  const errs = validateContract({}, { type: 'object', required: ['level'] });
  assert.equal(errs.length, 1);
  assert.equal(errs[0].path, '/level');
  assert.match(errs[0].hint, /前后端不同步/);
});

test('校验器：类型不符（含数组形态任一命中）', () => {
  assert.equal(validateContract('x', { type: 'number' }).length, 1);
  assert.equal(validateContract(null, { type: ['number', 'null'] }).length, 0);
  assert.equal(validateContract(3, { type: ['number', 'null'] }).length, 0);
});

test('校验器：枚举与常量（哨兵）', () => {
  assert.equal(validateContract('maybe', { type: 'string', enum: ['ok', 'warn'] }).length, 1);
  assert.equal(validateContract('signals-latest', { type: 'string', const: 'signals-latest' }).length, 0);
  assert.equal(validateContract('other', { type: 'string', const: 'signals-latest' }).length, 1);
});

test('校验器：数值边界与数组 items/minItems', () => {
  assert.equal(validateContract(101, { type: 'number', maximum: 100 }).length, 1);
  assert.equal(validateContract(-1, { type: 'number', minimum: 0 }).length, 1);
  assert.equal(validateContract([1], { type: 'array', items: { type: 'number' }, minItems: 2 }).length, 1);
  assert.equal(validateContract(['x'], { type: 'array', items: { type: 'number' } }).length, 1);
});

test('校验器：anyOf 三态（null 或对象）与失败诊断', () => {
  const schema = {
    anyOf: [
      { type: 'null' },
      { type: 'object', required: ['level'], properties: { level: { type: 'string' } } },
    ],
  };
  assert.equal(validateContract(null, schema).length, 0);
  assert.equal(validateContract({ level: 'ok' }, schema).length, 0);
  const errs = validateContract({ level: 42 }, schema);
  assert.equal(errs.length, 1);
  assert.match(errs[0].hint, /分支#2/); // 诊断必须指明哪个分支差在哪
});

test('校验器：$ref 本文件内解析与非法引用拦截', () => {
  const schema = {
    type: 'object', required: ['p'],
    properties: { p: { $ref: '#/$defs/perf' } },
    $defs: { perf: { type: 'object', required: ['annual'], properties: { annual: { type: 'number' } } } },
  };
  assert.equal(validateContract({ p: { annual: 1 } }, schema).length, 0);
  assert.equal(validateContract({ p: {} }, schema).length, 1);
  // 跨文件引用刻意不支持
  const bad = validateContract({ p: {} }, { type: 'object', properties: { p: { $ref: 'other.schema.json#/x' } } });
  assert.match(bad[0].hint, /不支持/);
});

test('校验器：additionalProperties 动态键值结构（version-regression.stats 模式）', () => {
  const schema = {
    type: 'object',
    additionalProperties: { type: 'object', required: ['scoreMean'], properties: { scoreMean: { type: 'number' } } },
  };
  assert.equal(validateContract({ v5: { scoreMean: 1 } }, schema).length, 0);
  assert.equal(validateContract({ v5: { scoreMean: 'x' } }, schema).length, 1);
  assert.equal(validateContract({ v5: {} }, schema).length, 1);
});

test('格式化输出：路径/期望/实际/指引四要素齐全（可执行错误提示）', () => {
  const out = formatContractErrors('data/x.json', validateContract({}, { type: 'object', required: ['level'] }));
  assert.match(out, /data\/x\.json\/level/);
  assert.match(out, /期望：/);
  assert.match(out, /实际：/);
  assert.match(out, /指引：/);
});

// ── ③ 负向破坏演练：重演 missingNote→missingReason 真实事故 ────────────────
//   用**真实契约**（schemas/signals-latest.schema.json 的 sections 双形态）演练，
//   而非手写严格 schema——守卫的守卫：确认线上那份契约本身能拦住那次事故。
test('负向演练：字段改名（missingReason→missingNote）必须被真实契约拦截', () => {
  const schema = load('schemas/signals-latest.schema.json');
  const sectionsPath = ['properties', 'dailyReport', 'anyOf', 1, 'properties', 'sections'];
  const sectionsSchema = sectionsPath.reduce((acc, k) => acc[k], schema);
  assert.ok(sectionsSchema, '契约结构漂移：dailyReport.sections 路径取不到（改契约须同步本测试）');

  // 后端改了名：missingNote 存在、missingReason 缺失（57a12b7 事故形态）
  //   注：sectionsSchema 的根就是数组本身（从契约深处取出，不含外层包装）
  const renamed = [{ id: 'llm', title: '八、舆情参考', missing: true, missingNote: '未生成' }];
  const errs = validateContract(renamed, sectionsSchema);
  assert.equal(errs.length, 1, '改名必须被拦：missing=true 形态要求 missingReason 必在');
  assert.equal(errs[0].path, '/0', '违例定位到具体节（items 索引路径）');
  assert.match(errs[0].hint, /分支#/);

  // 正常双形态都放行（防误伤）
  assert.equal(validateContract([{ id: 'a', title: '一', level: 'info', missing: false, points: [{ text: 'x', kind: 'main' }] }], sectionsSchema).length, 0);
  assert.equal(validateContract([{ id: 'b', title: '二', level: 'unknown', missing: true, missingReason: '未生成' }], sectionsSchema).length, 0);

  // 非 missing 节漏 points（整节渲染空白）同样必须拦
  const noPoints = [{ id: 'a', title: '一', level: 'info', missing: false }];
  assert.equal(validateContract(noPoints, sectionsSchema).length, 1);
});

test('负向演练：类型漂移（verdict.level 从枚举值变自定义串）被枚举拦截', () => {
  const schema = { type: 'string', enum: ['inst', 'north', 'hot', 'unknown'] };
  assert.equal(validateContract('vip', schema).length, 1);
});

test('负向演练：前端新消费字段（triggeredDays）漏产被 required 拦截', () => {
  const schema = {
    type: 'object', required: ['annual', 'triggeredDays'],
    properties: { annual: { type: 'number' }, triggeredDays: { type: 'number' } },
  };
  const errs = validateContract({ annual: -0.06 }, schema); // 后端旧版没产 triggeredDays
  assert.equal(errs.length, 1);
  assert.equal(errs[0].path, '/triggeredDays');
});

// ── ④ P2-β 轨道契约守卫（2026-10-06）：字段化 + 一致性 + 降级 ────────────────
//   用真实契约（schemas/track-state.schema.json / signals active_track）与
//   check_contract.mjs 的 crossCheckTrackMirror 纯函数做负向演练——守卫的守卫。

test('P2-β：signals.active_track 三态契约（缺席=A 常态 / A_fallback 合法 / 其他值拦）', () => {
  const schema = load('schemas/signals-latest.schema.json');
  const at = schema.properties.active_track;
  assert.ok(at, '契约结构漂移：properties.active_track 取不到（改契约须同步本测试）');
  // 缺席 = 轨道 A 常态（optional，非 required——A 态零 diff 纪律）
  assert.ok(!schema.required.includes('active_track'), 'active_track 必须 optional（缺席=轨道 A 是合法态）');
  // 'A' 不得成为合法显式值（A 态 = 缺席，不是写 'A'——防「显式 A」稀释零 diff 纪律）
  assert.deepEqual(at.enum, ['A_fallback']);
  assert.equal(validateContract('A_fallback', at).length, 0);
  assert.equal(validateContract('A', at).length, 1);
  assert.equal(validateContract('X', at).length, 1);
});

test('P2-β：track_state 结构契约（activeTrack 枚举 / fallback 三态 / history 台账）', () => {
  const schema = load('schemas/track-state.schema.json');
  const fbShape = { since: 't', effectiveDate: '2026-10-08', trigger: 'T4', why: 'w', who: 'u', snapshotCommit: 'bd77fed', log: 'logs/x.json' };
  // 合法 A 态（fallback=null）与合法 A_fallback 态（fallback 段齐）
  assert.equal(validateContract({ activeTrack: 'A', fallback: null, history: [] }, schema).length, 0);
  assert.equal(validateContract({ activeTrack: 'A_fallback', fallback: fbShape, history: [{ at: 't', event: 'rollback', why: 'w' }] }, schema).length, 0);
  // 枚举拦截：activeTrack 非法值（降级语义之外的脏值必须红）
  assert.equal(validateContract({ activeTrack: 'B', fallback: null, history: [] }, schema).length, 1);
  // 半缺最危险形态：A_fallback 态 fallback 段缺 who/log（渲染静默空白类事故）
  //   anyOf 失败汇总为单条（分支诊断内嵌 who/log 的 JSON Pointer）——断言诊断而非条数
  const halfErrs = validateContract({ activeTrack: 'A_fallback', fallback: { since: 't', effectiveDate: null, trigger: 'T1', why: 'w', snapshotCommit: 'c' }, history: [] }, schema);
  assert.equal(halfErrs.length, 1, 'fallback 半缺必须被 anyOf 拦（null 分支不中 + object 分支 required 失败）');
  assert.match(halfErrs[0].hint, /分支#2.*\/who.*\/log|分支#2.*\/log.*\/who/, '诊断须定位到缺失字段（who/log 的 JSON Pointer）');
  // trigger 枚举（T1~T4 唯一合法触发编号）
  assert.equal(validateContract({ activeTrack: 'A_fallback', fallback: { ...fbShape, trigger: 'R9' }, history: [] }, schema).length, 1);
});

test('P2-β：跨档一致性守卫（crossCheckTrackMirror 纯函数负向演练）', () => {
  const fb = { since: 't', effectiveDate: '2026-10-08', trigger: 'T4', why: 'w', snapshotCommit: 'bd77fed', log: 'l' };
  // 合法两态零违例
  assert.deepEqual(crossCheckTrackMirror(null, {}), []);                       // 无状态文件 = A 常态
  assert.deepEqual(crossCheckTrackMirror({ activeTrack: 'A', fallback: null, history: [] }, {}), []);
  assert.deepEqual(crossCheckTrackMirror({ activeTrack: 'A_fallback', fallback: fb, history: [] }, { active_track: 'A_fallback', activeTrackNote: 'x' }), []);
  // A_fallback 缺镜像（自愈未跑——真事故形态：pipeline 重写冲掉后 paper_dual_track 未跑）
  assert.equal(crossCheckTrackMirror({ activeTrack: 'A_fallback', fallback: fb, history: [] }, {}).length, 1);
  // A_fallback 有镜像但 note 缺（降级客户端提示文案丢失）
  assert.equal(crossCheckTrackMirror({ activeTrack: 'A_fallback', fallback: fb, history: [] }, { active_track: 'A_fallback' }).length, 1);
  // A 态残留镜像（restore 未清干净）
  assert.equal(crossCheckTrackMirror({ activeTrack: 'A', fallback: null, history: [] }, { active_track: 'A_fallback' }).length, 1);
  // A 态 fallback 元数据残留（状态脏）
  assert.equal(crossCheckTrackMirror({ activeTrack: 'A', fallback: fb, history: [] }, {}).length, 1);
  // activeTrack 非法值（降级之外必须红——缺字段≠错误渲染，但脏值≠静默）
  assert.equal(crossCheckTrackMirror({ activeTrack: 'X', fallback: null, history: [] }, {}).length, 1);
});

test('P2-β：磁盘态一致性锚定（双态感知：A 常态无镜像 / A_fallback 镜像齐且过守卫）', () => {
  const sig = load('data/signals-latest.json');
  const stPath = join(ROOT, 'data', 'paper', 'track_state.json');
  const st = existsSync(stPath) ? JSON.parse(readFileSync(stPath, 'utf8')) : null;
  if (!st || st.activeTrack === 'A') {
    // A 态常态：signals-latest 不得带 active_track（零 diff 纪律）
    assert.ok(!('active_track' in sig), 'A 态常态：signals-latest 不得带 active_track（零 diff 纪律）');
  } else {
    // A_fallback 态（真实回滚/演练后）：镜像必须在场（自愈已收口双处间隙）
    assert.equal(sig.active_track, 'A_fallback', 'A_fallback 态：signals 镜像必须在场（paper_dual_track 自愈）');
    assert.ok(typeof sig.activeTrackNote === 'string' && sig.activeTrackNote.includes('回滚于'), 'A_fallback 态：note 六要素在场');
  }
  // state 在场（无论何态）→ 一致性守卫必须零违例
  if (st) assert.deepEqual(crossCheckTrackMirror(st, sig), []);
});

// ── ⑤ P2-β 渲染接线（2026-10-06）：dualTrack 披露块契约 + 账本档契约化 + 一致性 ──
//   用真实契约（schemas/signals-latest.schema.json dualTrack 段 / dual-track-latest.schema.json）
//   与 check_contract.mjs 的 crossCheckDualTrack 纯函数做负向演练——守卫的守卫。

const DT_DAY_FIXTURE = {
  date: '2026-09-30', score: 64.41,
  regime: { key: 'recover', label: '回暖', cap: 0.5, reasons: [], note: null },
  trackA: { targetPos: { '上证指数': 0.7 }, poolPos: 0.5, executed: true },
  trackB: { refPos: { '上证指数': 0.3 }, poolPos: 0.3, executed: false },
  divergence: { posGap: 0.2, note: '分歧 = 保险当日保费敞口' },
  trackC: { active: false, shadowPos: { '0.3': 0.5, '0.4': 0.5, '0.5': 0.55 }, biting: { '0.3': false, '0.4': false, '0.5': false } },
  dayReturns: { A: 0.00017, B: -0.00013, 'C0.3': 0.00017, 'C0.4': 0.00017, 'C0.5': 0.000115 },
  ledger: { since: '2025-10-09', premiumCum: 0.019825, coverageCum: 0.049531, shadowCum: { '0.3': 0.008231, '0.4': 0.015235, '0.5': 0.026977 }, episodes: { '0.3': 18, '0.4': 18, '0.5': 18 }, activeDays: 18 },
};
// summary 审计面 fixture（cum 搬运源）：与真实账本 summary.total 面同构
const DT_SUMMARY_FIXTURE = {
  trackA: { total: -0.015005, maxDd: 0.137886, sharpe: -0.028276 },
  trackB: { total: -0.03483, maxDd: 0.087774, sharpe: -0.447687 },
  trackC: {
    '0.3': { total: -0.006774, maxDd: 0.140282, sharpe: 0.022479, episodes: 18, shadowCumEnd: 0.008231 },
    '0.4': { total: 0.00023, maxDd: 0.13608, sharpe: 0.07465, episodes: 18, shadowCumEnd: 0.015235 },
    '0.5': { total: 0.012027, maxDd: 0.126739, sharpe: 0.158681, episodes: 18, shadowCumEnd: 0.026977 },
  },
};

test('P2-β渲染：signals.dualTrack 段契约（null=未生成 / 段内 required 齐 / 半缺拦）', () => {
  const schema = load('schemas/signals-latest.schema.json');
  assert.ok(schema.required.includes('dualTrack'), 'dualTrack 必须 required（渲染面已消费，P2-β 渲染接线）');
  assert.ok(schema.required.includes('dualTrackNote'));
  const dt = schema.properties.dualTrack;
  const okBlock = {
    asOf: '2026-09-30', generatedAt: 't',
    // day 全量镜像（含 dayReturns——用户规格「当日净值」搬运面，36KB 预算重估后恢复）
    day: DT_DAY_FIXTURE,
    // cum：summary.total 面搬运（提取逻辑唯一出处 cumFromSummary）
    cum: cumFromSummary(DT_SUMMARY_FIXTURE),
    trackState: { activeTrack: 'A', paramsSource: 'config.json params.train' },
    note: '轨道 B/C 为风控参考，不是买卖信号',
  };
  assert.equal(validateContract(okBlock, dt).length, 0, '合法披露块必须过（含 day 全段 + cum）');
  assert.equal(validateContract(null, dt).length, 0, 'null=未生成是合法态（≠轨道一致）');
  // 半缺最危险形态：day 段缺 trackC（渲染静默空白类事故）
  const halfErrs = validateContract({ ...okBlock, day: { ...DT_DAY_FIXTURE, trackC: undefined } }, dt);
  assert.equal(halfErrs.length, 1, 'day 半缺必须被拦（trackC 是影子披露核心，漏了面板少一轨）');
  // cum 缺段：用户规格「累计收益」是必搬运面（渲染列已消费——缺段=旧档/白名单漂移）
  assert.equal(validateContract({ ...okBlock, cum: undefined }, dt).length, 1, 'cum 必须 required（累计收益列已消费）');
  // trackState.activeTrack 枚举（A | A_fallback；'A' 在此段是合法显式值——账本态枚举，
  //   与顶层 active_track 镜像的「缺席=A」语义不同：本段是搬运不是镜像）
  assert.equal(validateContract({ ...okBlock, trackState: { activeTrack: 'B', paramsSource: 'x' } }, dt).length, 1);
  // trackB.executed const false：参考线永不执行——写 true = 执行面口径事故
  assert.equal(validateContract({ ...okBlock, day: { ...DT_DAY_FIXTURE, trackB: { ...DT_DAY_FIXTURE.trackB, executed: true } } }, dt).length, 1);
});

test('P2-β渲染：cumFromSummary 提取（唯一出处：total 面 / summary 缺席全 null / 半缺容错）', () => {
  // 全量 summary → total 面
  assert.deepEqual(cumFromSummary(DT_SUMMARY_FIXTURE), {
    trackA: -0.015005, trackB: -0.03483,
    trackC: { '0.3': -0.006774, '0.4': 0.00023, '0.5': 0.012027 },
  });
  // summary 缺席（审计面 optional）→ 全 null / null——未生成语义，绝不补 0
  assert.deepEqual(cumFromSummary(null), { trackA: null, trackB: null, trackC: null });
  assert.deepEqual(cumFromSummary(undefined), { trackA: null, trackB: null, trackC: null });
  // 半缺容错：trackC 缺 '0.5' 线 → 该位 null（其余照搬——缺一线不拖垮整块）
  assert.deepEqual(cumFromSummary({ trackA: { total: 0.1 }, trackC: { '0.3': { total: 0.2 } } }),
    { trackA: 0.1, trackB: null, trackC: { '0.3': 0.2, '0.4': null, '0.5': null } });
});

test('P2-β渲染：账本档契约 dual-track-latest.schema.json（双轨账本结构化）', () => {
  const schema = load('schemas/dual-track-latest.schema.json');
  const okLatest = {
    tool: 'paper_dual_track', generatedAt: 't',
    trackState: { activeTrack: 'A', paramsSource: 'config.json params.train', fallback: null, note: 'n' },
    sample: { from: '2025-10-09', to: '2026-09-30', days: 241 },
    day: DT_DAY_FIXTURE,
    summary: DT_SUMMARY_FIXTURE,
  };
  assert.equal(validateContract(okLatest, schema).length, 0, '合法账本必须过（gates/summary/notes optional——门禁失败时账本仍可写出供尸检）');
  // day 半缺：ledger 是 required（披露块的搬运源，漏了保险账本静默消失）
  assert.equal(validateContract({ ...okLatest, day: { ...DT_DAY_FIXTURE, ledger: undefined } }, schema).length, 1);
  // tool const：非 paper_dual_track 产物冒充账本
  assert.equal(validateContract({ ...okLatest, tool: 'other' }, schema).length, 1);
});

test('P2-β渲染：跨档一致性守卫（crossCheckDualTrack 纯函数负向演练）', () => {
  const latest = {
    tool: 'paper_dual_track', generatedAt: 't',
    trackState: { activeTrack: 'A', paramsSource: 'config.json params.train' },
    day: DT_DAY_FIXTURE,
    summary: DT_SUMMARY_FIXTURE,
  };
  const okSig = {
    dualTrack: {
      asOf: DT_DAY_FIXTURE.date, generatedAt: 't',
      day: DT_DAY_FIXTURE,
      cum: cumFromSummary(DT_SUMMARY_FIXTURE),
      trackState: { activeTrack: 'A', paramsSource: 'config.json params.train' },
      note: 'n',
    },
  };
  // 合法态零违例（账本在场 + 披露块逐字段一致，含 dayReturns/cum）
  assert.deepEqual(crossCheckDualTrack(latest, okSig), []);
  // 账本在场但披露块缺席（写盘路径未注入/未重跑——真事故形态）
  assert.equal(crossCheckDualTrack(latest, {}).length, 1);
  // 披露块 day 与账本不一致（R4 口径分裂：报告说 A、算的是 B）——含 dayReturns 剔除的旧形态
  assert.equal(crossCheckDualTrack(latest, { dualTrack: { ...okSig.dualTrack, day: (({ dayReturns, ...rest }) => rest)(DT_DAY_FIXTURE) } }).length, 1,
    'dayReturns 缺席（旧搬运白名单）也必须红——全量镜像无白名单例外');
  assert.equal(crossCheckDualTrack(latest, { dualTrack: { ...okSig.dualTrack, day: { ...DT_DAY_FIXTURE, divergence: { posGap: 0.5, note: 'x' } } } }).length, 1);
  // cum 不一致（累计收益搬运失真——含缺 cum 段的旧档形态）
  assert.equal(crossCheckDualTrack(latest, { dualTrack: { ...okSig.dualTrack, cum: undefined } }).length, 1, '缺 cum 段必须红');
  assert.equal(crossCheckDualTrack(latest, { dualTrack: { ...okSig.dualTrack, cum: { ...okSig.dualTrack.cum, trackA: 0.99 } } }).length, 1, 'cum 数值漂移必须红');
  // asOf 与账本末日不符（伪装成"今日"的滞后披露）
  assert.equal(crossCheckDualTrack(latest, { dualTrack: { ...okSig.dualTrack, asOf: '2026-10-06' } }).length, 1);
  // trackState 分裂（披露块说 A、账本说 A_fallback）
  assert.equal(crossCheckDualTrack(latest, { dualTrack: { ...okSig.dualTrack, trackState: { activeTrack: 'A_fallback', paramsSource: 'x' } } }).length, 1);
  // 账本缺席但披露块在场（凭空披露）
  assert.equal(crossCheckDualTrack(null, okSig).length, 1);
  // 双双缺席 = 合法态（首日前无账本无披露，optionlReason 放行）
  assert.deepEqual(crossCheckDualTrack(null, {}), []);
  // summary 缺席（审计面 optional）→ cum 期望全 null：披露块 cum 非 null = 搬运失真
  const noSum = { ...latest, summary: null };
  assert.equal(crossCheckDualTrack(noSum, okSig).length, 1, 'summary 缺席时 cum 必须全 null（未生成 ≠ 累计为零）');
  assert.deepEqual(crossCheckDualTrack(noSum, { dualTrack: { ...okSig.dualTrack, cum: cumFromSummary(null) } }), []);
});

test('P2-β渲染：磁盘态一致性锚定（账本在场 → 披露块必须在场且逐字段一致）', () => {
  const ltPath = join(ROOT, 'data', 'paper', 'dual_track_latest.json');
  const sig = load('data/signals-latest.json');
  if (!existsSync(ltPath)) return; // 首日前无账本属设计（optionalReason 放行）
  const lt = JSON.parse(readFileSync(ltPath, 'utf8'));
  assert.deepEqual(crossCheckDualTrack(lt, sig), [], '账本在场：披露块必须逐字段一致（R4 常驻拦截）');
});

// ── ⑥ P3 应急联系人（2026-10-06 确认）：契约 + 告警 @ 链（buildPushPayload 纯函数）──
//   起因：用户宣告「配置已生成 + 通道自动 @」但磁盘无档、通道无 @ 逻辑——纸面闭环。
//   本组测试锁死三件事：档在盘且过契约、phone 格式即 @ 链、payload @ primary + 值班链文案。

test('P3 应急联系人：磁盘档契约锚定（primary/secondary 齐 / phone 格式 / 半缺拦）', () => {
  const schema = load('schemas/emergency-contacts.schema.json');
  // 磁盘档必须在场且过契约（P3 已确认 → required，缺席=门禁红 + 此处 assert 炸）
  const ok = load('config/emergency_contacts.json');
  assert.equal(validateContract(ok, schema).length, 0, '磁盘配置必须过契约（P3 宣告确认后 required）');
  // 半缺：primary 缺 phone → 红（@ 链断裂是静默事故）
  const { phone, ...noPhone } = ok.primary;
  assert.equal(validateContract({ ...ok, primary: noPhone }, schema).length, 1, 'primary.phone 必须 required');
  // phone 格式：非 11 位大陆号 → 红（企微 mentioned_mobile_list 按手机号 @，格式错=不 @）
  assert.equal(validateContract({ ...ok, primary: { ...ok.primary, phone: '12345' } }, schema).length, 1, 'phone 格式必须锁死');
  // secondary 缺席 → 红（30 分钟升级链断裂）
  assert.equal(validateContract({ primary: ok.primary }, schema).length, 1, 'secondary 必须 required（升级链）');
});

test('P3 应急联系人：告警 payload @ 链（buildPushPayload 纯函数负向演练）', () => {
  const contacts = load('config/emergency_contacts.json');
  const ev = { kind: 'track_rollback', source: 'rollback_track.mjs', detail: '触发 T4 · why 原文', at: '2026-10-06T00:00:00Z' };
  // contacts 在场 → @ primary.phone + 值班链文案（primary + 30 分钟升级 secondary）
  const p1 = buildPushPayload(ev, contacts);
  assert.deepEqual(p1.text.mentioned_mobile_list, [contacts.primary.phone], 'error 推送必须 @ primary');
  assert.ok(p1.text.content.includes('值班：'), '推送内容须带值班链');
  assert.ok(p1.text.content.includes('30 分钟无响应'), '推送内容须带升级提示（secondary 接管）');
  assert.ok(p1.text.content.includes('T4'), '推送内容须含事件 detail（触发编号）');
  // contacts 缺席 → 降级不 @（无 mentioned 字段）但内容照常——不静默吞事件
  const p2 = buildPushPayload(ev, null);
  assert.equal(p2.text.mentioned_mobile_list, undefined, '缺联系人 → 无 @ 字段（降级）');
  assert.ok(p2.text.content.includes('ERROR') && p2.text.content.includes('T4'), '降级仍推事件本体');
  // 超长 detail → 截断到 2000（企微 text 上限）
  const longEv = { ...ev, detail: 'x'.repeat(3000) };
  const p3 = buildPushPayload(longEv, contacts);
  assert.ok(p3.text.content.length <= 2001, `截断后 ≤2000+省略号（实际 ${p3.text.content.length}）`);
});

// ── ⑦ 回滚横幅六要素（E2E 终测 2026-10-05 抓出传参缺口后收口）：文案唯一出处
//   src/dual_track.js::buildTrackNote——rollback_track 写入与 paper_dual_track 自愈
//   必须逐字一致（双模板漂移 = 回滚时六要素、自愈后剩四要素的实录事故形态）。
test('回滚横幅：buildTrackNote 六要素 + 双消费端逐字一致（防模板漂移）', () => {
  const fb = { since: '2026-10-05T18:40:30Z', effectiveDate: '2026-10-08', trigger: 'T1', why: '单日亏损>5%' };
  const note = buildTrackNote(fb, 'bd77fed');
  // 六要素逐项在场（快照 commit / 回滚时刻 / 生效日 / 触发编号 / 原因 / 事实源指引）
  for (const s of ['bd77fed', '2026-10-05T18:40:30Z', '2026-10-08', 'T1', '单日亏损>5%', 'data/paper/track_state.json']) {
    assert.ok(note.includes(s), `六要素缺项：${s}`);
  }
  // 缺席兜底：fallback 半缺 → [未记录]/[待确认] 显式标注（不是静默空白）
  const bare = buildTrackNote({ trigger: 'T4' }, 'bd77fed');
  assert.ok(bare.includes('[未记录]') && bare.includes('[待确认]'), '缺席要素必须显式兜底标注');
  assert.ok(bare.includes('T4'), '在场要素照常渲染');
  // 全缺席 → 不炸
  assert.ok(buildTrackNote(null, null).includes('[未记录]'));
});
