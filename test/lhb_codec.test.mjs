// lhb_codec：两级序列化（reason 码表压缩 + 惰性字段提子）
//
// 这两件事都在**存储/传输层**，共同的不变量只有一个：**往返无损**。
// 一旦有损，最先坏掉的不是展示，而是口径——RANGE_BOARD_RE / NEW_STOCK_RE 靠中文原文
// 做正则匹配，解不回来就会把「区间累计榜」当「当日榜」，区间值混进日度因子。
// 故本文件的核心断言是"decode(encode(x)) 与 x 逐字段等价"，且必须用**键序无关**比较
// （JSON 对象键序不承载语义，逐字符串比会假失败）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReasonCodes, encodeDay, decodeDay, encodeArchive, decodeArchive,
  deflateDay, inflateDay, pickDay, pendingFields, SUBSCRIBE_FIELDS, compressionStats,
  writeArchiveSafely, readArchiveForEdit, appendNote, dedupeNote, writeJsonStable,
} from '../src/lhb_codec.js';

/** 键序无关的深比较（数组顺序仍然敏感——顺序承载语义，如 rc 下标序列）。 */
function norm(o) {
  return JSON.stringify(o, (k, v) => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((a, kk) => { a[kk] = v[kk]; return a; }, {});
    }
    return v;
  });
}

// 真实形状的一天（含 summary.seats 与未去重的 lhb，两块惰性字段）
function mkDay(date, reason) {
  return {
    trade_date: date,
    lhb: [{ code: '001246', name: '力勤资源', reason, reasons: [reason], close: 65.09, is_range: false }],
    lhb_aggr: [{ code: '001246', name: '力勤资源', net_buy_wan: 50412.7, close: 65.09, caliber: 'daily' }],
    hot: [{ code: '001246', name: '力勤资源', change_pct: 206.59, close: 65.09 }],
    topics: { 锂电: 3 },
    industry: [{ name: '有色', chg: 2.1 }],
    summary: {
      zt_count: 52, dt_count: 3, seal_pct: 81.3, lhb_daily_net: 136.5,
      seats: { cover: 88, detail: { '001246': { b: [['某营业部', 12345]], s: [] } }, conc_top: [['001246', 12.3]] },
    },
    emotion: { value: 61.2, pct_rank: 72, factors: { s_net: 0.4 }, breadth_bias: 12 },
  };
}

const CODES = ['无价格涨跌幅限制的证券', '连续三个交易日内，涨幅偏离值累计达到20%的证券', '日涨幅偏离值达到7%的前5只证券'];
const mkArc = () => ({ meta: { tradeDate: '2026-09-30' }, signals: { version: '5.2' }, all_days: [mkDay('2026-09-29', CODES[1]), mkDay('2026-09-30', CODES[0])] });

// ────────────────────────── 码表 ──────────────────────────

test('codec: 码表收集全档唯一原因且排序稳定（同输入必得同码表）', () => {
  const days = mkArc().all_days;
  const a = buildReasonCodes(days);
  const b = buildReasonCodes(days.slice().reverse()); // 顺序变了
  assert.deepEqual(a, b, '码表必须与输入顺序无关');
  assert.deepEqual(a, [...a].sort(), '码表必须有序');
  assert.equal(new Set(a).size, a.length, '码表不得有重复');
  assert.equal(a.length, 2, '两天各一个唯一原因');
});

test('codec: encode/decode 往返无损（单条）', () => {
  const day = mkDay('2026-09-30', CODES[0]);
  const codes = buildReasonCodes([day]);
  const enc = encodeDay(day, codes);
  const l = enc.lhb[0];
  assert.ok(Array.isArray(l.rc), '压缩后应有 rc 下标数组');
  assert.equal(l.reason, undefined, '压缩后不应保留 reason 文本');
  assert.equal(l.reasons, undefined, '压缩后不应保留 reasons 文本');
  const back = decodeDay(enc, codes);
  assert.equal(back.lhb[0].reason, CODES[0]);
  assert.deepEqual(back.lhb[0].reasons, [CODES[0]]);
  assert.equal(norm(back.lhb), norm(day.lhb), '往返后 lhb 必须逐字段等价');
});

