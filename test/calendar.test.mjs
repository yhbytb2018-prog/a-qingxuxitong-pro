// 交易日历守卫：三态判定、旧行为兼容、调休补班、覆盖范围回退。
//
// 本文件的核心价值是把两个「不会报错但后果严重」的错误钉死：
//   ① 把休市日当交易日 → 管道在休市日死抓 → 反复回退 + 误报「数据滞后」（页面看起来正常）；
//   ② 把交易日当休市日 → 管道在开市日跳过 → 整天数据缺失，事后极难归因。
// 两者都不会抛异常，故必须靠断言拦截。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import config from '../src/config.js';
import {
  loadCalendar, isTradingDay, dayKind, DAY_KIND, validateCalendar,
  calendarSummary, SEED_CLOSED, holidayList,
} from '../src/calendar.js';
import { isTradingDay as utilIsTradingDay } from '../src/util.js';

const CAL_FILE = 'data/calendar.json';
const haveCal = existsSync(CAL_FILE);
const realCal = haveCal ? loadCalendar({ reload: true, file: CAL_FILE, fallbackHolidays: config.manualHolidays }) : null;

// ────────────────────────── 一、旧行为兼容（升级零风险的前提）──────────────────────────

test('兼容：传数组时与旧实现逐位一致（数组 = 休市清单，非周末即交易日）', () => {
  const hol = ['2026-01-01', '2026-05-01'];
  // 工作日非休市 → true
  assert.equal(isTradingDay('2026-06-10', hol), true);
  // 工作日但在清单 → false
  assert.equal(isTradingDay('2026-05-01', hol), false);
  // 周六 / 周日 → false
  assert.equal(isTradingDay('2026-06-13', hol), false);  // 周六
  assert.equal(isTradingDay('2026-06-14', hol), false);  // 周日
});

test('兼容：util.isTradingDay 与 calendar.isTradingDay 传数组时结果一致', () => {
  const hol = config.manualHolidays;
  const shift = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  for (let d = '2026-09-01'; d <= '2026-10-31'; d = shift(d, 1)) {
    assert.equal(utilIsTradingDay(d, hol), isTradingDay(d, hol), d + ' 两处判定应一致');
  }
});

test('兼容：不传第二参时用默认日历，不抛错', () => {
  assert.equal(typeof isTradingDay('2026-06-10'), 'boolean');
});

// ────────────────────────── 二、三态判定 ──────────────────────────

test('三态：显式交易日优先于休市清单（调休补班：周末开市）', () => {
  const cal = { closed: new Set(['2026-06-13']), trading: new Set(['2026-06-13']), years: [2026] };
  // trading 里存在 → 即便同一日在 closed 里也应判为交易日（构造态；真实文件由加载层去重）
  assert.equal(dayKind('2026-06-13', { ...cal, closed: new Set() }), DAY_KIND.trading);
  assert.equal(isTradingDay('2026-06-13', { ...cal, closed: new Set() }), true, '周六有行情即交易日');
});

test('三态：周末默认休市，无需出现在 closed 清单里', () => {
  const cal = { closed: new Set(), trading: new Set(), years: [2026] };
  assert.equal(dayKind('2026-06-13', cal), DAY_KIND.closed); // 周六
  assert.equal(dayKind('2026-06-14', cal), DAY_KIND.closed); // 周日
});

test('三态：年份被覆盖时，非周末且未列休市 → 交易日', () => {
  const cal = { closed: new Set(), trading: new Set(), years: [2026] };
  assert.equal(dayKind('2026-06-10', cal), DAY_KIND.trading);
  assert.equal(isTradingDay('2026-06-10', cal), true);
});

test('三态：年份未被覆盖 → unknown，回退「非周末即交易日」而不是假定休市', () => {
  const cal = { closed: new Set(), trading: new Set(), years: [2026] };
  assert.equal(dayKind('2099-06-10', cal), DAY_KIND.unknown, '超出覆盖范围应为 unknown');
  assert.equal(isTradingDay('2099-06-10', cal), true, 'unknown 时工作日应判为交易日（回退旧规则）');
  assert.equal(isTradingDay('2099-06-13', cal), false, 'unknown 时周末仍休市');
});

