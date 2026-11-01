/* 出题工作台界面层 v0.1.0
 * 只负责界面与预留接口；出题逻辑全部在 engine.js（window.FQ_ENGINE）。
 * 打印 / 自测 / 批量三个模块为预留接口，见文件顶部 RESERVED_MODULES 的契约说明。
 */
(function () {
  'use strict';

  var ENGINE = window.FQ_ENGINE;

  var TYPE_LABELS = { arith: '口算填空', mixed: '脱式混合', unknown: '求未知数' };

  /* -------------------------------------------------------------------------
   * 预留模块清单
   * 契约：FQ.registerModule(key, { run(sheet) { ... } })
   *   key   —— 'print' | 'quiz' | 'batch'
   *   sheet —— FQ.getSheet() 的返回值：{ seed, params, questions, stats, warnings }
   *            questions[i] = { index, type, tokens, slot, result, answer,
   *                             operandCount, key, display, solution }
   * 注册后对应按钮自动变为可用状态，点击即调用 run(sheet)。
   * ---------------------------------------------------------------------- */
  var RESERVED_MODULES = [
    {
      key: 'print',
      label: '打印试卷',
      hint: 'A4 分页版式 + 答案独页',
      contract: 'FQ.registerModule("print", { run(sheet) {} })'
    },
    {
      key: 'quiz',
      label: '开始自测',
      hint: '在线作答 / 即时判分 / 倒计时',
      contract: 'FQ.registerModule("quiz", { run(sheet) {} })'
    },
    {
      key: 'batch',
      label: '批量生成',
      hint: '一次 N 套 + 打包导出',
      contract: 'FQ.registerModule("batch", { run(sheet) {} })'
    }
  ];

  var state = {
    params: null,
    sheet: null,
    showAnswers: false,
    cols: 3,
    modules: {},
    listeners: {}
  };

  var el = {};
  function $(id) { return document.getElementById(id); }

  /* ------------------------------ 事件总线 ------------------------------ */
  function on(evt, cb) {
    (state.listeners[evt] = state.listeners[evt] || []).push(cb);
    return function () { off(evt, cb); };
  }
  function off(evt, cb) {
    var list = state.listeners[evt] || [];
    var i = list.indexOf(cb);
    if (i >= 0) list.splice(i, 1);
  }
  function emit(evt, payload) {
    (state.listeners[evt] || []).slice().forEach(function (cb) {
      try { cb(payload); } catch (err) { console.error('[FQ] 监听器出错：', err); }
    });
  }

  /* -------------------------------- 提示 -------------------------------- */
  var toastTimer = null;
  function toast(msg, kind) {
    var node = el.toast;
    node.textContent = msg;
    node.className = 'toast toast--show' + (kind ? ' toast--' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.className = 'toast'; }, 4600);
  }

  /* ------------------------------ 参数读写 ------------------------------ */
  function collectParams() {
    var types = Array.prototype.slice.call(document.querySelectorAll('#types input[type=checkbox]'))
      .filter(function (c) { return c.checked; })
      .map(function (c) { return c.value; });
    return {
      types: types,
      count: Number(el.count.value),
      maxValue: Number(el.maxValue.value),
      operandCount: el.operandCount.value,
      allowParens: el.allowParens.checked,
      unique: el.unique.checked,
      maxFactor: 9,
      seed: Number(el.seed.value)
    };
  }

  function applyParamsToControls(params) {
    var p = ENGINE.normalizeParams(params || ENGINE.DEFAULT_PARAMS);
    Array.prototype.slice.call(document.querySelectorAll('#types input[type=checkbox]'))
      .forEach(function (c) { c.checked = p.types.indexOf(c.value) >= 0; });
    el.count.value = p.count;
    el.maxValue.value = String(p.maxValue);
    el.operandCount.value = String(p.operandCount);
    el.allowParens.checked = p.allowParens;
    el.unique.checked = p.unique;
    el.seed.value = p.seed;
  }

  /* ------------------------------- 渲染层 ------------------------------- */
  function exprHTML(q) {
    return q.tokens.map(function (tk) {
      if (tk === ENGINE.BLANK) return '<i class="blank" title="填空"></i>';
      if (tk === '(') return '<span class="paren">(</span>';
      if (tk === ')') return '<span class="paren">)</span>';
      if (tk === '=') return '<span class="eq">=</span>';
      if (ENGINE.isOperatorToken(tk)) return '<span class="op">' + ENGINE.symbolOf(tk) + '</span>';
      return '<span class="num">' + tk + '</span>';
    }).join('');
  }

  function metric(label, value, kind) {
    return '<span class="metric' + (kind ? ' metric--' + kind : '') + '">' +
      label + ' <b>' + value + '</b></span>';
  }

  function renderMetrics(sheet) {
    var report = ENGINE.validateSheet(sheet, sheet.params);
    var byType = Object.keys(report.byType).map(function (k) {
      return TYPE_LABELS[k] + ' ' + report.byType[k];
    }).join(' · ') || '—';

    var html = [
      metric('题量', sheet.questions.length + ' / ' + sheet.params.count),
      metric('随机种子', sheet.seed),
      metric('题型分布', byType),
      report.failed.length
        ? metric('约束校验', '失败 ' + report.failed.length + ' 题', 'bad')
        : metric('约束校验', '通过 ' + report.passed + '/' + report.total, 'ok'),
      metric('生成耗时', (sheet.elapsedMs != null ? sheet.elapsedMs + ' ms' : '—')),
      metric('去重丢弃', sheet.stats.duplicates + sheet.stats.discarded)
    ].join('');

    if (sheet.warnings.length) {
      html += '<p class="warnings">' + sheet.warnings.join('<br>') + '</p>';
    }
    el.metrics.innerHTML = html;
  }

  function renderPaper(sheet) {
    el.paper.style.setProperty('--cols', String(state.cols));

    var head = '<div class="paper__head">' +
      '<div class="paper__title">二年级四则运算 · ' + sheet.params.maxValue + ' 以内加减 + 表内乘除</div>' +
      '<div class="paper__meta">共 ' + sheet.questions.length + ' 题　姓名 __________　用时 ______</div>' +
      '</div>';

    var items = sheet.questions.map(function (q) {
      return '<div class="q" data-type="' + q.type + '">' +
        '<span class="q__no">' + q.index + '</span>' +
        '<span class="q__body">' + exprHTML(q) + '</span>' +
        (state.showAnswers ? '<span class="q__ans">' + q.answer + '</span>' : '') +
        '</div>';
    }).join('');

    el.paper.innerHTML = head + '<div class="paper__grid">' + items + '</div>';

    if (!sheet.questions.length) {
      el.paper.innerHTML = head + '<p class="hint">当前参数下没有生成出题目。</p>';
    }
  }

  /* ------------------------------- 出题 ------------------------------- */
  function generate() {
    var params = collectParams();
    if (!params.types.length) {
      toast('至少要保留一种题型', 'warn');
      return;
    }
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    state.params = params;
    var sheet = ENGINE.generateSheet(params);
    var t1 = (window.performance && performance.now) ? performance.now() : Date.now();
    sheet.elapsedMs = Math.max(0, Math.round(t1 - t0));
    state.sheet = sheet;

    renderMetrics(sheet);
    renderPaper(sheet);
    emit('sheet:generated', sheet);
  }

  /* --------------------------- 预留模块接口 --------------------------- */
  function moduleSpec(key) {
    for (var i = 0; i < RESERVED_MODULES.length; i++) {
      if (RESERVED_MODULES[i].key === key) return RESERVED_MODULES[i];
    }
    return null;
  }

  function buildActionBar() {
    el.actions.innerHTML = RESERVED_MODULES.map(function (m) {
      var impl = state.modules[m.key];
      return '<button class="btn btn--module" type="button" data-module="' + m.key + '"' +
        ' title="' + m.contract + '">' +
        '<span>' + m.label + '</span>' +
        '<em class="badge' + (impl ? ' badge--ready' : '') + '">' + (impl ? '已接入' : '预留') + '</em>' +
        '<small>' + m.hint + '</small>' +
        '</button>';
    }).join('');
  }

  function registerModule(key, impl) {
    if (!moduleSpec(key)) throw new Error('未知模块：' + key + '（可用：print / quiz / batch）');
    if (!impl || typeof impl.run !== 'function') throw new Error('模块实现必须提供 run(sheet) 方法');
    state.modules[key] = impl;
    buildActionBar();
    emit('module:registered', { key: key, impl: impl });
    toast('模块「' + moduleSpec(key).label + '」已接入', 'ok');
  }

  function runModule(key) {
    var spec = moduleSpec(key);
    var impl = state.modules[key];
    if (!spec) return;
    if (!impl) {
      toast('「' + spec.label + '」尚未实现。预留接口：' + spec.contract, 'warn');
      return;
    }
    try {
      var result = impl.run(state.sheet, FQ);
      if (result && typeof result.then === 'function') {
        result.catch(function (err) { toast('「' + spec.label + '」执行出错：' + err.message, 'error'); });
      }
    } catch (err) {
      toast('「' + spec.label + '」执行出错：' + err.message, 'error');
    }
  }

  /* ------------------------------- 绑定 ------------------------------- */
  function bind() {
    el.types.addEventListener('change', function (e) {
      var checked = document.querySelectorAll('#types input[type=checkbox]:checked');
      if (!checked.length) {
        e.target.checked = true;
        toast('至少要保留一种题型', 'warn');
        return;
      }
      generate();
    });

    [el.count, el.maxValue, el.operandCount, el.allowParens, el.unique].forEach(function (node) {
      node.addEventListener('change', generate);
    });

    el.seed.addEventListener('change', generate);
    el.seed.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') generate();
    });

    el.reseed.addEventListener('click', function () {
      el.seed.value = String(1 + Math.floor(Math.random() * 999999999));
      generate();
    });

    el.regenerate.addEventListener('click', generate);

    el.showAnswers.addEventListener('change', function () {
      state.showAnswers = el.showAnswers.checked;
      if (state.sheet) renderPaper(state.sheet);
    });

    el.cols.addEventListener('change', function () {
      state.cols = Number(el.cols.value) || 3;
      if (state.sheet) renderPaper(state.sheet);
    });

    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); generate(); }
    });
  }

  /* ------------------------------- 对外 API ------------------------------- */
  var FQ = {
    version: ENGINE.VERSION,
    engine: ENGINE,
    TYPE_LABELS: TYPE_LABELS,
    RESERVED_MODULES: RESERVED_MODULES,
    state: state,
    on: on,
    off: off,
    emit: emit,
    getSheet: function () { return state.sheet; },
    getParams: function () { return state.params; },
    regenerate: generate,
    registerModule: registerModule,
    setParams: function (patch) {
      applyParamsToControls(Object.assign({}, state.params || ENGINE.DEFAULT_PARAMS, patch || {}));
      generate();
      return state.sheet;
    }
  };
  window.FQ = FQ;

  /* ------------------------------- 启动 ------------------------------- */
  function init() {
    el = {
      types: document.getElementById('types'),
      count: $('count'),
      maxValue: $('maxValue'),
      operandCount: $('operandCount'),
      allowParens: $('allowParens'),
      unique: $('unique'),
      seed: $('seed'),
      reseed: $('reseed'),
      regenerate: $('regenerate'),
      showAnswers: $('showAnswers'),
      cols: $('cols'),
      metrics: $('metrics'),
      paper: $('paper'),
      actions: $('actionbar-buttons'),
      actionHint: $('actionbar-hint'),
      toast: $('toast'),
      engineVersion: $('engine-version')
    };

    el.engineVersion.textContent = '引擎 v' + ENGINE.VERSION;
    el.actionHint.textContent = '打印 / 自测 / 批量 三个模块仅预留接口，未实现。';

    applyParamsToControls(ENGINE.DEFAULT_PARAMS);
    buildActionBar();
    bind();
    generate();

    console.info(
      '[FQ] 出题工作台 v' + ENGINE.VERSION + '\n' +
      '· FQ.getSheet() 取当前题目（含 params / questions / seed / stats）\n' +
      '· FQ.setParams({ maxValue: 20, types: ["arith"] }) 改参数并重新出题\n' +
      '· FQ.registerModule("print", { run(sheet) { /* 待实现 */ } }) 接入预留模块\n' +
      '· FQ.on("sheet:generated", sheet => {}) 监听重新出题'
    );
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
