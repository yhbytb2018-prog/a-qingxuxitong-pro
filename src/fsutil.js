// 原子写 JSON / 文本档（自查报告 H-4 修复 · 2026-10-07）
//
// 背景：裸 writeFileSync 写大档（主档 5.9MB）时进程被杀（CI timeout 的 SIGTERM /
// 断电 / runner 崩溃）会留下半截文件；更糟的是 pipeline 读到损坏档会
// `catch { history = [] }` 静默回退旧快照——损坏被降级成"旧但合法"，只有
// meta.stale 可见（见 src/pipeline.js 的降级分支）。
//
// 原子 = 同目录 tmp + rename：rename(2) 在同一文件系统内 POSIX/NTFS 均为原子
// 替换——读者要么看到完整旧档、要么看到完整新档，不存在中间态。
//
// 设计约定：
//   · 入参 text 一律是**已序列化好的字符串**（JSON.stringify 留在调用方）——
//     各写点的序列化格式（缩进/换行/compact）五花八门且被 CI 字节级比对
//     （writeJsonStable 的跳过逻辑、golden 基线），序列化逻辑搬进来会造成
//     无信息 diff。本函数只负责"原子地写文本"这一件事。
//   · Node-only 模块：import node:fs，浏览器平铺模块（util.js/lhb_codec.js 等）
//     不得引用本文件——它们走 fs 注入（见 writeArchiveSafely 的 atomicSwap）。
import { writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';

/**
 * 原子写文本档：tmp（同目录）→ rename 覆盖目标。
 * @param {string} filePath 目标文件（tmp = filePath + '.tmp'，天然同目录保证 rename 原子性）
 * @param {string} text 已序列化的完整文本
 * @throws 写 tmp 失败或 rename 失败时：清理残留 tmp 后抛带上下文的错误——
 *         决不静默吞（原档在失败时保持完好，这正是原子写的意义）。
 */
export function atomicWriteJSON(filePath, text) {
  const tmp = filePath + '.tmp';
  try {
    writeFileSync(tmp, text, 'utf8');
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* 清理失败已尽力，不掩盖原错误 */ }
    throw new Error(`[atomicWriteJSON] 写临时文件失败（${tmp}）：${e.message}`);
  }
  try {
    renameSync(tmp, filePath);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* 同上 */ }
    throw new Error(`[atomicWriteJSON] 原子替换失败（${tmp} → ${filePath}）：${e.message}`);
  }
}
