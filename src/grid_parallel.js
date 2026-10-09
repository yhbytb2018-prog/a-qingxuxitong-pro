// 权重网格的 worker_threads 并行驱动（src/backtest.js 的调用方层，不触碰引擎本体）。
//
// 为什么需要：5 档 × 七因子 = 78,125 组权重，串行 gridSearch 一轮 ≈ 十余秒；
// scripts/backtest.mjs 还要再跑 rollingTest(refit) 的逐段重寻优（241 天样本 → 36 段，
// 每段一轮全网格），合计串行 30s+。引擎是纯 CPU 密集且零可变状态 → worker_threads
// 按核数缩减是量级解。
//
// 传输设计（v2，实测教训：v1 把每段 78k 行全部回传 + 每段重复生成网格，主线程反而成瓶颈）：
//   · 网格切片按 (baseWeights, steps) 签名去重——同签名只生成一次，切片缓存在 worker 端
//     （init 消息），后续任务只带数据与参数（几十个数字）；
//   · mode='best'（refit 场景）：worker 只回传切片内最优一行，主线程按生成序归约
//     ——每任务回传 1 行而非 78k/workers 行；
//   · mode='all'（帕累托场景）：回传完整行，主线程按 (jobId, chunkIndex) 拼回生成序
//     再走同一 sortByRank（V8 稳定排序）。
//
// 等价性设计（test/grid_parallel.test.mjs 锁定）：
//   · src/backtest.js 数值路径一行不改（test/backtest.test.mjs 的 Python 跨语言一致性
//     夹具锁死）——worker 直接 import 同一引擎计算切片；
//   · 'all'：并行结果与 gridSearch 逐位一致；
//   · 'best'：与 sortByRank(gridSearch(...))[0] 逐位一致——rankKey 严格小于才替换
//     （平局保持生成序在前者），与稳定排序取首行同义；
//   · parallelRollingTest 镜像 rollingTest 的切段/聚合逻辑，仅 refit 网格分发到池——
//     与 rollingTest 的 JSON 逐位等价由测试锁定（镜像漂移即刻红）。
//
// 降级通道：GRID_WORKERS=1 或 opts.workers<=1 → 串行兜底（直接走 gridSearch 同路径）。
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import os from 'node:os';
import {
  BASE_PARAMS, gridSearch, scoreWith, poolBacktest, sortByRank, weightGrid, rankKey,
} from './backtest.js';

const cmpKey = (ka, kb) => {
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return 0;
};

// ── worker 侧 ────────────────────────────────────────────────────────────────
// init：缓存本 worker 负责的网格切片（按签名索引）；task：算切片 → 按模式回传。
if (!isMainThread) {
  const gridCache = new Map(); // sig → ws 数组（本 worker 的切片）
  parentPort.on('message', (m) => {
    if (m.type === 'init') {
      gridCache.set(m.sig, m.ws);
      return;
    }
    const ws = gridCache.get(m.sig);
    if (m.mode === 'best') {
      // 切片内最优：rankKey 严格更小才替换（平局保持生成序在前者）；
      // 内联归约不建中间 rows 数组——280 万组合的行对象分配是 GC 大头
      let best = null, bestKey = null;
      for (const w of ws) {
        const { perf } = poolBacktest(scoreWith(m.factorsByDay, w), m.retsByAsset, m.p);
        const row = { w, ...perf, nav: undefined };
        const k = rankKey(row);
        if (best === null || cmpKey(k, bestKey) < 0) { best = row; bestKey = k; }
      }
      parentPort.postMessage({ type: 'best', jobId: m.jobId, chunkIndex: m.chunkIndex, best });
    } else {
      const rows = [];
      for (const w of ws) {
        const scores = scoreWith(m.factorsByDay, w);
        const { perf } = poolBacktest(scores, m.retsByAsset, m.p);
        rows.push({ w, ...perf, nav: undefined });
      }
      parentPort.postMessage({ type: 'rows', jobId: m.jobId, chunkIndex: m.chunkIndex, rows });
    }
  });
}

