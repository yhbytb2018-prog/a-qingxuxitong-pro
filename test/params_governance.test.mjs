// 参数治理守卫（过拟合防线 · 2026-10-02 拍板）——把「冻结 / 引用同一 / 台账留痕」
// 变成 CI 会红的断言，而不是 README 里的一段话。
//
// 防线设计：
//   · live 冻结：运行期改参在 ESM 严格模式下直接抛 TypeError（想改只能走 promote 流程）；
//   · 引用同一：config.weights 等旧路径 = params.live 同一对象（===），杜绝第二份口径漂移；
//   · 台账锁：params_changelog.json 最后一条 entry.liveAfter 与当前 live 逐位相等——
//     手改 config.json 的 params.live 而不追加 changelog 记录，本测试立刻红；
//   · 全链路同源：picks.js 档位阈值 / sources.js 分位窗口与 live 集中块一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../src/config.js';
import { RANK_WINDOW, RANK_MIN } from '../src/sources.js';
import { TIER_THRESHOLDS } from '../src/picks.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BLOCKS = ['weights', 'thresholds', 'stops', 'lookback', 'costModel'];

test('governance: live 冻结（递归）——运行期改参直接抛 TypeError', () => {
  assert.ok(Object.isFrozen(config.params.live), 'params.live 顶层未冻结');
  for (const b of BLOCKS) assert.ok(Object.isFrozen(config.params.live[b]), `params.live.${b} 未冻结`);
  assert.throws(() => { config.params.live.weights.s_net20 = 0.5; }, TypeError, 'weights 应拒绝运行期写入');
  assert.throws(() => { config.params.live.thresholds.panic = 10; }, TypeError, 'thresholds 应拒绝运行期写入');
  assert.throws(() => { config.params.live.costModel.comm = 0; }, TypeError, 'costModel 应拒绝运行期写入');
  assert.throws(() => { config.params.live.lookback.rankWindow = 10; }, TypeError, 'lookback 应拒绝运行期写入');
});

test('governance: 兼容层 = live 同一引用（不存在第二份口径）', () => {
  assert.equal(config.weights, config.params.live.weights);
  assert.equal(config.lookback, config.params.live.lookback);
  assert.equal(config.backtest.thresholds, config.params.live.thresholds);
  assert.equal(config.backtest.costs, config.params.live.costModel);
  assert.equal(config.backtest.rolling, config.params.live.lookback.rolling);
  assert.equal(config.backtest.stopLoss, config.params.live.stops.stopLoss);
  assert.equal(config.backtest.ddTrigger, config.params.live.stops.ddTrigger);
  assert.equal(config.momentumRecent, config.params.live.lookback.momentumRecent);
  assert.equal(config.momentumPrev, config.params.live.lookback.momentumPrev);
});

test('governance: train 结构与 live 一致（键集合锁，值允许漂移——实验的本意）', () => {
  for (const b of BLOCKS) {
    assert.deepEqual(
      Object.keys(config.params.train[b]).sort(),
      Object.keys(config.params.live[b]).sort(),
      `params.train.${b} 键集合与 live 不一致（实验区不许改结构，只许改值）`,
    );
  }
  assert.deepEqual(
    Object.keys(config.params.train.lookback.rolling).sort(),
    Object.keys(config.params.live.lookback.rolling).sort(),
  );
});

test('governance: 权重和为 1（live 与 train 各自——train 漂移后仍须归一）', () => {
  const sum = (w) => Object.values(w).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum(config.params.live.weights) - 1) < 1e-9, 'live 权重和 ≠ 1');
  assert.ok(Math.abs(sum(config.params.train.weights) - 1) < 1e-9, 'train 权重和 ≠ 1');
});

test('governance: costModel 完整且量级合理（实盘摩擦预埋块）', () => {
  const c = config.params.live.costModel;
  for (const k of ['comm', 'stamp', 'slip']) {
    assert.ok(typeof c[k] === 'number' && c[k] > 0 && c[k] < 0.01, `costModel.${k} 量级异常: ${c[k]}`);
  }
  assert.equal(typeof c.priceLimit.enabled, 'boolean', 'priceLimit.enabled 占位必须存在（涨跌停约束预埋）');
});