test('codec: 同票多原因（reasons 数组）往返保持顺序与去重语义', () => {
  const day = mkDay('2026-09-30', CODES[0]);
  day.lhb[0].reasons = [CODES[2], CODES[0], CODES[2]]; // 含重复
  day.lhb[0].reason = CODES[2]; // reason 是 reasons[0]
  const codes = buildReasonCodes([day]);
  const back = decodeDay(encodeDay(day, codes), codes);
  assert.deepEqual(back.lhb[0].reasons, [CODES[2], CODES[0]], 'rc 必须唯一化但保持首次出现顺序');
  assert.equal(back.lhb[0].reason, CODES[2], 'reason 必须还原为 reasons 首条');
});

test('codec: encodeDay 幂等（已压缩的记录原样返回，不会二次压缩丢数据）', () => {
  const day = mkDay('2026-09-30', CODES[0]);
  const codes = buildReasonCodes([day]);
  const once = encodeDay(day, codes);
  const twice = encodeDay(once, codes);
  assert.equal(norm(twice), norm(once), '二次压缩必须与一次等价');
});

test('codec: 未压缩的存量档 decode 原样返回（向后兼容）', () => {
  const day = mkDay('2026-09-30', CODES[0]); // 明文，无 rc
  const codes = buildReasonCodes([day]);
  assert.equal(norm(decodeDay(day, codes)), norm(day), '明文档解码不得改动任何字段');
});

test('codec: 无码表的档整体 decode 原样返回（存量主档兼容）', () => {
  const arc = mkArc();
  assert.equal(norm(decodeArchive(arc)), norm(arc), 'meta 无 reasonCodes 时不得改动');
});

// ────────────────────────── 惰性字段提子 ──────────────────────────

test('codec: deflateDay 把 lhb 提到 _sub，并从顶层移除；seats 必须留在原地', () => {
  const d = deflateDay(mkDay('2026-09-30', CODES[0]));
  assert.deepEqual(Object.keys(d._sub), ['lhb']);
  assert.equal(d.lhb, undefined, 'lhb 必须离开顶层');
  assert.equal(d.lhb_aggr.length, 1, 'lhb_aggr 不是惰性字段，必须留在顶层');
  // ⚠ 这条是**回归守卫**：seats 曾被提走，导致研判报告的「席位分项/锁仓统计」
  //   在首屏静默消失（if (seats && seats.cover) 直接跳过），用户只看到"报告少了结论"。
  //   判定惰性字段的标准是"首屏渲染是否用到"，不是"大不大"。
  assert.ok(d.summary.seats, 'summary.seats 必须留在原地（研判报告首屏要用）');
  assert.equal(d.summary._seatsUnloaded, undefined, '不得出现未加载标记（它已不是惰性字段）');
  assert.equal(d.summary.zt_count, 52, '同层其它字段不得受影响');
});

test('codec: 提子后 inflateDay 能完全归位', () => {
  const src = mkDay('2026-09-30', CODES[0]);
  const back = inflateDay(deflateDay(src));
  assert.equal(norm(back), norm(src), '提子→归位必须无损');
});

test('codec: 无惰性字段的天不产生 _sub（不留空壳）', () => {
  const bare = { trade_date: '2026-09-30', hot: [], lhb_aggr: [] };
  assert.equal(deflateDay(bare)._sub, undefined);
  assert.equal(norm(inflateDay(bare)), norm(bare));
});

test('codec: pickDay 只还原指定字段，其余仍在 _sub（按需取，不全解）', () => {
  // 用两个字段的场景验证 pickDay 的选择性（当前 SUBSCRIBE_FIELDS 只有 lhb，
  // 故这里直接构造带两个键的 _sub，检验"只取指定的那个"这一语义本身）
  const d = { trade_date: '2026-09-30', hot: [], _sub: { lhb: [{ code: 'x' }] } };
  const only = pickDay(d, ['lhb']);
  assert.ok(only.lhb.length, 'lhb 应已还原');
  assert.equal(only._sub, undefined, '取完不得残留空 _sub');
  assert.equal(pickDay(d, [])._sub.lhb.length, 1, '未指定字段时应原样返回（lhb 仍在 _sub）');
  assert.equal(pendingFields(d).length, 1);
  assert.equal(pendingFields(only).length, 0);
});

// ────────────────────────── 整档：码表（默认）与提子（可选）──────────────────────────

