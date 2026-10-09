// 每日收盘后自动采集入口（2026-10-08）：定时任务唯一入口，顺序执行——
//   ① scripts/emotion_history.mjs --fetch-latest  拉取今日涨停池（幂等入库）+ 全量情绪计算
//   ② scripts/scan_old_dragon.mjs                  老龙头候选逐日扫描
//   ③ scripts/main_theme_history.mjs                主线题材历史（聚类/持续性/轮动）
// 任一步失败即中止并退出非零（cron 可据此告警）；全部成功打印 "daily fetch done"。
//
// 用法（手动验证同此命令）：
//   node scripts/daily_fetch.mjs
// 定时部署见 docs/cron.md / crontab.example（15:30 抓收盘后快照，日志 logs/daily_fetch.log）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STEPS = [
  { script: 'scripts/emotion_history.mjs', args: ['--fetch-latest'], desc: '拉取今日涨停池 + 计算情绪' },
  { script: 'scripts/scan_old_dragon.mjs', args: [], desc: '扫描老龙头候选' },
  { script: 'scripts/main_theme_history.mjs', args: [], desc: '主线题材历史' },
];

for (const step of STEPS) {
  console.log(`\n[daily_fetch] ▶ ${step.desc}（${step.script}）`);
  const r = spawnSync(process.execPath, [path.join(ROOT, step.script), ...step.args], { stdio: 'inherit' });
  if (r.error) {
    console.error(`[daily_fetch] ✗ ${step.script} 启动失败：${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`[daily_fetch] ✗ ${step.script} 失败（exit ${r.status}），后续步骤中止`);
    process.exit(r.status ?? 1);
  }
}
console.log('\ndaily fetch done');
