/*!
 * 真实浏览器渲染结果自检（配合 Edge/Chrome 的 --dump-dom 使用）
 *   msedge --headless=new --dump-dom file:///.../index.html > tools/_dom.html
 *   node tools/dom-smoke.cjs tools/_dom.html
 *
 * 目的：确认内联脚本在真实浏览器里执行成功，且题目确实渲染到了页面上。
 * 若脚本抛错，页面上的题目容器会是空的，本脚本即失败。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2];
if (!file) {
  console.error('用法：node tools/dom-smoke.cjs <dump-dom 输出文件>');
  process.exit(2);
}

const raw = fs.readFileSync(path.resolve(file), 'utf8');

// --dump-dom 会把内联的 <script> / <style> 源码一并输出，必须先剥离，
// 否则里面的字符串字面量与 CSS 规则会造成误判。
const html = raw
  .replace(/<script[\s\S]*?<\/script>/gi, '<!-- stripped -->')
  .replace(/<style[\s\S]*?<\/style>/gi, '<!-- stripped -->');

const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// 调试用：node tools/dom-smoke.cjs tools/_dom.html --raw [数量]
// 打印题目节点的原始 HTML，便于核对渲染细节。
if (process.argv[3] === '--raw') {
  const limit = Number(process.argv[4]) || 3;
  const nodes = html.match(/<div class="q"[\s\S]*?<\/div>/g) || [];
  console.log('题目节点匹配数：' + nodes.length + '\n');
  nodes.slice(0, limit).forEach((s, i) => console.log('[' + (i + 1) + '] ' + s + '\n'));
  process.exit(0);
}

const failures = [];
let passed = 0;
const check = (ok, label, detail) => {
  if (ok) { passed++; return; }
  failures.push(label + (detail ? ' → ' + detail : ''));
};

const count = (re) => (html.match(re) || []).length;
const metricText = (label) => {
  const m = html.match(new RegExp('<span class="metric[^"]*">' + label + ' <b>([^<]*)</b>'));
  return m ? m[1] : null;
};

// ---- 题目渲染 ----
const questions = [...html.matchAll(/<div class="q"[^>]*>([\s\S]*?)<\/div>\s*(?=<div class="q"|<\/div>)/g)]
  .map((m) => strip(m[1]))
  .filter((s) => s.length > 0);

const qDivs = count(/<div class="q" /g);
check(qDivs >= 20, '应渲染出至少 20 道题（默认题量）', '实际 ' + qDivs + ' 个题目节点');
check(count(/class="blank"/g) === qDivs, '每题应恰好有一个空位',
      '空位 ' + count(/class="blank"/g) + ' 个 / 题目 ' + qDivs + ' 个');
check(count(/class="q__no"/g) === qDivs, '每题应有题号');

// ---- 运算符渲染成数学符号 ----
check(/[×÷−]/.test(html), '运算符应渲染为 × ÷ − 而非 ASCII 符号');

// ---- 指标与统计 ----
const validateMetric = metricText('约束校验');
const seedMetric = metricText('随机种子');
const countMetric = metricText('题量');
check(validateMetric != null, '应显示约束校验指标');
check(validateMetric != null && /^通过 \d+\/\d+$/.test(validateMetric),
      '约束校验应为“通过 N/N”', String(validateMetric));
check(validateMetric != null && validateMetric.replace(/^通过 /, '').split('/')[0] ===
      validateMetric.replace(/^通过 /, '').split('/')[1],
      '约束校验的分子分母应相等（无失败题）', String(validateMetric));
check(seedMetric === '20240501', '应显示当前随机种子', String(seedMetric));
check(countMetric === '20 / 20', '题量指标应为 20 / 20', String(countMetric));
check(!/metric--bad/.test(html), '不应出现失败的校验指标');

// ---- 顶栏与预留模块 ----
check(/引擎 v0\.1\.0/.test(html), '应显示引擎版本号');
const moduleButtons = count(/data-module="/g);
check(moduleButtons === 3, '底部应有 3 个预留模块按钮', '实际 ' + moduleButtons + ' 个');
['print', 'quiz', 'batch'].forEach((k) => {
  check(html.includes('data-module="' + k + '"'), '应存在预留按钮：' + k);
});
check(count(/>预留</g) === 3, '三个按钮都应标记为「预留」', '标记数 ' + count(/>预留</g));

// ---- 参数面板状态 ----
check(/id="types"[\s\S]*?value="arith" checked/.test(html), '题型默认全选');
check(/id="count"[^>]*value="20"/.test(html), '题量默认 20');
check(/id="maxValue"[\s\S]*?value="100" selected/.test(html), '加减法上限默认 100');
check(/id="seed"[^>]*value="20240501"/.test(html), '种子默认 20240501');

// ---- 无模板残留 ----
check(!/@inject:/.test(html), '不应残留注入标记');

// ---- 出题内容抽样 ----
const sample = questions.slice(0, 12);
console.log('渲染到的题目抽样：');
sample.forEach((q, i) => console.log('  ' + (i + 1) + '. ' + q));

console.log('\n渲染自检：通过断言 ' + passed + '，题目节点 ' + qDivs + ' 个');
if (failures.length) {
  console.log('\n失败 ' + failures.length + ' 项：');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('真实浏览器渲染检查通过 ✓');
