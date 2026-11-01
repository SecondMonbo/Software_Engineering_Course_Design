/*!
 * 四则运算出题引擎 v0.1.0
 * ---------------------------------------------------------------------------
 * 纯逻辑模块：不依赖 DOM，可在浏览器（挂 window.FQ_ENGINE）与 Node（module.exports）
 * 中同时使用，便于用脚本对出题结果做约束验证。
 *
 * 硬约束（由构造式出题保证，并由 validateQuestion 二次校验）：
 *   1. 结果与所有中间结果均非负；
 *   2. 加减法结果不超过 maxValue；
 *   3. 乘除限表内：裸数字因数 ≤ maxFactor，除法必须整除；
 *      两个裸数字相除时被除数不超过 maxFactor²（表内除法）；
 *   4. 括号内整体参与乘除时不受“表内”限制，但仍受 maxValue 限制；
 *   5. 操作数均为 ≥1 的整数。
 *
 * 数据结构：
 *   AST  —— 用于约束校验（能区分“括号内整体”与“裸数字”）
 *   tokens —— 扁平字符串数组，用于展示与独立复算，ASCII 运算符：+ - * /
 *             空位统一记为 '□'，等号记为 '='
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FQ_ENGINE = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '0.1.0';
  var OP_KEYS = ['+', '-', '*', '/'];
  var SYMBOLS = { '+': '+', '-': '−', '*': '×', '/': '÷' };
  var BLANK = '□';

  var DEFAULT_PARAMS = {
    types: ['arith', 'mixed', 'unknown'], // arith 口算填空 / mixed 脱式混合 / unknown 求未知数
    count: 20,          // 每套题量
    maxValue: 100,      // 加减法结果上限
    maxFactor: 9,       // 表内乘除因数上限
    operandCount: 'random', // 2 | 3 | 'random'，仅作用于 mixed
    allowParens: true,
    unique: true,
    seed: 20240501
  };

  // -------------------------------------------------------------------------
  // 基础工具
  // -------------------------------------------------------------------------
  function symbolOf(op) { return SYMBOLS[op] || op; }

  function toInt(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : fallback;
  }

  function clamp(n, low, high) { return Math.min(high, Math.max(low, n)); }

  /** mulberry32：同一种子必然产出同一串随机数 */
  function createRNG(seed) {
    var s = (toInt(seed, DEFAULT_PARAMS.seed) >>> 0) || 0x9e3779b9;
    return function next() {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function rint(rng, low, high) {
    if (high < low) return low;
    return low + Math.floor(rng() * (high - low + 1));
  }

  function pick(rng, list) { return list[Math.floor(rng() * list.length)]; }

  function chance(rng, p) { return rng() < p; }

  // -------------------------------------------------------------------------
  // AST 构造与取值
  // -------------------------------------------------------------------------
  function numNode(v) { return { t: 'num', v: v }; }
  function opNode(op, l, r) { return { t: 'op', op: op, l: l, r: r }; }
  function grpNode(e) { return { t: 'group', e: e }; } // 显式括号

  /** 递归求值；任何违反硬约束的情况返回 null（供校验用） */
  function evalNode(node, p, problems) {
    if (!node || typeof node !== 'object') {
      problems.push('节点结构异常');
      return null;
    }
    if (node.t === 'num') {
      if (!Number.isInteger(node.v)) { problems.push('操作数不是整数：' + node.v); return null; }
      if (node.v < 1) { problems.push('操作数小于 1：' + node.v); return null; }
      if (node.v > p.maxValue) { problems.push('操作数超过上限 ' + p.maxValue + '：' + node.v); return null; }
      return node.v;
    }
    if (node.t === 'group') return evalNode(node.e, p, problems);
    if (node.t === 'op') {
      var lv = evalNode(node.l, p, problems);
      var rv = evalNode(node.r, p, problems);
      if (lv == null || rv == null) return null;

      // 只有“裸数字”才受表内限制；括号内整体算作一个非裸操作数
      var plainL = node.l.t === 'num';
      var plainR = node.r.t === 'num';
      var val = null;

      if (node.op === '+') {
        val = lv + rv;
      } else if (node.op === '-') {
        val = lv - rv;
        if (val < 0) { problems.push('出现负数中间结果：' + lv + ' - ' + rv); return null; }
      } else if (node.op === '*') {
        if (plainL && lv > p.maxFactor) { problems.push('乘法因数超出表内范围：' + lv); }
        if (plainR && rv > p.maxFactor) { problems.push('乘法因数超出表内范围：' + rv); }
        val = lv * rv;
      } else if (node.op === '/') {
        if (rv === 0) { problems.push('除数为 0'); return null; }
        if (lv % rv !== 0) { problems.push('除法不能整除：' + lv + ' ÷ ' + rv); }
        if (plainR && rv > p.maxFactor) { problems.push('除数超出表内范围：' + rv); }
        if (plainL && plainR && lv > p.maxFactor * p.maxFactor) { problems.push('被除数超出表内除法范围：' + lv); }
        val = lv / rv;
      } else {
        problems.push('未知运算符：' + node.op);
        return null;
      }

      if (!Number.isInteger(val)) { problems.push('中间结果不是整数：' + val); return null; }
      if (val > p.maxValue) { problems.push('中间结果超过上限 ' + p.maxValue + '：' + val); return null; }
      return val;
    }
    problems.push('未知节点类型：' + node.t);
    return null;
  }

  // -------------------------------------------------------------------------
  // 取数工具：保证“乘除表内 + 不超上限”
  // -------------------------------------------------------------------------
  /** 取一对表内因数，使 a×b ≤ maxProduct；无解返回 null */
  function mulPair(rng, p, maxProduct) {
    var cap = Math.min(p.maxFactor, Math.max(2, maxProduct));
    var options = [];
    for (var a = 2; a <= cap; a++) {
      var bMax = Math.min(cap, Math.floor(maxProduct / a));
      if (bMax >= 2) options.push({ a: a, bMax: bMax });
    }
    if (!options.length) return null;
    var o = pick(rng, options);
    return { a: o.a, b: rint(rng, 2, o.bMax) };
  }

  /** 取一组整除算式 a ÷ b = q，使 a ≤ maxDividend、q ≥ minQ；无解返回 null */
  function divPair(rng, p, maxDividend, minQ) {
    var minQuotient = Math.max(1, minQ || 1);
    var options = [];
    var bCap = Math.min(p.maxFactor, maxDividend);
    for (var b = 2; b <= bCap; b++) {
      var qMax = Math.min(p.maxFactor, Math.floor(maxDividend / b));
      if (qMax >= minQuotient) options.push({ b: b, qMax: qMax });
    }
    if (!options.length) return null;
    var o = pick(rng, options);
    var q = rint(rng, minQuotient, o.qMax);
    return { a: o.b * q, b: o.b, q: q };
  }

  // -------------------------------------------------------------------------
  // 两数模板（口算填空 / 求未知数 / 脱式两数）
  // -------------------------------------------------------------------------
  var ARITH_BUILDERS = {
    '+': function (rng, p) {
      var a = rint(rng, 1, p.maxValue - 1);
      var b = rint(rng, 1, p.maxValue - a);
      return opNode('+', numNode(a), numNode(b));
    },
    '-': function (rng, p) {
      var a = rint(rng, 2, p.maxValue);
      var b = rint(rng, 1, a - 1);
      return opNode('-', numNode(a), numNode(b));
    },
    '*': function (rng, p) {
      var m = mulPair(rng, p, p.maxValue);
      return m ? opNode('*', numNode(m.a), numNode(m.b)) : null;
    },
    '/': function (rng, p) {
      var d = divPair(rng, p, p.maxValue, 1);
      return d ? opNode('/', numNode(d.a), numNode(d.b)) : null;
    }
  };

  // 加减乘除出现概率（+ - 各 3 份，× ÷ 各 2 份）
  var OP_POOL = ['+', '+', '+', '-', '-', '-', '*', '*', '/', '/'];

  function buildTwoOperand(rng, p) {
    for (var i = 0; i < 12; i++) {
      var ast = ARITH_BUILDERS[pick(rng, OP_POOL)](rng, p);
      if (ast) return ast;
    }
    return opNode('+', numNode(2), numNode(2)); // 兜底：上限极小时仍然合法
  }

  // -------------------------------------------------------------------------
  // 三数模板（脱式混合运算）
  // parens 标记该模板是否出现括号，供“允许括号”开关过滤
  // -------------------------------------------------------------------------
  var MIXED_BUILDERS = [
    { id: 'a+b-c', parens: false, build: function (rng, p) {
        var a = rint(rng, 1, p.maxValue - 2);
        var b = rint(rng, 1, p.maxValue - a - 1);
        var c = rint(rng, 1, a + b - 1);
        return opNode('-', opNode('+', numNode(a), numNode(b)), numNode(c));
      } },
    { id: 'a-b+c', parens: false, build: function (rng, p) {
        var a = rint(rng, 2, p.maxValue - 1);
        var b = rint(rng, 1, a - 1);
        var c = rint(rng, 1, p.maxValue - (a - b));
        return opNode('+', opNode('-', numNode(a), numNode(b)), numNode(c));
      } },
    { id: 'a-b-c', parens: false, build: function (rng, p) {
        var a = rint(rng, 3, p.maxValue);
        var b = rint(rng, 1, a - 2);
        var c = rint(rng, 1, a - b - 1);
        return opNode('-', opNode('-', numNode(a), numNode(b)), numNode(c));
      } },
    { id: 'a+b+c', parens: false, build: function (rng, p) {
        var a = rint(rng, 1, p.maxValue - 2);
        var b = rint(rng, 1, p.maxValue - a - 1);
        var c = rint(rng, 1, p.maxValue - a - b);
        return opNode('+', opNode('+', numNode(a), numNode(b)), numNode(c));
      } },
    { id: 'a×b+c', parens: false, build: function (rng, p) {
        var m = mulPair(rng, p, p.maxValue - 1);
        if (!m) return null;
        var c = rint(rng, 1, p.maxValue - m.a * m.b);
        return opNode('+', opNode('*', numNode(m.a), numNode(m.b)), numNode(c));
      } },
    { id: 'a×b-c', parens: false, build: function (rng, p) {
        var m = mulPair(rng, p, p.maxValue);
        if (!m) return null;
        var c = rint(rng, 1, m.a * m.b - 1);
        return opNode('-', opNode('*', numNode(m.a), numNode(m.b)), numNode(c));
      } },
    { id: 'a+b×c', parens: false, build: function (rng, p) {
        var a = rint(rng, 1, Math.max(1, p.maxValue - 4));
        var m = mulPair(rng, p, p.maxValue - a);
        if (!m) return null;
        return opNode('+', numNode(a), opNode('*', numNode(m.a), numNode(m.b)));
      } },
    { id: 'a×b+c（序换）', parens: false, build: function (rng, p) {
        var a = rint(rng, 1, Math.max(1, p.maxValue - 4));
        var m = mulPair(rng, p, p.maxValue - a);
        if (!m) return null;
        return opNode('+', opNode('*', numNode(m.a), numNode(m.b)), numNode(a));
      } },
    { id: 'a-b×c', parens: false, build: function (rng, p) {
        var a = rint(rng, 5, p.maxValue);
        var m = mulPair(rng, p, a - 1);
        if (!m) return null;
        return opNode('-', numNode(a), opNode('*', numNode(m.a), numNode(m.b)));
      } },
    { id: 'a÷b+c', parens: false, build: function (rng, p) {
        var d = divPair(rng, p, p.maxValue - 1, 1);
        if (!d) return null;
        var c = rint(rng, 1, p.maxValue - d.a);
        return opNode('+', opNode('/', numNode(d.a), numNode(d.b)), numNode(c));
      } },
    { id: 'a÷b-c', parens: false, build: function (rng, p) {
        var d = divPair(rng, p, p.maxValue, 2);
        if (!d) return null;
        var c = rint(rng, 1, d.q - 1);
        return opNode('-', opNode('/', numNode(d.a), numNode(d.b)), numNode(c));
      } },
    { id: 'c+a÷b', parens: false, build: function (rng, p) {
        var d = divPair(rng, p, p.maxValue - 1, 1);
        if (!d) return null;
        var a = rint(rng, 1, p.maxValue - d.a);
        return opNode('+', numNode(a), opNode('/', numNode(d.a), numNode(d.b)));
      } },
    { id: 'a-b÷c', parens: false, build: function (rng, p) {
        var d = divPair(rng, p, p.maxValue, 1);
        if (!d) return null;
        var a = rint(rng, d.q + 1, p.maxValue);
        return opNode('-', numNode(a), opNode('/', numNode(d.a), numNode(d.b)));
      } },

    // ---------------- 带括号：括号内先算，再与外部运算 ----------------
    { id: '(a+b)×c', parens: true, build: function (rng, p) {
        var c = rint(rng, 2, Math.min(p.maxFactor, Math.floor(p.maxValue / 2)));
        var s = rint(rng, 2, Math.floor(p.maxValue / c));
        var a = rint(rng, 1, s - 1);
        return opNode('*', grpNode(opNode('+', numNode(a), numNode(s - a))), numNode(c));
      } },
    { id: '(a-b)×c', parens: true, build: function (rng, p) {
        var c = rint(rng, 2, Math.min(p.maxFactor, Math.floor(p.maxValue / 2)));
        var d = rint(rng, 2, Math.floor(p.maxValue / c));
        var a = rint(rng, d + 1, p.maxValue);
        return opNode('*', grpNode(opNode('-', numNode(a), numNode(a - d))), numNode(c));
      } },
    { id: 'c×(a+b)', parens: true, build: function (rng, p) {
        var c = rint(rng, 2, Math.min(p.maxFactor, Math.floor(p.maxValue / 2)));
        var s = rint(rng, 2, Math.floor(p.maxValue / c));
        var a = rint(rng, 1, s - 1);
        return opNode('*', numNode(c), grpNode(opNode('+', numNode(a), numNode(s - a))));
      } },
    { id: 'c×(a-b)', parens: true, build: function (rng, p) {
        var c = rint(rng, 2, Math.min(p.maxFactor, Math.floor(p.maxValue / 2)));
        var d = rint(rng, 2, Math.floor(p.maxValue / c));
        var a = rint(rng, d + 1, p.maxValue);
        return opNode('*', numNode(c), grpNode(opNode('-', numNode(a), numNode(a - d))));
      } },
    { id: '(a+b)÷c', parens: true, build: function (rng, p) {
        var c = rint(rng, 2, Math.min(p.maxFactor, Math.floor(p.maxValue / 2)));
        var qMax = Math.min(p.maxFactor, Math.floor(p.maxValue / c));
        if (qMax < 2) return null;
        var s = c * rint(rng, 2, qMax);
        var a = rint(rng, 1, s - 1);
        return opNode('/', grpNode(opNode('+', numNode(a), numNode(s - a))), numNode(c));
      } },
    { id: '(a-b)÷c', parens: true, build: function (rng, p) {
        var c = rint(rng, 2, Math.min(p.maxFactor, Math.floor((p.maxValue - 1) / 2)));
        var qMax = Math.min(p.maxFactor, Math.floor((p.maxValue - 1) / c));
        if (qMax < 2) return null;
        var s = c * rint(rng, 2, qMax); // s ≤ maxValue - 1，保证 a 有取值空间
        var a = rint(rng, s + 1, p.maxValue);
        return opNode('/', grpNode(opNode('-', numNode(a), numNode(a - s))), numNode(c));
      } },
    { id: 'a÷(b+c)', parens: true, build: function (rng, p) {
        var s = rint(rng, 2, Math.min(p.maxFactor, Math.floor(p.maxValue / 2)));
        var qMax = Math.min(p.maxFactor, Math.floor(p.maxValue / s));
        if (qMax < 2) return null;
        var q = rint(rng, 2, qMax);
        var b = rint(rng, 1, s - 1);
        return opNode('/', numNode(s * q), grpNode(opNode('+', numNode(b), numNode(s - b))));
      } },
    { id: 'a÷(b-c)', parens: true, build: function (rng, p) {
        var s = rint(rng, 2, Math.min(p.maxFactor, Math.floor(p.maxValue / 2)));
        var qMax = Math.min(p.maxFactor, Math.floor(p.maxValue / s));
        if (qMax < 2) return null;
        var q = rint(rng, 2, qMax);
        var b = rint(rng, s + 1, Math.min(p.maxValue, s + p.maxFactor));
        return opNode('/', numNode(s * q), grpNode(opNode('-', numNode(b), numNode(b - s))));
      } },
    { id: 'a-(b+c)', parens: true, build: function (rng, p) {
        var s = rint(rng, 2, p.maxValue - 1);
        var a = rint(rng, s + 1, p.maxValue);
        var b = rint(rng, 1, s - 1);
        return opNode('-', numNode(a), grpNode(opNode('+', numNode(b), numNode(s - b))));
      } }
  ];

  // -------------------------------------------------------------------------
  // tokens 与展示
  // -------------------------------------------------------------------------
  function tokensOf(node, out) {
    out = out || [];
    if (node.t === 'num') out.push(String(node.v));
    else if (node.t === 'group') { out.push('('); tokensOf(node.e, out); out.push(')'); }
    else if (node.t === 'op') { tokensOf(node.l, out); out.push(node.op); tokensOf(node.r, out); }
    return out;
  }

  /** tokens → 展示字符串，例如 ['(','12','+','8',')','*','3','=','□'] → '(12 + 8) × 3 = □' */
  function formatTokens(tokens) {
    var s = '';
    for (var i = 0; i < tokens.length; i++) {
      var tk = tokens[i];
      if (tk === '(') s += '(';
      else if (tk === ')') s = s.replace(/\s+$/, '') + ')';
      else if (tk === '=') s += ' = ';
      else if (OP_KEYS.indexOf(tk) >= 0) s += ' ' + symbolOf(tk) + ' ';
      else s += tk;
    }
    return s.replace(/\s{2,}/g, ' ').trim();
  }

  function countNumbers(tokens) {
    var n = 0;
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i] !== '=' && tokens[i] !== BLANK && tokens[i] !== '(' && tokens[i] !== ')' &&
          OP_KEYS.indexOf(tokens[i]) < 0) n++;
    }
    return n;
  }

  function isOperatorToken(tk) { return OP_KEYS.indexOf(tk) >= 0; }

  // -------------------------------------------------------------------------
  // 组装一道题
  // -------------------------------------------------------------------------
  function makeQuestion(type, ast, slot, p) {
    var problems = [];
    var result = evalNode(ast, p, problems);
    if (result == null || problems.length) return null; // 构造阶段就不合法，交给调用方重试

    var lv = null, rv = null;
    if (ast.t === 'op') {
      lv = evalNode(ast.l, p, []);
      rv = evalNode(ast.r, p, []);
    }

    var tokens;
    if (type === 'unknown') {
      // 两数等式，空位随机落在 左操作数 / 右操作数 / 结果 上
      var left = String(lv), right = String(rv), res = String(result);
      if (slot === 'left') tokens = [BLANK, ast.op, right, '=', res];
      else if (slot === 'right') tokens = [left, ast.op, BLANK, '=', res];
      else { slot = 'result'; tokens = [left, ast.op, right, '=', BLANK]; }
    } else {
      slot = 'result';
      tokens = tokensOf(ast).concat(['=', BLANK]);
    }

    var answer = slot === 'result' ? result : (slot === 'left' ? lv : rv);
    if (!Number.isInteger(answer) || answer < 1 || answer > p.maxValue) return null;

    var solutionTokens = tokens.map(function (tk) { return tk === BLANK ? String(answer) : tk; });
    return {
      type: type,
      ast: ast,
      tokens: tokens,
      slot: slot,
      result: result,
      answer: answer,
      operandCount: countNumbers(tokens),
      key: type + '|' + tokens.join(' '),
      display: formatTokens(tokens),
      solution: formatTokens(solutionTokens)
    };
  }

  function buildQuestion(rng, p) {
    var type = pick(rng, p.types);

    if (type === 'unknown') {
      for (var i = 0; i < 12; i++) {
        var astU = buildTwoOperand(rng, p);
        var qU = makeQuestion('unknown', astU, pick(rng, ['left', 'right', 'result']), p);
        if (qU) return qU;
      }
      return null;
    }

    if (type === 'mixed') {
      var wantThree = p.operandCount === 'random' ? chance(rng, 0.6) : p.operandCount === 3;
      if (wantThree) {
        var pool = MIXED_BUILDERS.filter(function (b) { return !b.parens || p.allowParens; });
        for (var k = 0; k < 24; k++) {
          var astM = pick(rng, pool).build(rng, p);
          if (!astM) continue;
          var qM = makeQuestion('mixed', astM, 'result', p);
          if (qM) return qM;
        }
      }
      // 两数脱式（或三数模板全部无解时的回退）
      for (var j = 0; j < 12; j++) {
        var qM2 = makeQuestion('mixed', buildTwoOperand(rng, p), 'result', p);
        if (qM2) return qM2;
      }
      return null;
    }

    // arith：口算填空
    for (var m = 0; m < 12; m++) {
      var qA = makeQuestion('arith', buildTwoOperand(rng, p), 'result', p);
      if (qA) return qA;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 参数归一化与校验
  // -------------------------------------------------------------------------
  function normalizeParams(input) {
    var p = {};
    var src = input || {};
    for (var key in DEFAULT_PARAMS) if (Object.prototype.hasOwnProperty.call(DEFAULT_PARAMS, key)) p[key] = src[key];

    var validTypes = ['arith', 'mixed', 'unknown'];
    var types = Array.isArray(p.types) ? p.types.filter(function (t) { return validTypes.indexOf(t) >= 0; }) : [];
    p.types = types.length ? types : DEFAULT_PARAMS.types.slice();

    p.count = clamp(toInt(p.count, DEFAULT_PARAMS.count), 1, 200);
    p.maxValue = clamp(toInt(p.maxValue, DEFAULT_PARAMS.maxValue), 10, 1000);
    p.maxFactor = clamp(toInt(p.maxFactor, DEFAULT_PARAMS.maxFactor), 2, 12);
    var oc = Number(p.operandCount);
    p.operandCount = (oc === 2 || oc === 3) ? oc : 'random';
    p.allowParens = p.allowParens !== false;
    p.unique = p.unique !== false;
    p.seed = clamp(toInt(p.seed, DEFAULT_PARAMS.seed), 1, 999999999);
    return p;
  }

  /** 对单题做全量硬约束校验，返回问题描述数组（空数组 = 通过） */
  function validateQuestion(q, params) {
    var p = normalizeParams(params);
    var problems = [];
    if (!q || !Array.isArray(q.tokens)) return ['题目结构异常'];

    var result = evalNode(q.ast, p, problems);

    var blanks = q.tokens.filter(function (t) { return t === BLANK; }).length;
    if (blanks !== 1) problems.push('空位数量应为 1，实际为 ' + blanks);
    if (q.tokens[q.tokens.length - 1] !== BLANK && q.type !== 'unknown') problems.push('空位应位于等号之后');
    if (q.tokens.indexOf('=') < 0) problems.push('缺少等号');

    if (result != null && result !== q.result) problems.push('AST 结果与登记结果不一致');

    if (!Number.isInteger(q.answer)) problems.push('答案不是整数：' + q.answer);
    else {
      if (q.answer < 1) problems.push('答案小于 1：' + q.answer);
      if (q.answer > p.maxValue) problems.push('答案超过上限 ' + p.maxValue + '：' + q.answer);
    }

    // 位次与答案的对应关系
    if (q.type === 'unknown' && q.ast && q.ast.t === 'op') {
      var lv = evalNode(q.ast.l, p, []);
      var rv = evalNode(q.ast.r, p, []);
      var expect = q.slot === 'left' ? lv : q.slot === 'right' ? rv : result;
      if (expect !== q.answer) problems.push('答案与空位不匹配（' + q.slot + '）');
      var blankAt = q.tokens.indexOf(BLANK);
      var posOk = (q.slot === 'left' && blankAt === 0) ||
                  (q.slot === 'right' && blankAt === 2) ||
                  (q.slot === 'result' && blankAt === q.tokens.length - 1);
      if (!posOk) problems.push('空位位置与 slot 不一致');
    }
    if ((q.type === 'arith' || q.type === 'mixed') && result != null && q.answer !== result) {
      problems.push('口算/脱式题的答案应等于算式结果');
    }
    return problems;
  }

  function validateSheet(sheet, params) {
    var p = params || (sheet && sheet.params);
    var list = (sheet && sheet.questions) || [];
    var all = [];
    var byType = {};
    list.forEach(function (q, i) {
      var problems = validateQuestion(q, p);
      byType[q.type] = (byType[q.type] || 0) + 1;
      if (problems.length) all.push({ index: i + 1, display: q.display, problems: problems });
    });
    return { total: list.length, passed: list.length - all.length, failed: all, byType: byType };
  }

  // -------------------------------------------------------------------------
  // 主入口
  // -------------------------------------------------------------------------
  function generateSheet(input) {
    var p = normalizeParams(input);
    var rng = createRNG(p.seed);
    var questions = [];
    var seen = Object.create(null);
    var stats = { attempts: 0, discarded: 0, duplicates: 0, invalid: 0, byType: {} };
    var maxAttempts = p.count * 200 + 2000;

    while (questions.length < p.count && stats.attempts < maxAttempts) {
      stats.attempts++;
      var q = buildQuestion(rng, p);
      if (!q) { stats.discarded++; continue; }
      if (validateQuestion(q, p).length) { stats.invalid++; continue; }
      if (p.unique && seen[q.key]) { stats.duplicates++; continue; }
      seen[q.key] = true;
      q.index = questions.length + 1;
      stats.byType[q.type] = (stats.byType[q.type] || 0) + 1;
      questions.push(q);
    }

    var warnings = [];
    if (questions.length < p.count) {
      warnings.push('在当前参数下可生成的互不重复题目不足，实际生成 ' + questions.length + ' / ' + p.count + ' 题。');
    }

    return {
      version: VERSION,
      seed: p.seed,
      params: p,
      questions: questions,
      stats: stats,
      warnings: warnings
    };
  }

  return {
    VERSION: VERSION,
    BLANK: BLANK,
    OP_KEYS: OP_KEYS,
    DEFAULT_PARAMS: DEFAULT_PARAMS,
    symbolOf: symbolOf,
    formatTokens: formatTokens,
    isOperatorToken: isOperatorToken,
    createRNG: createRNG,
    normalizeParams: normalizeParams,
    generateSheet: generateSheet,
    validateQuestion: validateQuestion,
    validateSheet: validateSheet,
    // 以下导出仅供测试与后续扩展使用
    _internals: {
      numNode: numNode, opNode: opNode, grpNode: grpNode,
      evalNode: evalNode, tokensOf: tokensOf, buildQuestion: buildQuestion,
      MIXED_BUILDERS: MIXED_BUILDERS, ARITH_BUILDERS: ARITH_BUILDERS
    }
  };
});
