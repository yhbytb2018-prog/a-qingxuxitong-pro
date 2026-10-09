// src/grid_parallel.js 的等价性守卫：并行结果必须与 src/backtest.js 串行结果**逐位一致**。
//
// 这是并行化得以成立的安全网——gridSearch/rollingTest 的数值语义由
// test/backtest.test.mjs 的 Python 跨语言夹具锁死，本文件锁的是"并行驱动层不改数值"：
// worker 切片 → 主线程按生成序拼回 → 同一 sortByRank（稳定排序）→ 逐位相等。
import test from 'node:test';
import assert from 'node:assert/strict';
import { gridSearch, rollingTest, BASE_PARAMS, V52_PARAMS } from '../src/backtest.js';
import { runGrids, parallelGridSearch, parallelRollingTest, defaultWorkers } from '../src/grid_parallel.js';

// 确定性伪随机（LCG）：夹具可复现，失败可重放
const lcg = (seed) => { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; };
const mkFactors = (n, keys, seed) => {
  const r = lcg(seed);
  return Array.from({ length: n }, () => Object.fromEntries(keys.map((k) => [k, r() * 100])));
};
const mkRets = (n, seed) => {
  const r = lcg(seed);
  return Array.from({ length: n }, () => (r() - 0.5) * 0.04);
};

const KEYS = ['s_net', 's_pos', 's_brd', 's_hot']; // 4 因子 × 3 档 = 81 组（足够覆盖多块切分）
const STEPS = [0.8, 1.0, 1.2];
const factors = mkFactors(40, KEYS, 42);
const retsByAsset = { sh000001: mkRets(40, 7), sz399001: mkRets(40, 13), csi100: mkRets(40, 29) };
const baseW = { s_net: 0.3, s_pos: 0.25, s_brd: 0.25, s_hot: 0.2 };

test('parallelGridSearch 与 gridSearch 逐位一致（4 worker）', async () => {
  const serial = gridSearch(factors, retsByAsset, baseW, V52_PARAMS, STEPS);
  const parallel = await parallelGridSearch(factors, retsByAsset, baseW, V52_PARAMS, STEPS, { workers: 4 });
  assert.equal(JSON.stringify(parallel), JSON.stringify(serial));
  assert.equal(parallel.length, 81);
});

test('runGrids 多网格批处理：每个网格各自与 gridSearch 逐位一致', async () => {
  const grids = [
    { factorsByDay: factors, retsByAsset, baseWeights: baseW, p: V52_PARAMS, steps: STEPS },
    { factorsByDay: factors.slice(0, 20), retsByAsset: {
      sh000001: retsByAsset.sh000001.slice(0, 20), sz399001: retsByAsset.sz399001.slice(0, 20),
    }, baseWeights: { s_net: 0.4, s_pos: 0.3, s_brd: 0.2, s_hot: 0.1 }, p: BASE_PARAMS, steps: STEPS },
  ];
  const [a, b] = await runGrids(grids, { workers: 3 });
  assert.equal(JSON.stringify(a), JSON.stringify(
    gridSearch(grids[0].factorsByDay, grids[0].retsByAsset, grids[0].baseWeights, V52_PARAMS, STEPS)));
  assert.equal(JSON.stringify(b), JSON.stringify(
    gridSearch(grids[1].factorsByDay, grids[1].retsByAsset, grids[1].baseWeights, BASE_PARAMS, STEPS)));
});

test('runGrids workers=1 串行兜底：与 gridSearch 同路径逐位一致', async () => {
  const [rows] = await runGrids([{ factorsByDay: factors, retsByAsset, baseWeights: baseW, p: V52_PARAMS, steps: STEPS }], { workers: 1 });
  assert.equal(JSON.stringify(rows), JSON.stringify(gridSearch(factors, retsByAsset, baseW, V52_PARAMS, STEPS)));
});

test("runGrids mode='best'：与 sortByRank(gridSearch(...))[0] 逐位一致", async () => {
  const grids = [
    { factorsByDay: factors, retsByAsset, baseWeights: baseW, p: V52_PARAMS, steps: STEPS },
    { factorsByDay: factors.slice(0, 20), retsByAsset: {
      sh000001: retsByAsset.sh000001.slice(0, 20), sz399001: retsByAsset.sz399001.slice(0, 20),
    }, baseWeights: { s_net: 0.4, s_pos: 0.3, s_brd: 0.2, s_hot: 0.1 }, p: BASE_PARAMS, steps: STEPS },
  ];
  const bests = await runGrids(grids, { workers: 3, mode: 'best' });
  for (let i = 0; i < grids.length; i++) {
    const g = grids[i];
    const serialBest = gridSearch(g.factorsByDay, g.retsByAsset, g.baseWeights, g.p, g.steps)[0];
    assert.equal(JSON.stringify(bests[i]), JSON.stringify(serialBest));
  }
});

test('parallelRollingTest(refit) 与 rollingTest(refit) 逐位一致', async () => {
  // 40 天 / train 20 / test 6 → 3 段，每段 refit 跑 81 组网格
  const serial = rollingTest(factors, retsByAsset, baseW, V52_PARAMS,
    { trainWindow: 20, testWindow: 6, refit: true, steps: STEPS });
  const parallel = await parallelRollingTest(factors, retsByAsset, baseW, V52_PARAMS,
    { trainWindow: 20, testWindow: 6, refit: true, steps: STEPS }, { workers: 4 });
  assert.equal(JSON.stringify(parallel), JSON.stringify(serial));
  assert.equal(parallel.segments.length, 3);
});

test('parallelRollingTest(固定权重) 与 rollingTest(固定权重) 逐位一致', async () => {
  const serial = rollingTest(factors, retsByAsset, baseW, V52_PARAMS,
    { trainWindow: 20, testWindow: 6, refit: false, steps: STEPS });
  const parallel = await parallelRollingTest(factors, retsByAsset, baseW, V52_PARAMS,
    { trainWindow: 20, testWindow: 6, refit: false, steps: STEPS }, { workers: 4 });
  assert.equal(JSON.stringify(parallel), JSON.stringify(serial));
});

test('defaultWorkers：GRID_WORKERS 环境变量覆盖，且恒 ≥1', () => {
  const saved = process.env.GRID_WORKERS;
  try {
    process.env.GRID_WORKERS = '2';
    assert.equal(defaultWorkers(), 2);
    process.env.GRID_WORKERS = '0';
    assert.ok(defaultWorkers() >= 1); // 非法值回退核数，不炸
    delete process.env.GRID_WORKERS;
    assert.ok(defaultWorkers() >= 1 && defaultWorkers() <= 8);
  } finally {
    if (saved === undefined) delete process.env.GRID_WORKERS; else process.env.GRID_WORKERS = saved;
  }
});
