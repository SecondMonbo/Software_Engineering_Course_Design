/*!
 * 出题引擎约束验证脚本（Node，无第三方依赖）
 * ---------------------------------------------------------------------------
 *   node tools/verify-engine.cjs      # 等价于 npm run verify
 *
 * 验证思路：不复用引擎的校验函数，而是用脚本内独立实现的「token 递归下降求值」
 * 与「token 层面表内检查」重新算一遍，再与引擎给出的结果/答案对照。
 * 任何一条不成立即以退出码 1 结束。
 */
'use strict';

const E = require('../src/engine.js');

let passed = 0;
const failures = [];
const notes = [];

function check(ok, label, detail) {
  if (ok) { passed++; return true; }
  failures.push(label + (detail ? ' → ' + detail : ''));
  return false;
}

// ---------------------------------------------------------------------------
// 独立实现 1：token 表达式递归下降求值（与引擎的 AST 求值互不相关）
// ---------------------------------------------------------------------------
function evaluateTokens(tokens) {
  const toks = tokens.slice();
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const trail = () => tokens.join(' ');

  function parseExpression() {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
      if (v < 0) throw new Error('出现负数中间结果：' + trail());
    }
    return v;
  }
  function parseTerm() {
    let v = parseFactor();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const r = parseFactor();
      if (op === '/') {
        if (r === 0) throw new Error('除数为 0：' + trail());
        if (v % r !== 0) throw new Error('除法不能整除：' + trail());
        v = v / r;
      } else {
        v = v * r;
      }
    }
    return v;
  }
  function parseFactor() {
    const tk = next();
    if (tk === '(') {
      const v = parseExpression();
      if (next() !== ')') throw new Error('括号不匹配：' + trail());
      return v;
    }
    if (tk == null) throw new Error('表达式意外结束：' + trail());
    if (tk === '=') throw new Error('等号未按左右两侧切分：' + trail());
    if (tk === '□') throw new Error('未填空位就求值：' + trail());
    const n = Number(tk);
    if (!Number.isInteger(n)) throw new Error('非法数字 token「' + tk + '」：' + trail());
    return n;
  }

  const value = parseExpression();
  if (i !== toks.length) throw new Error('表达式未被完全消费：' + trail());
  return value;
}

/** 按等号切分，分别求值左右两侧，返回 { left, right } */
function evaluateEquation(tokens) {
  const eq = tokens.indexOf('=');
  if (eq < 0) throw new Error('缺少等号：' + tokens.join(' '));
  return {
    left: evaluateTokens(tokens.slice(0, eq)),
    right: evaluateTokens(tokens.slice(eq + 1))
  };
}

// ---------------------------------------------------------------------------
// 独立实现 2：token 层面的表内乘除检查（只看相邻 token，不看 AST）
// ---------------------------------------------------------------------------
const isNumericToken = (tk) => typeof tk === 'string' && /^\d+$/.test(tk);

