// ── 前后端接口契约校验器（V5.3 同步机制 · 2026-10-05）──────────────────────
//
// 背景：missingNote→missingReason 字段名不一致曾真实造成前后端不同步
// （前端显示"原因未知"，commit 57a12b7）。根因是接口字段没有单一事实源——
// 后端在 src/archive_split.js / scripts/*.mjs 的 payload 字面量里"定义"，
// 前端在 app.js 的属性访问里"消费"，两侧各自演化、无人对账。
//
// 本模块是契约的**执行引擎**：契约本体在 schemas/*.json（单一数据源），
// 校验规则刻意采用 JSON Schema 的一个**小子集**（见下），零 npm 依赖手写：
//   · type: 'object'|'array'|'string'|'number'|'boolean'|'null'（或数组=任一命中）
//   · properties / items / required / enum / const / minimum / maximum
//   · pattern / minLength（string 节点格式约束——emergency-contacts.phone 类
//     「格式错=@ 链静默断裂」字段；正则用 schema 自带串，无注入面）
//   · anyOf: [子schema...]（任一命中即可；用于「段可为 null」的三态语义）
//   · additionalProperties: false（可选：未声明字段视为漂移，默认不开启——
//     数据档常带诊断性附加字段，开它会产生噪音；契约只锁"该有的必须在"）
//
// 设计原则（对应"缺失不补 0"铁律）：
//   1. required = 前端渲染**实际消费**的字段（探索报告逐一核对过），不是
//      "后端恰好产出的字段"——契约描述的是消费面，不是生产面的自画像。
//      否则后端漏产一个前端要的字段，契约跟着漏，锁等于没锁。
//   2. 整段 optional（如 signals-latest.health 可为 null）+ 段内字段 required：
//      "未生成 ≠ 没有"是产品语义（前端有专门的缺失分支与文案），契约不越权
//      强制段必须存在；但**段一旦存在，其内字段必须齐**——半缺是最危险的
//      形态（渲染静默空白，无报错无文案）。
//   3. 错误信息必须可执行：路径（JSON Pointer）+ 期望 + 实际 + 修复指引。
//
// 用法（纯函数，无 IO）：
//   import { validateContract } from './contract.js';
//   const errs = validateContract(data, schema);       // [] = 通过
//   // errs: [{ path: '/sections/0/missingReason', expect: '...', got: '...', hint: '...' }]

/** 类型名→判定函数。数组形态（['string','null']）= 任一命中。 */
const TYPES = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
};

/** 单节点类型检查：返回 null（通过）或错误串。 */
function typeError(v, schema) {
  const t = schema.type;
  if (t == null) return null;
  const names = Array.isArray(t) ? t : [t];
  for (const n of names) {
    const fn = TYPES[n];
    if (!fn) return `未知类型名 ${n}（schemas 只允许 ${Object.keys(TYPES).join('|')}）`;
    if (fn(v)) return null;
  }
  return `类型不符`;
}

/**
 * 递归校验。path 用 JSON Pointer 风格（/health/items/0/label），错误即契约违例。
 * 返回错误数组；空数组 = 契约通过。
 *
 * root：根 schema（$ref 解析用）。内部递归时透传；外部调用只传两个参数。
 */