// ⚠ 设计变更留痕：`encodeArchive` 默认**只做码表压缩**，不再默认提子。
//   原因（实测）：提子对主档体积零收益（`lhb` → `_sub.lhb` 只是改名，多 7 字节/天），
//   却让 `day.lhb` 变成 `day._sub.lhb`，任何读者都得先 inflate。默认关闭 = 少一层间接。
//   需要把某字段挡在首屏之外的地方（切片滚动窗）显式传 `{ deflate: true }`。
test('codec: encodeArchive 默认只压码表、不提子（lhb 仍在顶层）', () => {
  const arc = mkArc();
  const codes = buildReasonCodes(arc.all_days);
  const packed = JSON.parse(JSON.stringify(encodeArchive(arc, codes)));
  assert.equal(packed.meta.reasonEncoding, 'rc-v1');
  assert.ok(Array.isArray(packed.meta.reasonCodes) && packed.meta.reasonCodes.length === 2);
  // 默认态：lhb 在顶层，且已是 rc；不应出现 _sub
  assert.ok(Array.isArray(packed.all_days[0].lhb), '默认态 lhb 必须留在顶层（审计要读）');
  assert.ok(packed.all_days[0].lhb[0].rc.length, 'lhb 里应是 rc 下标数组');
  assert.equal(packed.all_days[0].lhb[0].reason, undefined, 'rc 态不得残留 reason 文本');
  assert.equal(packed.all_days[0]._sub, undefined, '默认态不得凭空产生 _sub');
  assert.ok(packed.all_days[0].summary.seats.detail, 'seats 不是惰性字段，必须内联');
  // 往返
  const back = decodeArchive(packed);
  assert.equal(norm(back.all_days), norm(arc.all_days), '整档往返必须逐字段等价');
  assert.equal(back.all_days[1].lhb[0].reason, CODES[0], 'reason 文本必须还原');
  assert.ok(back.all_days[1].summary.seats.detail, '席位明细必须还原到 summary.seats');
});

test('codec: encodeArchive({deflate:true}) 才提子，且往返仍无损', () => {
  const arc = mkArc();
  const codes = buildReasonCodes(arc.all_days);
  const packed = JSON.parse(JSON.stringify(encodeArchive(arc, codes, { deflate: true })));
  assert.equal(packed.all_days[0].lhb, undefined, '提子后 lhb 不得留在顶层');
  assert.ok(packed.all_days[0]._sub.lhb[0].rc.length, '_sub.lhb 里应是 rc 下标数组');
  assert.equal(packed.all_days[0]._sub.lhb[0].reason, undefined, 'rc 态不得残留 reason 文本');
  const back = decodeArchive(packed);
  assert.equal(norm(back.all_days), norm(arc.all_days), '提子态往返必须逐字段等价');
  assert.equal(back.all_days[1]._sub, undefined, '全解后不得残留 _sub');
});

test('codec: 提子对体积零收益（防后人把它当省钱手段）', () => {
  // 这条是**负面知识**的守卫：提子看起来像"把大字段搬走"，实际只是改名。
  // 体积必须由码表那一级负责；提子只服务于"切片里不出现某字段"这个结构目的。
  const arc = mkArc();
  const codes = buildReasonCodes(arc.all_days);
  const plain = JSON.stringify(encodeArchive(arc, codes));
  const deflated = JSON.stringify(encodeArchive(arc, codes, { deflate: true }));
  const delta = deflated.length - plain.length;
  // 只允许多出 _sub 包装的少量字节（每天 ~7 字节），绝不允许体积下降——
  // 若哪天真下降了，说明 deflateDay 被改成了"真删除"，那会破坏审计完整性，必须人工复核。
  assert.ok(delta > 0, `提子不得让体积下降（说明字段真被删了，会破坏审计输入）；实得 ${delta} 字节`);
  assert.ok(delta < 64, `提子开销应仅为 _sub 包装（<64 字节），实得 ${delta}`);
});

test('codec: 码表压缩确实省体积（否则这层是白做的）', () => {
  const arc = mkArc();
  const st = compressionStats(arc);
  assert.ok(st.codes > 0);
  assert.ok(st.savedRatio > 0.4, `长中文原因文本压缩率应 >40%，实得 ${(st.savedRatio * 100).toFixed(1)}%`);
  assert.ok(st.after < st.before);
});