test('governance: changelog 台账与 live 逐位相等（手改 live 不留痕 → 红）', () => {
  const log = JSON.parse(readFileSync(path.join(ROOT, 'params_changelog.json'), 'utf8'));
  assert.ok(Array.isArray(log.entries) && log.entries.length > 0, 'params_changelog.json 无记录');
  const last = log.entries[log.entries.length - 1];
  for (const k of ['at', 'who', 'what', 'why', 'validation', 'liveAfter']) {
    assert.ok(last[k] != null, `changelog 最后一条缺 ${k}（who/when/why 缺一不可）`);
  }
  assert.equal(last.validation.pass, true, '最后一条 validation.pass 必须为 true（未过门禁不许留 live 状态）');
  assert.deepEqual(last.liveAfter, config.params.live, 'live 与 changelog 最后一条 liveAfter 不一致 —— 改了 params.live 却没走 promote 留痕');
});

test('governance: 全链路阈值同源（picks 档位 / sources 分位窗口读 live 集中块）', () => {
  assert.equal(TIER_THRESHOLDS.overheat, config.params.live.thresholds.overheat);
  assert.equal(TIER_THRESHOLDS.full, config.params.live.thresholds.lo);
  assert.equal(TIER_THRESHOLDS.half, config.params.live.thresholds.panic);
  assert.equal(RANK_WINDOW, config.params.live.lookback.rankWindow, 'sources.js RANK_WINDOW 应与 live.lookback 同源');
  assert.equal(RANK_MIN, config.params.live.lookback.rankMin, 'sources.js RANK_MIN 应与 live.lookback 同源');
});

test('governance: config.json 顶层双写镜像与 params.live 逐位相等（前端扁平层不漂移）', () => {
  // 前端（app.js ASENT_CONFIG / check_frontend 平铺 config.json）只读顶层扁平字段，
  // Node 侧读 params.live 同一引用——两份表述必须逐位相等，漂移即「报告说 A、算的是 B」。
  // 晋升走 scripts/promote_params.mjs 会同步双写；手改一侧必在此红。
  const raw = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  assert.deepEqual(raw.weights, config.params.live.weights, '顶层 weights 与 params.live.weights 漂移');
  assert.deepEqual(raw.lookback, config.params.live.lookback, '顶层 lookback 与 params.live.lookback 漂移');
  assert.deepEqual(raw.backtest.thresholds, config.params.live.thresholds, 'backtest.thresholds 与 live.thresholds 漂移');
  assert.deepEqual(raw.backtest.costs, config.params.live.costModel, 'backtest.costs 与 live.costModel 漂移');
  assert.deepEqual(raw.backtest.rolling, config.params.live.lookback.rolling, 'backtest.rolling 与 live.lookback.rolling 漂移');
  assert.equal(raw.backtest.maxPos, config.params.live.stops.maxPos, 'backtest.maxPos 与 live.stops.maxPos 漂移');
  assert.equal(raw.backtest.stopLoss, config.params.live.stops.stopLoss, 'backtest.stopLoss 与 live.stops.stopLoss 漂移');
  assert.equal(raw.backtest.ddTrigger, config.params.live.stops.ddTrigger, 'backtest.ddTrigger 与 live.stops.ddTrigger 漂移');
  assert.equal(raw.backtest.maxPosChg, config.params.live.stops.maxPosChg, 'backtest.maxPosChg 与 live.stops.maxPosChg 漂移');
  assert.equal(raw.momentumRecent, config.params.live.lookback.momentumRecent, 'momentumRecent 与 live.lookback.momentumRecent 漂移');
  assert.equal(raw.momentumPrev, config.params.live.lookback.momentumPrev, 'momentumPrev 与 live.lookback.momentumPrev 漂移');
});
