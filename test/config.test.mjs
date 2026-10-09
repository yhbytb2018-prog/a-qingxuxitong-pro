// config.json 单一事实源守卫。
//
// 守护目标：配置曾散落多处（src/config.js 对象字面量、前端 app.js/paper_ui.js 手抄副本、
// 审计脚本正则），任何一处单独改动都会造成「报告说 A、算的是 B」。抽离后 config.json 是
// 唯一事实源（schemaVersion 2 起参数唯一住所 = params.live/train；顶层仅保留 live 的双写镜像），
// 本测试锁定四条不变量：
//   1. JSON 自身合法性（权重和、阈值序、必需键）——加载器 src/config.js 在启动时也会拦；
//   2. 加载器导出的 params 与 JSON 逐位一致、兼容层与 live 派生一致（防止加载器
//      私自内联第二份口径）；
//   3. 顶层双写镜像必须与 params.live 逐位相等（前端扁平层直接消费，漂移即双源）；
//   4. 前端手抄副本与 JSON 一致（app.js TH_DEFAULT、paper_ui.js HOLIDAYS——它们是
//      旧浏览器降级路径，允许存在但不允许漂移；漂移即测试红，提醒同步或删除）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import config from '../src/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

test('config: JSON 可解析且带 schemaVersion（配置文件演化时版本必须显式递增）', () => {
  const raw = JSON.parse(read('config.json'));
  assert.equal(typeof raw.schemaVersion, 'number');
  assert.ok(raw.schemaVersion >= 1);
});

test('config: 加载器导出与 config.json 单一事实源一致（params 逐位 + 兼容层为 live 派生）', () => {
  const raw = JSON.parse(read('config.json'));
  assert.deepEqual(config.params.live, raw.params.live);
  assert.deepEqual(config.params.train, raw.params.train);
  // 兼容层 = live 派生（值层面；引用同一由 test/params_governance.test.mjs 断言 ===）
  assert.deepEqual(config.weights, raw.params.live.weights);
  assert.deepEqual(config.backtest.thresholds, raw.params.live.thresholds);
  assert.deepEqual(config.backtest.costs, raw.params.live.costModel);
  assert.equal(config.backtest.maxPos, raw.params.live.stops.maxPos);
  assert.equal(config.momentumRecent, raw.params.live.lookback.momentumRecent);
  assert.deepEqual(config.manualHolidays, raw.manualHolidays);
  assert.equal(config.formulaVersion, raw.formulaVersion);
});

test('config: 顶层双写镜像与 params.live 逐位相等（前端扁平层不得漂移）', () => {
  // 前端（index.html 内联 module 桥挂 window.ASENT_CONFIG；check_frontend 平铺 config.json
  // 后交 alerts 消费）只读顶层扁平字段，Node 侧读 params.live 同一引用——两份表述必须逐位
  // 相等，漂移即「报告说 A、算的是 B」。与 test/params_governance.test.mjs 的同名断言同向，
  // 互为双重保险（一条查 JSON 文本内部，一条查薄壳导出与 live 的引用同一）。
  const raw = JSON.parse(read('config.json'));
  assert.deepEqual(raw.weights, raw.params.live.weights, 'config.json 顶层 weights 与 params.live.weights 漂移');
  assert.deepEqual(raw.lookback, raw.params.live.lookback, '顶层 lookback 与 params.live.lookback 漂移');
  assert.equal(raw.momentumRecent, raw.params.live.lookback.momentumRecent, 'momentumRecent 与 live.lookback 漂移');
  assert.equal(raw.momentumPrev, raw.params.live.lookback.momentumPrev, 'momentumPrev 与 live.lookback 漂移');
  assert.deepEqual(raw.backtest.thresholds, raw.params.live.thresholds, 'backtest.thresholds 与 live.thresholds 漂移');
  assert.deepEqual(raw.backtest.costs, raw.params.live.costModel, 'backtest.costs 与 live.costModel 漂移');
  assert.deepEqual(raw.backtest.rolling, raw.params.live.lookback.rolling, 'backtest.rolling 与 live.lookback.rolling 漂移');
  assert.equal(raw.backtest.maxPos, raw.params.live.stops.maxPos, 'backtest.maxPos 与 live.stops 漂移');
  assert.equal(raw.backtest.stopLoss, raw.params.live.stops.stopLoss, 'backtest.stopLoss 与 live.stops 漂移');
  assert.equal(raw.backtest.ddTrigger, raw.params.live.stops.ddTrigger, 'backtest.ddTrigger 与 live.stops 漂移');
  assert.equal(raw.backtest.maxPosChg, raw.params.live.stops.maxPosChg, 'backtest.maxPosChg 与 live.stops 漂移');
});