test('codec: 口径正则依赖的原因文本在往返后仍可匹配（不是只对长度负责）', () => {
  // 这两条正则的失配后果最严重：区间榜会被当当日榜，区间累计值混进日度因子
  const RANGE_BOARD_RE = /连续\s*[0-9一二三四五六七八九十]+\s*个交易日|严重异常期间/;
  const NEW_STOCK_RE = /无价格涨跌幅限制/;
  const arc = mkArc();
  const codes = buildReasonCodes(arc.all_days);
  const back = decodeArchive(JSON.parse(JSON.stringify(encodeArchive(arc, codes))));
  const r0 = back.all_days[0].lhb[0].reason;
  const r1 = back.all_days[1].lhb[0].reason;
  assert.ok(RANGE_BOARD_RE.test(r0), '区间榜原因必须仍能匹配 RANGE_BOARD_RE');
  assert.ok(NEW_STOCK_RE.test(r1), '新股原因必须仍能匹配 NEW_STOCK_RE');
  assert.ok(!RANGE_BOARD_RE.test(r1), '反向：新股原因不得被误判为区间榜');
});

// ────────────────── 落盘助手：writeArchiveSafely / readArchiveForEdit ──────────────────
// 这一组守的是**最容易造成静默坏档**的那条路径：脚本读主档 → 改一点 → 写回。
// 若写回时忘了重编码，档里记录仍是 rc 下标而码表语义对不上，解码会整体回退成
// reasons:[undefined]，表现是 reason 全变占位符 + RANGE_BOARD_RE 静默失配
// （区间累计榜被当当日榜）。本项目已发生过一次同类事故，故助手带写前自检。

test('落盘：readArchiveForEdit 返回明文态（reason 可读，不是 rc 下标）', () => {
  const fs = { readFileSync: () => JSON.stringify(encodeArchive(mkArc(), buildReasonCodes(mkArc().all_days))) };
  const a = readArchiveForEdit('ignored.json', fs.readFileSync);
  assert.ok(a.all_days.length === 2);
  for (const d of a.all_days) {
    for (const l of d.lhb || []) {
      assert.equal(typeof l.reason, 'string', 'reason 必须是字符串');
      assert.ok(l.reason.length > 0, 'reason 不得为空');
      assert.equal(l.rc, undefined, '明文态不应残留 rc');
    }
  }
});

