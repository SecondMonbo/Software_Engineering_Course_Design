/*!
 * 页面接线自检：不依赖浏览器，静态核对模板与脚本是否对得上
 *   node tools/check-page.cjs
 *
 * 检查项：
 *   1. app.js 引用的每个元素 id 都存在于模板中；
 *   2. 模板中每个 id 都被 app.js 引用（防止写了没用到的控件）；
 *   3. 构建产物 index.html 中内联了引擎与界面脚本，且注入标记已全部替换；
 *   4. script / style 标签数量符合预期（无外部依赖）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const template = read('src/index.template.html');
const app = read('src/app.js');
const built = read('index.html');

const failures = [];
let passed = 0;
const check = (ok, label, detail) => {
  if (ok) { passed++; return; }
  failures.push(label + (detail ? ' → ' + detail : ''));
};

// 1) 模板里的 id
const templateIds = new Set();
for (const m of template.matchAll(/\sid="([^"]+)"/g)) templateIds.add(m[1]);

// 2) app.js 引用的 id
const referencedIds = new Set();
for (const m of app.matchAll(/getElementById\('([^']+)'\)/g)) referencedIds.add(m[1]);
for (const m of app.matchAll(/\$\('([^']+)'\)/g)) referencedIds.add(m[1]);

for (const id of referencedIds) {
  check(templateIds.has(id), `app.js 引用的 id「${id}」应存在于模板中`);
}
for (const id of templateIds) {
  check(referencedIds.has(id), `模板中的 id「${id}」应被 app.js 使用（避免留下无用控件）`);
}

// 3) 选择器依赖：app.js 用到的容器选择器必须在模板中存在
check(templateIds.has('types'), 'app.js 依赖 #types 容器');
check(/#types input\[type=checkbox\]/.test(app), 'app.js 通过 #types 下的复选框读取题型');
check(/id="types"/.test(template) && /type="checkbox" value="arith"/.test(template),
      '模板中 #types 内应有 arith 复选框');

// 4) 构建产物
check(!/@inject:/.test(built), 'index.html 中不应残留注入标记');
check(built.includes('四则运算出题引擎'), 'index.html 应内联引擎脚本');
check(built.includes('出题工作台界面层'), 'index.html 应内联界面脚本');
check((built.match(/<script/g) || []).length === 2, 'index.html 应只有 2 个内联 script 块');
check((built.match(/<style/g) || []).length === 1, 'index.html 应只有 1 个内联 style 块');
check(!/<script[^>]+src=/.test(built), 'index.html 不应引用外部脚本（零依赖）');
check(!/<link[^>]+href=/.test(built), 'index.html 不应引用外部样式（零依赖）');
check(!/https?:\/\//.test(built), 'index.html 不应包含外部网络地址');

// 5) 预留接口是否齐备
['print', 'quiz', 'batch'].forEach((key) => {
  check(app.includes(`key: '${key}'`), `预留模块「${key}」应已声明`);
});
check(/registerModule: registerModule/.test(app), 'FQ.registerModule 应对外暴露');
check(/window\.FQ = FQ/.test(app), '应挂载 window.FQ');

console.log('页面接线自检');
console.log('通过断言：' + passed);
if (failures.length) {
  console.log('\n失败 ' + failures.length + ' 项：');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('接线检查通过 ✓');