// ────────────────────────── 三、真实日历文件（结构 + 一致性）──────────────────────────

test('真实日历：文件存在且结构完整', { skip: !haveCal && '缺 data/calendar.json' }, () => {
  const raw = JSON.parse(readFileSync(CAL_FILE, 'utf8'));
  assert.equal(raw.kind, 'trading-calendar');
  assert.ok(Array.isArray(raw.closed), 'closed 应为数组');
  assert.ok(Array.isArray(raw.trading), 'trading 应为数组');
  assert.ok(raw.source, '必须写明来源（可追溯）');
  assert.ok(raw.generatedAt, '必须带生成时间');
  // 覆盖范围必须如实写出，不得省略（省略等于宣称覆盖无限）
  assert.ok('coveredTo' in raw, '必须写出 coveredTo —— 否则读者会以为覆盖了未来');
});

test('真实日历：自检通过（无自相矛盾）', { skip: !haveCal && '缺 data/calendar.json' }, () => {
  const raw = JSON.parse(readFileSync(CAL_FILE, 'utf8'));
  const v = validateCalendar(raw);
  assert.ok(v.ok, '日历自检失败：' + v.errors.join('；'));
});

test('真实日历：休市清单不含周末日（周末默认休市，列进去只会虚高）',
  { skip: !haveCal && '缺 data/calendar.json' }, () => {
    const raw = JSON.parse(readFileSync(CAL_FILE, 'utf8'));
    const weekends = (raw.closed || []).filter((d) => { const w = new Date(d + 'T00:00:00').getDay(); return w === 0 || w === 6; });
    assert.deepEqual(weekends, [], '含周末日：' + weekends.join(','));
  });

test('真实日历：days 三态映射与 closed/trading 数组等价', { skip: !haveCal && '缺 data/calendar.json' }, () => {
  const raw = JSON.parse(readFileSync(CAL_FILE, 'utf8'));
  if (!raw.days) return; // days 可选
  for (const d of raw.closed || []) {
    assert.equal(raw.days[d], DAY_KIND.closed, `${d} 在两处状态不一致`);
  }
  for (const d of raw.trading || []) {
    assert.equal(raw.days[d], DAY_KIND.trading, `${d} 在两处状态不一致`);
  }
});

test('真实日历：已知假期必须判为休市（2026 中秋 / 国庆、2025 国庆）',
  { skip: !haveCal && '缺 data/calendar.json' }, () => {
    const must = [
      '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-06', '2025-10-07', '2025-10-08',
      '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
      '2026-09-25', '2026-02-16', '2026-02-17', '2026-05-01',
    ];
    for (const d of must) {
      assert.equal(isTradingDay(d, realCal), false, `${d} 应判为休市`);
      assert.equal(dayKind(d, realCal), DAY_KIND.closed, `${d} 状态应为 closed`);
    }
  });

test('真实日历：已知交易日必须判为开市（含国庆后首个交易日）',
  { skip: !haveCal && '缺 data/calendar.json' }, () => {
    const must = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-01-05', '2026-02-24', '2025-10-09'];
    for (const d of must) {
      assert.equal(isTradingDay(d, realCal), true, `${d} 应判为交易日`);
    }
  });

test('真实日历：config.manualHolidays 的每一个休市日都被日历覆盖（兜底不与之冲突）',
  { skip: !haveCal && '缺 data/calendar.json' }, () => {
    for (const d of config.manualHolidays) {
      assert.equal(isTradingDay(d, realCal), false, `${d} 在兜底清单里，日历也必须判休市`);
    }
  });