/** 默认 worker 数：GRID_WORKERS 环境变量优先；否则取可用核数，上限 8（内存与调度开销的折中） */
export function defaultWorkers() {
  const env = Number(process.env.GRID_WORKERS);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  const cores = os.availableParallelism?.() ?? os.cpus().length;
  return Math.max(1, Math.min(cores, 8));
}

const sliceRets = (retsByAsset, from, to) => {
  const out = {};
  for (const a of Object.keys(retsByAsset)) out[a] = retsByAsset[a].slice(from, to);
  return out;
};

/**
 * 批量跑多个网格（共享一个 worker 池；同 (baseWeights, steps) 签名的网格只生成一份）。
 * @param {Array<{factorsByDay, retsByAsset, baseWeights, p, steps}>} grids
 * @param {object} [opts] workers：worker 数；mode：'all'（默认，返回完整排序行）
 *   或 'best'（只返回每网格的最优行——refit 场景省掉全量回传）
 * @returns {Promise<Array>} mode='all' → 每网格一行（与 gridSearch 逐位一致）；
 *   mode='best' → 每网格一个最优行（与 sortByRank(gridSearch(...))[0] 逐位一致）
 */
export async function runGrids(grids, { workers = defaultWorkers(), mode = 'all' } = {}) {
  if (grids.length === 0) return [];
  if (workers <= 1) {
    // 串行兜底：与 gridSearch 完全同路径（含生成序与排序），降级环境行为不变
    return grids.map((g) => {
      const rows = gridSearch(g.factorsByDay, g.retsByAsset, g.baseWeights, g.p, g.steps);
      return mode === 'best' ? rows[0] : rows;
    });
  }

  // 网格按签名去重，只生成一次；每个网格切成恰好 workers 块，块号即归属的 worker 号
  const sigOf = (g) => JSON.stringify([g.baseWeights, g.steps ?? null]);
  const gridsBySig = new Map();
  grids.forEach((g) => {
    const sig = sigOf(g);
    if (!gridsBySig.has(sig)) gridsBySig.set(sig, weightGrid(g.baseWeights, g.steps));
  });
  // tasks[workerIdx] = 该 worker 的固定队列（每块等量 → 天然负载均衡，无需动态抢占）
  const tasks = Array.from({ length: workers }, () => []);
  grids.forEach((g, jobId) => {
    const sig = sigOf(g);
    const grid = gridsBySig.get(sig);
    const chunk = Math.max(1, Math.ceil(grid.length / workers));
    for (let from = 0; from < grid.length; from += chunk) {
      tasks[from / chunk].push({
        jobId, sig, chunkIndex: from / chunk, mode,
        ws: grid.slice(from, Math.min(from + chunk, grid.length)),
        factorsByDay: g.factorsByDay, retsByAsset: g.retsByAsset, p: g.p,
      });
    }
  });

  const rowsByJob = grids.map(() => []); // 'best' 模式下存的是每块最优行（顺序归约用）
  await new Promise((resolve, reject) => {
    let failed = false;
    let pending = tasks.reduce((a, q) => a + q.length, 0); // 待回执任务总数
    const pool = [];
    const finish = () => { for (const w of pool) w.terminate(); resolve(); };
    const fail = (err) => {
      if (failed) return;
      failed = true;
      for (const w of pool) w.terminate();
      reject(err);
    };
    for (let i = 0; i < workers; i++) {
      // 传 URL 对象而非字符串：Windows 下字符串 'file:///C:/…' 会被当相对路径解析（ERR_WORKER_PATH）
      const w = new Worker(new URL(import.meta.url));
      pool.push(w);
      w.on('error', fail);
      w.once('exit', (code) => { if (code !== 0 && !failed) fail(new Error('grid worker 异常退出 code=' + code)); });
      w.on('message', (msg) => {
        if (failed) return;
        rowsByJob[msg.jobId][msg.chunkIndex] = msg.type === 'best' ? msg.best : msg.rows;
        if (--pending === 0) finish();
      });
      // 整队一次性下发（worker 消息队列 FIFO 保证 init 先于 task）：
      // 逐任务"发一条等回执"会被消息 RTT 串行化（实测 refit 36 任务/worker 多花数秒）
      const inited = new Set();
      for (const t of tasks[i]) {
        if (!inited.has(t.sig)) {
          inited.add(t.sig);
          w.postMessage({ type: 'init', sig: t.sig, ws: t.ws });
        }
        w.postMessage({
          type: 'task', sig: t.sig, jobId: t.jobId, chunkIndex: t.chunkIndex, mode: t.mode,
          factorsByDay: t.factorsByDay, retsByAsset: t.retsByAsset, p: t.p,
        });
      }
    }
  });

  if (mode === 'best') {
    // 按块号（生成序）顺序归约：rankKey 严格更小才替换，平局保持在前块 → 与稳定排序取首行一致
    return rowsByJob.map((chunks) => {
      let acc = null, accKey = null;
      for (const c of chunks) {
        if (c == null) continue;
        const k = rankKey(c);
        if (acc === null || cmpKey(k, accKey) < 0) { acc = c; accKey = k; }
      }
      return acc;
    });
  }
  // 按 (jobId, chunkIndex) 顺序拼回生成序，再走与 gridSearch 相同的排序 → 逐位一致
  return rowsByJob.map((chunks) => sortByRank(chunks.flat()));
}

