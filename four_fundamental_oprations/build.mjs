/*!
 * 构建脚本：把 src/ 下的样式与脚本内联进单个 index.html
 *   node build.mjs        # 等价于 npm run build
 *
 * 产物 index.html 是完全自包含的单文件（零依赖、零 CDN），双击即可打开。
 * 修改界面请改 src/ 下的源码后重新构建，不要直接编辑 index.html。
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => path.join(root, 'src', p);
const read = (p) => readFileSync(src(p), 'utf8');

const template = read('index.template.html');
const styles = read('styles.css');
const engine = read('engine.js');
const app = read('app.js');

// 内联进 <script> 的代码不得包含 </script，否则会提前结束脚本块
for (const [name, code] of [['engine.js', engine], ['app.js', app]]) {
  if (/<\/script/i.test(code)) {
    throw new Error(`src/${name} 含有 </script 字样，无法安全内联`);
  }
}
if (/<\/style/i.test(styles)) {
  throw new Error('src/styles.css 含有 </style 字样，无法安全内联');
}

const markers = ['/* @inject:styles */', '/* @inject:engine */', '/* @inject:app */'];
for (const marker of markers) {
  const count = template.split(marker).length - 1;
  if (count !== 1) {
    throw new Error(`模板中标记「${marker}」应恰好出现 1 次，实际 ${count} 次`);
  }
}

const out = template
  .replace('/* @inject:styles */', () => styles)
  .replace('/* @inject:engine */', () => engine)
  .replace('/* @inject:app */', () => app);

const leftovers = out.match(/@inject:[a-z]+/g);
if (leftovers) {
  throw new Error('模板中仍有未替换的标记：' + leftovers.join(', '));
}

const target = path.join(root, 'index.html');
writeFileSync(target, out, 'utf8');

const bytes = statSync(target).size;
const lines = out.split('\n').length;
console.log(
  `已生成 index.html（${lines} 行，${(bytes / 1024).toFixed(1)} KB）\n` +
  `  · src/styles.css  ${styles.split('\n').length} 行\n` +
  `  · src/engine.js   ${engine.split('\n').length} 行\n` +
  `  · src/app.js      ${app.split('\n').length} 行`
);