function checkTokenLevelCaps(q, p) {
  const out = [];
  const { tokens } = q;
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    const left = tokens[i - 1];
    const right = tokens[i + 1];
    if (tk === '*') {
      if (isNumericToken(left) && Number(left) > p.maxFactor) {
        out.push('乘法裸因数超出表内上限（' + left + '）');
      }
      if (isNumericToken(right) && Number(right) > p.maxFactor) {
        out.push('乘法裸因数超出表内上限（' + right + '）');
      }
    } else if (tk === '/') {
      // 除数必须在表内；被除数只在“两侧都是裸数字”时才要求落在表内除法范围内
      if (isNumericToken(right) && Number(right) > p.maxFactor) {
        out.push('除数超出表内上限（' + right + '）');
      }
      if (isNumericToken(right) && Number(right) < 2) {
        out.push('除数应不小于 2（' + right + '）');
      }
      if (isNumericToken(left) && isNumericToken(right) &&
          Number(left) > p.maxFactor * p.maxFactor) {
        out.push('被除数超出表内除法范围（' + left + '）');
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 逐套验证
// ---------------------------------------------------------------------------
function verifySheet(label, input) {
  const sheet = E.generateSheet(input);
  const p = sheet.params;
  const tag = label + '（seed=' + p.seed + ', 上限=' + p.maxValue + ', 题型=' + p.types.join('/') +
              ', 运算数=' + p.operandCount + ', 括号=' + p.allowParens + '）';

  check(sheet.questions.length > 0, tag + ' 至少要生成出题目', '实际 ' + sheet.questions.length + ' 题');
  check(sheet.stats.invalid === 0, tag + ' 不应产生不合规的题（invalid 计数）', 'invalid=' + sheet.stats.invalid);

  if (sheet.questions.length < p.count) {
    notes.push(tag + ' 题量受参数限制：' + sheet.questions.length + '/' + p.count + '，已给出告警=' +
               (sheet.warnings.length > 0));
  }

  const keys = new Set();
  sheet.questions.forEach((q, idx) => {
    const qtag = tag + ' 第 ' + (idx + 1) + ' 题「' + q.display + '」';

    // 1) 引擎自校验
    const problems = E.validateQuestion(q, p);
    check(problems.length === 0, qtag + ' 引擎自校验应通过', problems.join('；'));

    // 2) 展示串不得出现 NaN / undefined
    check(!/NaN|undefined|null/.test(q.display + q.solution), qtag + ' 展示串不应含异常值');

    // 3) 空位唯一
    check(q.tokens.filter((t) => t === E.BLANK).length === 1, qtag + ' 有且只有一个空位');

    // 4) 独立复算：把答案填进空位后，按等号切分独立求值，两侧必须相等
    const filled = q.tokens.map((t) => (t === E.BLANK ? String(q.answer) : t));
    let eq = null;
    try {
      eq = evaluateEquation(filled);
    } catch (err) {
      check(false, qtag + ' 独立复算失败', err.message);
    }
    if (eq) {
      check(eq.left === eq.right, qtag + ' 独立复算：等式两侧应相等',
            '左=' + eq.left + '，右=' + eq.right);
      check(eq.left === q.result, qtag + ' 独立复算的算式值应与引擎登记结果一致',
            '独立=' + eq.left + '，引擎=' + q.result);
      if (q.type !== 'unknown') {
        check(q.answer === q.result, qtag + ' 口算/脱式题答案应等于算式结果');
      }
    }

    // 5) token 层面的表内乘除检查
    const capProblems = checkTokenLevelCaps(q, p);
    check(capProblems.length === 0, qtag + ' 表内乘除约束', capProblems.join('；'));

    // 6) 答案范围
    check(Number.isInteger(q.answer) && q.answer >= 1 && q.answer <= p.maxValue,
          qtag + ' 答案应为 1..' + p.maxValue + ' 的整数', '答案=' + q.answer);

    // 7) 与参数一致：题型、括号开关、运算数个数
    check(p.types.indexOf(q.type) >= 0, qtag + ' 题型应在所选范围内');
    if (!p.allowParens) {
      check(q.tokens.indexOf('(') < 0, qtag + ' 关闭括号后不应出现括号');
    }
    if (q.type === 'mixed' && p.operandCount === 3) {
      check(q.operandCount === 3, qtag + ' 固定 3 个运算数时不应回退成两数题',
            '实际运算数=' + q.operandCount);
    }
    if (q.type === 'mixed' && p.operandCount === 2) {
      check(q.operandCount === 2, qtag + ' 固定 2 个运算数', '实际=' + q.operandCount);
    }
    if (q.type !== 'mixed') {
      check(q.operandCount === 2, qtag + ' 口算/求未知数应为两数题', '实际=' + q.operandCount);
    }

    // 8) 去重
    if (p.unique) {
      check(!keys.has(q.key), qtag + ' 同套内不应重复');
      keys.add(q.key);
    }
  });

  // 9) 原始题面（结果为空位时）不得出现负数
  sheet.questions.forEach((q) => {
    check(!/-/.test(q.display), tag + ' 题面不应出现负号（' + q.display + '）');
  });

  return sheet;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------
console.log('出题引擎 v' + E.VERSION + ' 约束验证\n');

const base = { count: 60, seed: 12345 };

const matrix = [
  ['标准二年级', Object.assign({}, base, { maxValue: 100 })],
  ['20 以内', Object.assign({}, base, { maxValue: 20 })],
  ['50 以内', Object.assign({}, base, { maxValue: 50 })],
  ['禁止括号', Object.assign({}, base, { maxValue: 100, allowParens: false })],
  ['固定两数', Object.assign({}, base, { maxValue: 100, operandCount: 2 })],
  ['固定三数', Object.assign({}, base, { maxValue: 100, operandCount: 3 })],
  ['仅口算', Object.assign({}, base, { maxValue: 100, types: ['arith'] })],
  ['仅脱式', Object.assign({}, base, { maxValue: 100, types: ['mixed'] })],
  ['仅求未知数', Object.assign({}, base, { maxValue: 100, types: ['unknown'] })],
  ['最窄上限', Object.assign({}, base, { maxValue: 10, count: 20 })]
];

let parenSeen = 0;
let unknownBlankPositions = { left: 0, right: 0, result: 0 };

matrix.forEach(([label, input]) => {
  const sheet = verifySheet(label, input);
  sheet.questions.forEach((q) => {
    if (q.tokens.indexOf('(') >= 0) parenSeen++;
    if (q.type === 'unknown') unknownBlankPositions[q.slot]++;
  });
});

// 括号开关的有效性
check(parenSeen > 0, '开启括号时应能生成带括号的题', '带括号题数=' + parenSeen);
const noParenSheet = E.generateSheet(Object.assign({}, base, { maxValue: 100, allowParens: false, count: 80 }));
check(noParenSheet.questions.every((q) => q.tokens.indexOf('(') < 0), '关闭括号后不得出现括号');

// 求未知数：空位应随机分布在三个位置
const unknownSheet = E.generateSheet({ count: 200, maxValue: 100, types: ['unknown'], seed: 777 });
const slots = { left: 0, right: 0, result: 0 };
unknownSheet.questions.forEach((q) => { slots[q.slot] = (slots[q.slot] || 0) + 1; });
check(slots.left > 10 && slots.right > 10 && slots.result > 10,
      '求未知数的空位应随机分布在 左 / 右 / 结果 三处', JSON.stringify(slots));

// 去重能力：题量不大时应能足量生成
const uniqSheet = E.generateSheet({ count: 100, maxValue: 100, seed: 999 });
check(uniqSheet.questions.length === 100, '标准参数下应能生成满 100 道不重复题',
      '实际 ' + uniqSheet.questions.length + '，去重丢弃 ' + uniqSheet.stats.duplicates);

// 种子可复现
const a = E.generateSheet({ count: 30, maxValue: 100, seed: 20240501 });
const b = E.generateSheet({ count: 30, maxValue: 100, seed: 20240501 });
const c = E.generateSheet({ count: 30, maxValue: 100, seed: 20240502 });
check(JSON.stringify(a.questions.map((q) => q.key)) === JSON.stringify(b.questions.map((q) => q.key)),
      '同一种子必须生成完全相同的题目');
check(JSON.stringify(a.questions.map((q) => q.key)) !== JSON.stringify(c.questions.map((q) => q.key)),
      '不同种子应生成不同的题目');

// 参数归一化：异常输入不应崩溃
const weird = E.generateSheet({ count: 'abc', maxValue: -5, seed: 0, types: [], operandCount: 7, allowParens: 'no' });
check(weird.questions.length > 0, '非法参数应被归一化为可用参数并正常出题',
      '题量=' + weird.questions.length + '，上限=' + weird.params.maxValue);

// 一次成套校验
const sheetReport = E.validateSheet(a, a.params);
check(sheetReport.failed.length === 0, 'validateSheet 全量校验应零失败',
      JSON.stringify(sheetReport.failed.slice(0, 3)));

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('通过断言：' + passed);
if (notes.length) {
  console.log('\n提示（非失败）：');
  notes.forEach((n) => console.log('  · ' + n));
}
if (failures.length) {
  console.log('\n失败 ' + failures.length + ' 项：');
  failures.slice(0, 25).forEach((f) => console.log('  ✗ ' + f));
  if (failures.length > 25) console.log('  … 其余 ' + (failures.length - 25) + ' 项省略');
  process.exit(1);
}
console.log('\n全部约束验证通过 ✓');