/** gridSearch 的并行版（参数与返回值逐位同构） */
export async function parallelGridSearch(factorsByDay, retsByAsset, baseWeights, p = BASE_PARAMS, steps, opts = {}) {
  const [rows] = await runGrids([{ factorsByDay, retsByAsset, baseWeights, p, steps }], opts);
  return rows;
}

/**
 * rollingTest 的并行版：切段/评估/聚合镜像 src/backtest.js rollingTest（等价性由
 * test/grid_parallel.test.mjs 的 JSON 逐位比对锁定），唯一差别是 refit 分支的
 * 逐段网格寻优批量分发到 worker 池（mode='best'：每段只需要最优权重，省掉全量回传）。
 * refit=false 时无网格开销，直接主线程评估。
 */
export async function parallelRollingTest(factorsByDay, retsByAsset, baseWeights, p = BASE_PARAMS,
  { trainWindow = 20, testWindow = 6, refit = false, steps } = {}, poolOpts = {}) {
  const n = factorsByDay.length;
  const windows = [];
  for (let start = 0; start + trainWindow + testWindow <= n; start += testWindow) {
    const trEnd = start + trainWindow, teEnd = trEnd + testWindow;
    windows.push({
      start, trEnd, teEnd,
      fTr: factorsByDay.slice(start, trEnd), fTe: factorsByDay.slice(trEnd, teEnd),
      rTr: sliceRets(retsByAsset, start, trEnd), rTe: sliceRets(retsByAsset, trEnd, teEnd),
    });
  }
  let bestBySeg = null;
  if (refit) {
    const grids = windows.map((w) => ({ factorsByDay: w.fTr, retsByAsset: w.rTr, baseWeights, p, steps }));
    const results = await runGrids(grids, { ...poolOpts, mode: 'best' });
    bestBySeg = results.map((bestRow) => bestRow.w);
  }
  const segs = windows.map((win, i) => {
    const w = refit ? bestBySeg[i] : baseWeights;
    const { perf } = poolBacktest(scoreWith(win.fTe, w), win.rTe, p);
    return { trainStart: win.start, testStart: win.trEnd, testEnd: win.teEnd, w, ...perf };
  });
  const withFinite = segs.filter((s) => Number.isFinite(s.sharpe));
  const sharpeMean = withFinite.length
    ? withFinite.reduce((a, s) => a + s.sharpe, 0) / withFinite.length : 0;
  const ddWorst = segs.length ? Math.max(...segs.map((s) => s.maxDd)) : 0;
  const winSegPct = segs.length ? segs.filter((s) => s.total > 0).length / segs.length : 0;
  return { segments: segs, sharpeMean, ddWorst, winSegPct };
}