export function validateContract(data, schema, path = '', root = null) {
  const errs = [];
  const R = root || schema; // $ref 相对于根解析
  if (schema === true) return errs;          // true = 恒通过（占位用）
  if (schema === false) { errs.push(mk(path, '任何值', brief(data), '契约恒假占位')); return errs; }

  // $ref：仅支持本文件内 #/$defs/名称（跨文件引用会引入隐式耦合，刻意不支持）
  if (typeof schema.$ref === 'string') {
    const m = schema.$ref.match(/^#\/\$defs\/([A-Za-z0-9_]+)$/);
    if (!m) {
      errs.push(mk(path, `$ref 仅支持 #/$defs/<名称>（本文件内）`, schema.$ref, '跨文件 $ref 刻意不支持——契约文件各自独立，耦合会让「改一处绿一片」的假阴性成为可能'));
      return errs;
    }
    const target = R && R.$defs && R.$defs[m[1]];
    if (!target) {
      errs.push(mk(path, `$defs 里有 ${m[1]}`, '（未定义）', '契约引用了不存在的 $defs 条目'));
      return errs;
    }
    return validateContract(data, target, path, R);
  }

  // $defs：定义区，非校验目标
  if (schema.$defs !== undefined && schema.type === undefined && schema.properties === undefined && schema.anyOf === undefined && schema.required === undefined && schema.items === undefined) {
    return errs;
  }

  // anyOf：任一分支通过即可（用于「null 或对象」三态）
  if (Array.isArray(schema.anyOf)) {
    const branchErrs = [];
    for (const sub of schema.anyOf) {
      const subErrs = validateContract(data, sub, path, R);
      if (subErrs.length === 0) return errs;
      branchErrs.push(subErrs);
    }
    // 失败诊断：光说「未命中分支」会让人瞎猜——逐分支给出首条具体违例。
    // 只滤**分支级**类型错误（path === 当前节点且 expect 以「类型 」开头——那是
    // "null 分支对 object 数据"的无信息量失败）；字段级类型错误（路径更深）必须保留。
    const diagParts = [];
    schema.anyOf.forEach((sub, i) => {
      const es = branchErrs[i] || [];
      const informative = es.filter((e) => !(e.path === path && /^类型 /.test(e.expect)));
      if (informative.length) {
        diagParts.push(`分支#${i + 1}(${briefSchema(sub)})：${informative.slice(0, 2).map((e) => `${e.path || '/'} 期望 ${e.expect}，实际 ${e.got}`).join('；')}${informative.length > 2 ? ` 等 ${informative.length} 处` : ''}`);
      }
    });
    const diag = diagParts.length
      ? `（${diagParts.join('；')}）`
      : '（各分支均为纯类型不匹配——数据形态与所有分支都不像，先确认产出方没写错档）';
    errs.push(mk(path, `符合任一分支：${schema.anyOf.map((s) => briefSchema(s)).join(' | ')}`,
      brief(data), `anyOf 全分支未命中${diag}——先确认业务语义（null=未生成？），再对照 schemas/ 契约改产出方或契约本身`));
    return errs; // anyOf 命中后不再叠加其他检查
  }

  // type / enum / const / 数值边界
  const te = typeError(data, schema);
  if (te) {
    errs.push(mk(path, `类型 ${Array.isArray(schema.type) ? schema.type.join('|') : schema.type}`,
      brief(data), '对照 schemas/ 契约：改产出方的字段形态，或（若是有意变更）先改契约再改代码——顺序不可反'));
    return errs; // 类型不符后深层检查无意义
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(data)) {
    errs.push(mk(path, `枚举 ${JSON.stringify(schema.enum)}`, JSON.stringify(data), '枚举值不在契约内——产出方新增取值时必须先扩 schemas 枚举，前端渲染分支才有着落'));
  }
  if (schema.const !== undefined && data !== schema.const) {
    errs.push(mk(path, `常量 ${JSON.stringify(schema.const)}`, JSON.stringify(data), '哨兵值漂移（kind/version 类字段）——通常是产出方重构后忘对齐'));
  }
  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) {
      errs.push(mk(path, `≥ ${schema.minimum}`, String(data), '数值越下界'));
    }
    if (schema.maximum !== undefined && data > schema.maximum) {
      errs.push(mk(path, `≤ ${schema.maximum}`, String(data), '数值越上界'));
    }
  }
  // string 节点格式约束（P3 起入集）：pattern=正则（phone 等格式错即静默断裂的字段）、
  //   minLength=非空下界。失败信息带期望与实际，可直接执行。
  if (typeof data === 'string') {
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(data)) {
          errs.push(mk(path, `匹配正则 ${schema.pattern}`, JSON.stringify(data), '字符串格式违例（pattern）——对照 schemas 契约的格式约定修产出方'));
        }
      } catch (e) {
        errs.push(mk(path, '合法正则', schema.pattern, `schemas 里 pattern 本身写错（${e?.message}）——修契约`));
      }
    }
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      errs.push(mk(path, `长度 ≥ ${schema.minLength}`, `长度 ${data.length}`, '字符串过短——契约认定非空才有渲染意义'));
    }
  }

  // 对象：required + properties + additionalProperties（值结构模式）
  if (TYPES.object(data)) {
    for (const key of schema.required || []) {
      if (!(key in data)) {
        errs.push(mk(`${path}/${key}`, '字段必须存在（前端渲染消费面）', '（缺失）',
          '★ 这是前后端不同步的典型形态：字段被改名/被裁剪/漏产，前端将静默渲染空白。'
          + '修复顺序：1) 若是有意变更→先改 schemas/ 契约并同步另一端代码；2) 若非有意→修产出方'));
      }
    }
    const props = schema.properties || {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in data) errs.push(...validateContract(data[key], sub, `${path}/${key}`, R));
    }
    // additionalProperties 为对象形态 = 动态键的值结构（如 version-regression.stats 按
    // 版本 key 取值）——键不锁（版本会增减），但每个值的结构必须符合，否则渲染崩溃。
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      const known = new Set(Object.keys(props));
      for (const [key, val] of Object.entries(data)) {
        if (!known.has(key)) errs.push(...validateContract(val, schema.additionalProperties, `${path}/${key}`, R));
      }
    }
  }

  // 数组：items（含 minItems）
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      errs.push(mk(path, `至少 ${schema.minItems} 项`, `仅 ${data.length} 项`, '数组过短——契约认定非空才有渲染意义'));
    }
    const it = schema.items;
    if (it) data.forEach((el, i) => errs.push(...validateContract(el, it, `${path}/${i}`, R)));
  }
  return errs;
}

function mk(path, expect, got, hint) {
  return { path: path || '/', expect, got, hint };
}
function brief(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === 'object') return `object{${Object.keys(v).slice(0, 6).join(',')}}`;
  return `${typeof v} ${JSON.stringify(v)}`.slice(0, 60);
}
function briefSchema(s) {
  if (s === true) return '任何值';
  if (s.type) return Array.isArray(s.type) ? s.type.join('|') : s.type;
  if (Array.isArray(s.anyOf)) return 'anyOf';
  return '?';
}

/**
 * 门禁用格式化输出：把错误数组渲染成人读的块（路径→期望→实际→指引），
 * 让"哪个文件哪个字段差在哪"一眼可见，不用翻代码对账。
 */
export function formatContractErrors(file, errs) {
  const lines = errs.map((e) =>
    `  ✗ ${file}${e.path === '/' ? '' : e.path}\n`
    + `    期望：${e.expect}\n`
    + `    实际：${e.got}\n`
    + `    指引：${e.hint}`);
  return `[contract] ${file} 违例 ${errs.length} 处：\n${lines.join('\n')}`;
}