test('真实日历：摘要不含 degraded（文件正常时不得走兜底路径）',
  { skip: !haveCal && '缺 data/calendar.json' }, () => {
    const s = calendarSummary(realCal);
    assert.equal(s.degraded, false, '日历降级了：' + s.degradedReason);
    assert.ok(s.years.length > 0);
    assert.ok(s.closedCount > 0);
  });

// ────────────────────────── 四、降级路径（文件缺失/损坏不得静默变"全年无休"）──────────

test('降级：文件不存在时回退种子 + fallback，并标记 degraded', () => {
  const cal = loadCalendar({ reload: true, file: 'data/__no_such_calendar__.json', fallbackHolidays: ['2026-05-01'] });
  assert.equal(cal.meta.degraded, true, '缺文件必须标记 degraded（不得静默）');
  assert.ok(cal.meta.degradedReason.includes('不存在'));
  // 种子与 fallback 都必须并入
  assert.ok(cal.closed.has('2026-05-01'), 'fallback 未并入');
  assert.ok(cal.closed.size > 1, '种子休市日未并入（会导致退化成"全年非周末都是交易日"）');
});

test('降级：文件损坏时同样回退并标记 degraded（不得抛错打断管道）', () => {
  // 用一个必然解析失败的路径（目录当文件读）
  const cal = loadCalendar({ reload: true, file: 'data', fallbackHolidays: [] });
  assert.equal(cal.meta.degraded, true);
  assert.ok(cal.closed.size > 0, '损坏时仍应有种子兜底');
});

test('降级：种子日历本身必须非空（否则兜底等于没有兜底）', () => {
  assert.ok(Object.values(SEED_CLOSED).some((a) => a.length > 0), 'SEED_CLOSED 全空 → 兜底失效');
});

// ────────────────────────── 五、validateCalendar 能抓出的错误形态 ──────────────────────

test('自检：能抓出「调休补班日不是周末」', () => {
  const v = validateCalendar({ closed: [], trading: ['2026-06-10'] }); // 周三
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('必须是周末')));
});

test('自检：能抓出「同一日期两种状态」', () => {
  const v = validateCalendar({ closed: ['2026-06-10'], trading: ['2026-06-13'] });
  // 本条不会冲突；构造真冲突：days 与 closed 相抵
  const v2 = validateCalendar({ closed: ['2026-06-10'], days: { '2026-06-10': DAY_KIND.trading } });
  assert.equal(v2.ok, false);
  assert.ok(v2.errors.some((e) => e.includes('两种状态')), v2.errors.join(';'));
  assert.equal(v.ok, true, '不冲突的日历不应报错：' + v.errors.join(';'));
});

test('自检：能抓出「休市清单含周末日」', () => {
  const v = validateCalendar({ closed: ['2026-06-13'], trading: [] }); // 周六
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('周末日')));
});

test('自检：能抓出非法日期格式与未知状态', () => {
  const v = validateCalendar({ closed: ['2026/06/10'], trading: [], days: { '2026-07-01': 'holiday' } });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('非法日期格式')));
  assert.ok(v.errors.some((e) => e.includes('未知状态')));
});

// ────────────────────────── 六、holidayList / 缓存 ──────────────────────────

test('holidayList：返回排序后的休市日数组（供尚未改造的调用点）', () => {
  const cal = { closed: new Set(['2026-05-01', '2026-01-01']), trading: new Set(), years: [2026] };
  assert.deepEqual(holidayList(cal), ['2026-01-01', '2026-05-01']);
});

test('缓存：同一路径重复载入返回同一对象；reload 强制重读', () => {
  const a = loadCalendar({ file: CAL_FILE, fallbackHolidays: config.manualHolidays });
  const b = loadCalendar({ file: CAL_FILE, fallbackHolidays: config.manualHolidays });
  assert.equal(a, b, '同参数应命中缓存');
  const c = loadCalendar({ reload: true, file: CAL_FILE, fallbackHolidays: config.manualHolidays });
  if (haveCal) assert.notEqual(a, c, 'reload 应绕过缓存');
});
