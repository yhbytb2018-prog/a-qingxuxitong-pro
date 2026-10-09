// 守卫双通道通知（2026-10-08 第二+三步合并）· 纯函数层单测
//
// 锁死四件事：
//   ① guardVerdict 三态判定——outcome 与落盘报告**交叉印证**（success→PASS；
//     failure+allOk=false→BLOCK；failure+报告不可读/矛盾/超时 kill→ERROR），
//     守卫进程崩掉也兜得住（通知器独立进程读旁证，不信任单一信号）；
//   ② BLOCK 企微事件与 smokeFailEvent 逐字同构（老告警语义零漂移）；
//   ③ issue 载荷——labels ['guard']、title 带状态、body 带 Run 链接；
//   ④ issue IO 纪律——无 token 跳过、API 拒绝不抛（通知失败绝不拖红 CI）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { guardVerdict, shouldCreateIssue, buildIssuePayload, createGuardIssue } from '../src/guard_notify.js';

const SMOKE_OK = { tradeDateAnchored: '20261008', allOk: true, hardFail: [], sources: [{ id: 's1', ok: true }, { id: 's2', ok: true }, { id: 's6', ok: true }] };
const SMOKE_FAIL = {
  tradeDateAnchored: '20261008', allOk: false, hardFail: ['s2', 's6'],
  sources: [{ id: 's1', ok: true }, { id: 's2', ok: false }, { id: 's6', ok: false }],
};

// ── ① 三态判定 ────────────────────────────────────────────────────────
test('guardVerdict：success → PASS（info 心跳，reason 带通过率与放行语义）', () => {
  const v = guardVerdict({ stepOutcome: 'success', smoke: SMOKE_OK });
  assert.equal(v.status, 'PASS');
  assert.equal(v.event.severity, 'info', '心跳不是告警，info 级');
  assert.match(v.reason, /3\/3/, '通过率进 reason');
  assert.match(v.reason, /build 放行/);
});

test('guardVerdict：failure + allOk=false → BLOCK（事件与 smokeFailEvent 同构，老语义零漂移）', () => {
  const v = guardVerdict({ stepOutcome: 'failure', smoke: SMOKE_FAIL });
  assert.equal(v.status, 'BLOCK');
  assert.equal(v.event.severity, 'error');
  assert.equal(v.event.kind, 'smoke-fail', 'BLOCK 沿用既有事件 kind——运维台账口径统一');
  assert.match(v.event.detail, /s2；s6/, '硬失败源在场');
  assert.match(v.event.detail, /宽度\/主线档今日未刷新/, '下游停摆警示不丢');
  assert.match(v.reason, /s2；s6/);
});

test('guardVerdict：failure + 报告不可读 → ERROR（脚本崩掉也有旁证可判）', () => {
  const v = guardVerdict({ stepOutcome: 'failure', smoke: null });
  assert.equal(v.status, 'ERROR');
  assert.match(v.reason, /冒烟档不可读/);
  assert.equal(v.event.severity, 'error');
});

test('guardVerdict：failure + 报告竟为成功态 → ERROR（矛盾组合=超时 kill/报告被覆盖）', () => {
  const v = guardVerdict({ stepOutcome: 'failure', smoke: SMOKE_OK });
  assert.equal(v.status, 'ERROR');
  assert.match(v.reason, /与 step 失败矛盾/);
});

test('guardVerdict：outcome 异常（cancelled/缺失）→ ERROR（超时 kill 不静默）', () => {
  assert.equal(guardVerdict({ stepOutcome: 'cancelled', smoke: SMOKE_OK }).status, 'ERROR');
  assert.equal(guardVerdict({ stepOutcome: null, smoke: SMOKE_OK }).status, 'ERROR');
});

// ── ② issue 建不建 ────────────────────────────────────────────────────
test('shouldCreateIssue：BLOCK/ERROR 恒建；PASS 默认不建（防流水淹没台账）、开关可开', () => {
  const block = { status: 'BLOCK' }, pass = { status: 'PASS' }, err = { status: 'ERROR' };
  assert.equal(shouldCreateIssue(block), true);
  assert.equal(shouldCreateIssue(err), true);
  assert.equal(shouldCreateIssue(pass), false, 'PASS 默认不建——smoke 每天三班，issue 是异常台账不是运行日志');
  assert.equal(shouldCreateIssue(pass, { passIssue: true }), true, '要 PASS 也建（用户覆盖矩阵原案）开关可开');
});

// ── ③ issue 载荷 ──────────────────────────────────────────────────────
test('buildIssuePayload：labels [guard] + title 带状态 + body 带 Run 链接', () => {
  const v = guardVerdict({ stepOutcome: 'failure', smoke: SMOKE_FAIL });
  const p = buildIssuePayload(v, { repo: 'sjc19950404/a-sentiment-pro', runId: '123', runUrl: null });
  assert.deepEqual(p.labels, ['guard']);
  assert.match(p.title, /^🛡️ 守卫 BLOCK: /);
  assert.match(p.body, /状态: BLOCK/);
  assert.match(p.body, /Run: https:\/\/github\.com\/sjc19950404\/a-sentiment-pro\/actions\/runs\/123/, 'runUrl 缺失时由 repo+runId 拼装');
  assert.match(p.body, /时间: /);
  const p2 = buildIssuePayload(v, { runUrl: 'https://github.com/x/y/actions/runs/9' });
  assert.match(p2.body, /Run: https:\/\/github\.com\/x\/y\/actions\/runs\/9/, '显式 runUrl 优先');
});

// ── ④ issue IO 纪律 ───────────────────────────────────────────────────
test('createGuardIssue：无 token 跳过；API 拒绝不抛返回 error；成功返回编号', async () => {
  assert.deepEqual(await createGuardIssue({ title: 't', body: 'b', labels: ['guard'] }, { token: null, owner: 'o', repoName: 'r' }),
    { created: false, skipped: true }, '本地无 token → 跳过不炸');
  const calls = [];
  const ok = await createGuardIssue(
    { title: 't', body: 'b', labels: ['guard'] },
    { token: 'tok', owner: 'o', repoName: 'r', fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 201, json: async () => ({ number: 42, html_url: 'https://github.com/o/r/issues/42' }) };
    } },
  );
  assert.equal(ok.created, true);
  assert.equal(ok.number, 42);
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/issues', 'REST 端点');
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].init.headers.Authorization, /^Bearer tok$/, 'GitHub API 用 Bearer（v3 规范）');
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent.labels, ['guard']);
  assert.equal(sent.title, 't');
  const rejected = await createGuardIssue(
    { title: 't', body: 'b', labels: ['guard'] },
    { token: 'tok', owner: 'o', repoName: 'r', fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'Resource not accessible' }) },
  );
  assert.equal(rejected.created, false);
  assert.match(rejected.error, /403/);
  const crashed = await createGuardIssue(
    { title: 't', body: 'b', labels: ['guard'] },
    { token: 'tok', owner: 'o', repoName: 'r', fetchImpl: async () => { throw new Error('ECONNRESET'); } },
  );
  assert.equal(crashed.created, false, '网络炸 → 返回错误绝不抛（通知通道不是新的单点）');
  assert.match(crashed.error, /ECONNRESET/);
});