test('config: 七因子权重齐全且和为 1', () => {
  const keys = ['s_net20', 's_pos10', 's_brd20', 's_hot10', 's_zdt15', 's_zbl10', 's_amt15'];
  for (const k of keys) assert.equal(typeof config.weights[k], 'number', `缺权重 ${k}`);
  const sum = Object.values(config.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `权重和 ${sum} ≠ 1`);
  // factorKeyMap 键集与 weights 一致（键漂移会让因子静默错位）
  assert.deepEqual(Object.keys(config.weights).sort(), Object.keys(config.factorKeyMap).sort());
});

test('config: 四档阈值升序且与 backtest 引擎口径同源', () => {
  const t = config.backtest.thresholds;
  assert.ok(t.panic < t.hi && t.hi < t.lo && t.lo < t.overheat, JSON.stringify(t));
});

test('config: 薄壳损坏时快速失败（权重和≠1 直接 throw，不带病运行）', async () => {
  // 用临时目录复刻一份坏 config.json + 薄壳加载器验证 throw 语义（不碰真实文件）。
  // 注意 Windows：动态 import 绝对路径必须转 file:// URL，否则 ERR_UNSUPPORTED_ESM_URL_SCHEME。
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const dir = mkdtempSync(join(tmpdir(), 'asent-cfg-'));
  try {
    const bad = JSON.parse(read('config.json'));
    bad.params.live.weights.s_net20 = 0.5; // 破坏权重和
    writeFileSync(join(dir, 'config.json'), JSON.stringify(bad));
    const shim = read('src/config.js')
      .replace(/join\(__dirname, '\.\.', 'config\.json'\)/, `join(${JSON.stringify(dir)}, 'config.json')`);
    writeFileSync(join(dir, 'shim.mjs'), shim);
    await assert.rejects(import(pathToFileURL(join(dir, 'shim.mjs')).href), /权重和/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: 前端手抄副本与 JSON 一致（降级路径允许存在，但不允许漂移）', () => {
  // app.js TH_DEFAULT —— getThresholds 的最后兜底
  const appSrc = read('app.js');
  const m = appSrc.match(/const TH_DEFAULT = \{([^}]+)\}/);
  assert.ok(m, 'app.js 缺 TH_DEFAULT（若已删除请同步更新本测试）');
  const th = config.backtest.thresholds;
  const pairs = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.equal(pairs.length, 4, `TH_DEFAULT 应含四档, 实际: ${m[1]}`);
  for (const p of pairs) {
    const [k, v] = p.split(':').map((x) => x.trim());
    assert.equal(+v, th[k], `TH_DEFAULT.${k}=${v} 与 config.json thresholds.${k}=${th[k]} 漂移`);
  }
  // paper_ui.js HOLIDAYS —— 假日兜底副本
  const puSrc = read('paper_ui.js');
  const hm = puSrc.match(/const HOLIDAYS = new Set\(\[([^\]]+)\]\)/);
  assert.ok(hm, 'paper_ui.js 缺 HOLIDAYS（若已删除请同步更新本测试）');
  const hset = new Set(hm[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean));
  assert.deepEqual([...hset].sort(), [...config.manualHolidays].sort(), 'paper_ui.js HOLIDAYS 与 config.manualHolidays 漂移');
});