test('落盘：writeArchiveSafely 写出的是紧凑压缩态（不是明文、不是缩进）', () => {
  const written = [];
  const fsMod = { writeFileSync: (p, text) => written.push({ p, text }) };
  const arc = mkArc();
  const info = writeArchiveSafely('ignored.json', arc, fsMod);
  assert.equal(written.length, 1);
  const text = written[0].text;
  // 紧凑：不得有换行缩进
  assert.ok(!/\n\s{2}"/.test(text), '写出的 JSON 不得带缩进（缩进会白吃压缩收益）');
  // 压缩态：记录里应是 rc 而非明文 reasons
  const parsed = JSON.parse(text);
  const recs = parsed.all_days.flatMap((d) => [...(d.lhb || []), ...((d._sub && d._sub.lhb) || [])]);
  assert.ok(recs.length > 0, '应写出 lhb 记录');
  assert.ok(recs.every((r) => Array.isArray(r.rc)), '记录必须是 rc 码表态');
  assert.ok(parsed.meta.reasonCodes.length > 0, '必须带 meta.reasonCodes');
  assert.equal(info.codes, parsed.meta.reasonCodes.length);
  assert.equal(info.days, arc.all_days.length);
});

test('落盘：writeArchiveSafely 写出的档可被 decodeArchive 完整还原（往返闭环）', () => {
  const written = [];
  const fsMod = { writeFileSync: (p, text) => written.push(text) };
  const arc = mkArc();
  writeArchiveSafely('ignored.json', arc, fsMod);
  const back = decodeArchive(JSON.parse(written[0]));
  assert.equal(norm(back.all_days), norm(arc.all_days), '写盘→读回必须逐字段等价');
});

test('落盘：往返不一致时拒绝写盘（不得静默落坏档）', () => {
  const written = [];
  const fsMod = { writeFileSync: (p, text) => written.push(text) };
  // 构造"原因文本会丢失"的档：reason 不是能进码表的字符串。
  // ⚠ 注意判据必须是"查出**占位符**"，不能只查"是不是字符串"——
  //   decodeDay 在 rc 解析失败时恰好写 '—'（字符串！），类型检查会永远通过。
  //   这正是本条自检存在的意义：那种坏档一旦落盘，RANGE_BOARD_RE 会静默失配。
  const bad = mkArc();
  bad.all_days[0].lhb[0] = { code: 'X', reason: { z: 1 } };
  assert.throws(() => writeArchiveSafely('ignored.json', bad, fsMod), (e) => {
    assert.equal(e.code, 'ROUNDTRIP_MISMATCH');
    return true;
  }, '往返不一致必须抛错');
  assert.equal(written.length, 0, '抛错时绝不能已经写盘');
});

test('落盘：正常档不得被自检误拦（否则脚本会整体不可用）', () => {
  const written = [];
  const fsMod = { writeFileSync: (p, text) => written.push(text) };
  assert.doesNotThrow(() => writeArchiveSafely('ignored.json', mkArc(), fsMod));
  assert.equal(written.length, 1);
});

// ────────────────────── note 留痕（appendNote / dedupeNote）──────────────────────
// 背景：多个回填脚本各自拼接 meta.note，历史上出现整段重复 ×2。收敛后的不变量：
//   ① 同签名段只保留最新一次（重跑不堆叠）；② 不同内容段不误伤；③ 存量去重幂等。

test('note：appendNote 同签名段替换不堆叠（重跑只更新日期）', () => {
  const arc = {};
  const a1 = appendNote(arc, '六因子历史回填 2026-10-02：208 个回填天的池重建，误差零。');
  arc.meta.note = a1;
  // 重跑：日期与计数变了，其余文案相同 → 替换而非追加
  const a2 = appendNote(arc, '六因子历史回填 2026-10-05：211 个回填天的池重建，误差零。');
  const segs = a2.split('；').filter(Boolean);
  assert.equal(segs.length, 1, '同签名段必须替换而非堆叠');
  assert.ok(a2.includes('2026-10-05'), '保留的是最新一次留痕');
  assert.ok(!a2.includes('2026-10-02'), '旧日期段被替换掉');
});

test('note：appendNote 不同内容段各自保留（不误伤）', () => {
  const arc = {};
  arc.meta = { note: '板块相对强弱已于 2026-10-01 对存量档回填；口径见 src/relative.js。' };
  const out = appendNote(arc, '龙虎榜双口径全档重算：当日榜口径写入 lhb_daily_*。');
  const segs = out.split('；').filter(Boolean);
  assert.equal(segs.length, 3, '两段原文 + 一段新增');
  assert.ok(out.includes('板块相对强弱') && out.includes('龙虎榜双口径'), '两段都在');
});

test('note：dedupeNote 精确重复段去重且幂等', () => {
  const note = '段甲；段乙；段甲；段丙；段乙';
  const once = dedupeNote(note);
  assert.equal(once, '段甲；段乙；段丙', '重复段去重、保序');
  assert.equal(dedupeNote(once), once, '幂等：再跑不变');
});

// ────────────────────── 稳定写盘（writeJsonStable）──────────────────────────────
// 不变量：剥掉时间戳键后内容未变 → 不写盘（文件保留旧 generatedAt，语义=真实生成时刻）；
// 内容真变 → 必写。fs 用假实现注入（与 writeArchiveSafely 测试同一手法）。

function fakeFs(initial) {
  const files = { ...initial };
  return {
    files,
    fsMod: {
      readFileSync: (p) => { if (!(p in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files[p]; },
      writeFileSync: (p, text) => { files[p] = text; },
    },
  };
}

test('稳定写盘：内容未变（剥时间戳）则跳过，不产生纯时间戳 diff', () => {
  const old = { meta: { generatedAt: '2026-10-05T01:00:00Z', total: 5 }, rows: [1, 2] };
  const { fsMod, files } = fakeFs({ 'u.json': JSON.stringify(old) });
  const fresh = { meta: { generatedAt: '2026-10-06T09:00:00Z', total: 5 }, rows: [1, 2] };
  const r = writeJsonStable('u.json', fresh, fsMod);
  assert.equal(r.skipped, true, '剥时间戳后等价 → 跳过');
  assert.equal(JSON.parse(files['u.json']).meta.generatedAt, '2026-10-05T01:00:00Z', '磁盘保留旧时间戳');
});

test('稳定写盘：内容真变则必写（不会误跳）', () => {
  const old = { meta: { generatedAt: '2026-10-05T01:00:00Z', total: 5 }, rows: [1, 2] };
  const { fsMod, files } = fakeFs({ 'u.json': JSON.stringify(old) });
  const changed = { meta: { generatedAt: '2026-10-06T09:00:00Z', total: 6 }, rows: [1, 2] };
  const r = writeJsonStable('u.json', changed, fsMod);
  assert.equal(r.skipped, false);
  assert.equal(JSON.parse(files['u.json']).meta.total, 6, '新内容已落盘');
});

test('稳定写盘：磁盘无旧档照常写（首次生成）', () => {
  const { fsMod, files } = fakeFs({});
  const r = writeJsonStable('new.json', { meta: { generatedAt: 'now', v: 1 } }, fsMod);
  assert.equal(r.skipped, false);
  assert.ok(files['new.json'], '新档已写');
});

test('稳定写盘：compact 态无缩进（大档体积纪律）', () => {
  const { fsMod, files } = fakeFs({});
  writeJsonStable('u.json', { meta: { generatedAt: 'now', total: 5 }, rows: [1] }, { ...fsMod, compact: true });
  assert.ok(!/\n\s{2}"/.test(files['u.json']), '紧凑态不得带缩进');
});

// ── 原子写（H-4 · 2026-10-07）：注入 renameSync 时必须走 tmp→rename，失败必清理 ──

test('原子写：writeJsonStable 注入 renameSync 时走 tmp→rename（目标文件无中间态）', () => {
  const calls = [];
  const files = {};
  const fsMod = {
    readFileSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    writeFileSync: (p, t) => { calls.push(['write', p]); files[p] = t; },
    renameSync: (a, b) => { calls.push(['rename', a, b]); files[b] = files[a]; delete files[a]; },
    unlinkSync: (p) => { calls.push(['unlink', p]); delete files[p]; },
  };
  const r = writeJsonStable('u.json', { meta: { generatedAt: 'now', v: 1 } }, fsMod);
  assert.equal(r.skipped, false);
  assert.deepEqual(calls, [['write', 'u.json.tmp'], ['rename', 'u.json.tmp', 'u.json']], '必须是「写 tmp → 原子替换」两步');
  assert.ok(files['u.json'], '目标已落盘');
  assert.ok(!files['u.json.tmp'], '无 tmp 残留');
});

test('原子写：writeArchiveSafely 注入 renameSync 时走 tmp→rename', () => {
  const calls = [];
  const files = {};
  const fsMod = {
    writeFileSync: (p, t) => { calls.push(['write', p]); files[p] = t; },
    renameSync: (a, b) => { calls.push(['rename', a, b]); files[b] = files[a]; delete files[a]; },
  };
  const arc = mkArc();
  writeArchiveSafely('arch.json', arc, fsMod);
  assert.equal(calls[0][0] + '>' + calls[1][0], 'write>rename', '首步写 tmp、次步原子替换');
  assert.ok(String(calls[0][1]).endsWith('.tmp'), 'tmp 与目标同目录（rename 原子性前提）');
  assert.ok(files['arch.json'], '目标已落盘');
  assert.ok(!files['arch.json.tmp'], '无 tmp 残留');
});

test('原子写：rename 失败时清理残留 tmp 并抛明确错误（原档保持完好）', () => {
  const files = { 'arch.json': 'ORIGINAL' };
  const fsMod = {
    writeFileSync: (p, t) => { files[p] = t; },
    renameSync: () => { throw new Error('EPERM: cross-device link'); },
    unlinkSync: (p) => { delete files[p]; },
    existsSync: (p) => p in files,
  };
  assert.throws(
    () => writeArchiveSafely('arch.json', mkArc(), fsMod),
    (e) => /atomicSwap.*原子替换失败/.test(e.message),
    '错误必须带 atomicSwap 上下文，不得静默吞',
  );
  assert.equal(files['arch.json'], 'ORIGINAL', '原档未被破坏');
  assert.ok(!files['arch.json.tmp'], '失败路径清理了 tmp');
});
