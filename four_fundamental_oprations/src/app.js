/* 出题工作台界面层 v0.1.0
 * 出题逻辑位于 engine.js（window.FQ_ENGINE）；自测通过模块接口接入。
 */
(function () {
  'use strict';

  var ENGINE = window.FQ_ENGINE;

  var TYPE_LABELS = { arith: '口算填空', mixed: '脱式混合', unknown: '求未知数' };
  var DEFAULT_QUIZ_DURATION_MINUTES = 5;
  var MAX_QUIZ_DURATION_MINUTES = 180;
  var QUIZ_HISTORY_KEY = 'fq.quiz.history.v1';

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
      contract: '在线作答 / 即时判分 / 5 分钟倒计时（已接入）'
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

  /* ------------------------------- 在线自测 ------------------------------- */
  function formatTime(seconds) {
    var mins = Math.floor(seconds / 60);
    var secs = seconds % 60;
    return String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
  }

  function readQuizHistory() {
    try {
      var value = window.localStorage.getItem(QUIZ_HISTORY_KEY);
      var records = value ? JSON.parse(value) : [];
      if (!Array.isArray(records)) throw new Error('自测记录格式无效');
      return records.filter(function (record) {
        return record && typeof record.date === 'string' &&
          Number.isInteger(record.correct) && Number.isInteger(record.total) &&
          record.total > 0 && record.correct >= 0 && record.correct <= record.total;
      }).slice(0, 10);
    } catch (err) {
      console.error('[FQ] 读取自测记录失败：', err);
      toast('无法读取本机自测记录：' + err.message, 'error');
      return [];
    }
  }

  function renderQuizHistory(records) {
    el.quizHistory.replaceChildren();
    if (!records.length) {
      var empty = document.createElement('li');
      empty.className = 'quiz-history__empty';
      empty.textContent = '完成一次自测后，成绩会保存在此浏览器。';
      el.quizHistory.appendChild(empty);
      return;
    }
    records.forEach(function (record) {
      var item = document.createElement('li');
      var date = new Date(record.date);
      item.textContent = (Number.isNaN(date.getTime()) ? record.date : date.toLocaleString('zh-CN')) +
        ' · ' + record.correct + '/' + record.total + ' 题正确' +
        (Number.isInteger(record.durationMinutes) ? ' · ' + record.durationMinutes + ' 分钟' : '');
      el.quizHistory.appendChild(item);
    });
  }

  function renderQuizQuestions(sheet) {
    el.quizQuestions.replaceChildren();
    sheet.questions.forEach(function (question, index) {
      var row = document.createElement('div');
      row.className = 'quiz-question';
      var text = document.createElement('span');
      text.className = 'quiz-question__text';
      text.textContent = question.index + '. ' + question.display;

      var input = document.createElement('input');
      input.className = 'quiz-question__answer';
      input.type = 'text';
      input.inputMode = 'numeric';
      input.pattern = '[0-9]*';
      input.autocomplete = 'off';
      input.dataset.questionIndex = String(index);
      input.setAttribute('aria-label', '第 ' + question.index + ' 题答案');
      input.addEventListener('input', updateQuizProgress);

      var feedback = document.createElement('span');
      feedback.className = 'quiz-question__feedback';
      feedback.setAttribute('aria-live', 'polite');
      row.appendChild(text);
      row.appendChild(input);
      row.appendChild(feedback);
      el.quizQuestions.appendChild(row);
    });
    el.quizQuestions.style.setProperty('--cols', String(state.cols));
  }

  function updateQuizProgress() {
    if (!state.quiz || state.quiz.finished) return;
    var inputs = Array.prototype.slice.call(el.quizQuestions.querySelectorAll('.quiz-question__answer'));
    var answered = 0;
    inputs.forEach(function (input) {
      if (input.value.trim()) answered++;
    });
    el.quizProgress.textContent = '已填写 ' + answered + '/' + inputs.length + ' 题 · 交卷后统一判分';
  }

  function finishQuiz() {
    if (!state.quiz || !state.quiz.started || state.quiz.finished) return;
    state.quiz.finished = true;
    clearInterval(state.quiz.timer);
    var inputs = Array.prototype.slice.call(el.quizQuestions.querySelectorAll('.quiz-question__answer'));
    var correct = 0;
    inputs.forEach(function (input) {
      var question = state.quiz.sheet.questions[Number(input.dataset.questionIndex)];
      var value = input.value.trim();
      var isCorrect = /^\d+$/.test(value) && Number(value) === question.answer;
      var feedback = input.parentNode.querySelector('.quiz-question__feedback');
      input.disabled = true;
      input.classList.remove('quiz-question__answer--correct', 'quiz-question__answer--incorrect');
      feedback.classList.remove('quiz-question__feedback--correct', 'quiz-question__feedback--incorrect');
      if (isCorrect) {
        correct++;
        input.classList.add('quiz-question__answer--correct');
        feedback.classList.add('quiz-question__feedback--correct');
        feedback.textContent = '正确';
      } else {
        input.classList.add('quiz-question__answer--incorrect');
        feedback.classList.add('quiz-question__feedback--incorrect');
        feedback.textContent = '答案：' + question.answer;
      }
    });

    var total = inputs.length;
    var record = {
      date: new Date().toISOString(),
      correct: correct,
      total: total,
      durationMinutes: state.quiz.durationMinutes
    };
    el.quizTimer.textContent = formatTime(state.quiz.remaining);
    el.quizProgress.textContent = '自测已结束 · 答对 ' + correct + '/' + total + ' 题';
    el.quizResult.textContent = '本次得分：' + correct + ' / ' + total +
      '（' + Math.round(correct * 100 / total) + ' 分）' +
      (state.quiz.remaining === 0 ? ' · 时间到' : '');
    el.quizResult.hidden = false;
    el.quizSubmit.hidden = true;
    el.quizRestart.hidden = false;

    var records = [record].concat(readQuizHistory()).slice(0, 10);
    renderQuizHistory(records);
    try {
      window.localStorage.setItem(QUIZ_HISTORY_KEY, JSON.stringify(records));
    } catch (err) {
      console.error('[FQ] 保存自测记录失败：', err);
      toast('本次成绩已显示，但无法保存到本机：' + err.message, 'error');
    }
  }

  function prepareQuiz(sheet) {
    if (!sheet || !sheet.questions || !sheet.questions.length) {
      throw new Error('当前没有可用于自测的题目，请先生成题目');
    }
    clearInterval(state.quiz && state.quiz.timer);
    state.quiz = { sheet: sheet, remaining: 0, durationMinutes: null, finished: false, timer: null, started: false };
    el.quizQuestions.replaceChildren();
    renderQuizHistory(readQuizHistory());
    el.quizDuration.value = el.quizDuration.value || String(DEFAULT_QUIZ_DURATION_MINUTES);
    el.quizSetup.hidden = false;
    el.quizStatus.hidden = true;
    el.quizQuestions.hidden = true;
    el.quizResult.hidden = true;
    el.quizSubmit.hidden = true;
    el.quizStart.hidden = false;
    el.quizRestart.hidden = true;
    if (!el.quizDialog.open) el.quizDialog.showModal();
    el.quizDuration.focus();
  }

  function startQuiz() {
    if (!state.quiz || state.quiz.started) return;
    var durationMinutes = Number(el.quizDuration.value);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 ||
        durationMinutes > MAX_QUIZ_DURATION_MINUTES) {
      toast('自测时长请输入 1 到 ' + MAX_QUIZ_DURATION_MINUTES + ' 之间的整数分钟', 'warn');
      el.quizDuration.focus();
      return;
    }

    state.quiz.durationMinutes = durationMinutes;
    state.quiz.remaining = durationMinutes * 60;
    state.quiz.started = true;
    renderQuizQuestions(state.quiz.sheet);
    el.quizSetup.hidden = true;
    el.quizStatus.hidden = false;
    el.quizQuestions.hidden = false;
    el.quizTimer.textContent = formatTime(state.quiz.remaining);
    el.quizProgress.textContent = '已填写 0/' + state.quiz.sheet.questions.length + ' 题 · 交卷后统一判分';
    el.quizResult.hidden = true;
    el.quizSubmit.hidden = false;
    el.quizStart.hidden = true;
    el.quizRestart.hidden = true;
    el.quizQuestions.querySelector('.quiz-question__answer').focus();
    state.quiz.timer = setInterval(function () {
      if (!state.quiz || state.quiz.finished) return;
      state.quiz.remaining--;
      el.quizTimer.textContent = formatTime(state.quiz.remaining);
      if (state.quiz.remaining <= 0) finishQuiz();
    }, 1000);
  }

  function startQuizWithSheet(sheet) {
    prepareQuiz(sheet);
  }

  function restartQuiz() {
    if (state.quiz) prepareQuiz(state.quiz.sheet);
  }

  function closeQuiz() {
    if (el.quizDialog.open) el.quizDialog.close();
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

  /* ----------------------------- 模块接口 ----------------------------- */
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
      if (state.quiz && !state.quiz.finished) {
        el.quizQuestions.style.setProperty('--cols', String(state.cols));
      }
    });

    el.quizSubmit.addEventListener('click', finishQuiz);
    el.quizStart.addEventListener('click', startQuiz);
    el.quizDuration.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') startQuiz();
    });
    el.quizClose.addEventListener('click', closeQuiz);
    el.quizRestart.addEventListener('click', function () {
      restartQuiz();
    });
    el.actions.addEventListener('click', function (e) {
      var button = e.target.closest('button[data-module]');
      if (button) runModule(button.dataset.module);
    });
    el.quizDialog.addEventListener('close', function () {
      clearInterval(state.quiz && state.quiz.timer);
      state.quiz = null;
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
      quizDialog: $('quiz-dialog'),
      quizSetup: $('quiz-setup'),
      quizDuration: $('quiz-duration'),
      quizStart: $('quiz-start'),
      quizStatus: $('quiz-status'),
      quizQuestions: $('quiz-questions'),
      quizTimer: $('quiz-timer'),
      quizProgress: $('quiz-progress'),
      quizResult: $('quiz-result'),
      quizSubmit: $('quiz-submit'),
      quizClose: $('quiz-close'),
      quizRestart: $('quiz-restart'),
      quizHistory: $('quiz-history'),
      actionHint: $('actionbar-hint'),
      toast: $('toast'),
      engineVersion: $('engine-version')
    };

    el.engineVersion.textContent = '引擎 v' + ENGINE.VERSION;
    el.actionHint.textContent = '在线自测可自定义时长；成绩保存在当前浏览器。打印与批量生成仍在规划中。';

    state.modules.quiz = { run: startQuizWithSheet };
    applyParamsToControls(ENGINE.DEFAULT_PARAMS);
    buildActionBar();
    bind();
    generate();

    console.info(
      '[FQ] 出题工作台 v' + ENGINE.VERSION + '\n' +
      '· FQ.getSheet() 取当前题目（含 params / questions / seed / stats）\n' +
      '· FQ.setParams({ maxValue: 20, types: ["arith"] }) 改参数并重新出题\n' +
      '· 在线自测已接入「开始自测」模块入口\n' +
      '· FQ.registerModule("print", { run(sheet) { /* 待实现 */ } }) 接入预留模块\n' +
      '· FQ.on("sheet:generated", sheet => {}) 监听重新出题'
    );
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
