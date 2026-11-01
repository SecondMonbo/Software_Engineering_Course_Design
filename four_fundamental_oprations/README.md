# 四则运算出题工作台（第一阶段：可展示前端 + 预留接口）

小学二年级四则运算出题工具。本阶段交付的是**可展示的前端页面 + 真实可用的出题引擎**，
打印 / 自测 / 批量三个模块**只预留接口、尚未实现**。

## 快速开始

双击打开 `index.html` 即可（单文件、零依赖、可离线，不需要装任何东西、不需要起服务）。

也可以用浏览器打开：

```
file:///D:/DSH_TEST/four_fundamental_oprations/index.html
```

## 本阶段已实现

- **出题引擎**：口算填空、脱式混合运算、求未知数三种题型，全部按硬约束构造式生成
- **参数面板**：题型多选、每套题量（1–100）、加减法上限（20 / 50 / 100）、
  运算数个数（固定 2 / 固定 3 / 随机 2～3）、允许括号、同套不重复、随机种子
- **题目预览**：屏幕预览（2/3/4 列可切）、可选显示答案
- **指标面板**：题量、随机种子、题型分布、约束校验结果、生成耗时、去重丢弃数
- **可复现**：同参数 + 同种子 → 完全相同的一套题
- **预留接口**：打印 / 自测 / 批量三个按钮，点击会提示尚未实现并给出接口用法

## 本阶段明确未实现（只留接口）

| 模块 | 计划内容 | 接口 |
| --- | --- | --- |
| 打印试卷 | A4 分页版式、答案独页、字号与列数打印控制 | `FQ.registerModule('print', { run(sheet) {} })` |
| 在线自测 | 文本框作答、即时判分、倒计时 5 分钟、成绩与历史记录 | `FQ.registerModule('quiz', { run(sheet) {} })` |
| 批量生成 | 一次 N 套、页面内切换、打包 ZIP 下载 | `FQ.registerModule('batch', { run(sheet) {} })` |

> `styles.css` 末尾那段 `@media print` 只是为了浏览器打印时别把工具栏打进去，
> 属于临时规则，正式版式实现后应替换。

## 出题硬约束

1. 结果与所有中间结果均非负；
2. 加减法结果不超过上限（默认 100）；
3. 乘除限表内：裸数字因数 ≤ 9，除法必须整除；两个裸数字相除时被除数不超过 81；
4. 括号内整体参与乘除时不受“表内”限制，但仍受上限限制（如 `12 + 3 × 5`、`(12 + 8) × 3`）；
5. 操作数均为 ≥ 1 的整数，除数 ≥ 2；
6. 同套内题目不重复，重复即丢弃重抽。

这些约束由**构造式出题**保证（先定结构再按可用区间取数），生成后再由 `validateQuestion` 二次校验，
校验不通过的题一律不进卷。

## 目录结构

```
index.html                ← 构建产物：单文件成品，双击即用（不要直接改）
src/engine.js             ← 出题引擎（纯逻辑，浏览器 + Node 双端可用）
src/app.js                ← 界面层：参数面板、题目渲染、预留模块接口、事件总线
src/styles.css            ← 样式
src/index.template.html   ← HTML 骨架（含注入标记）
build.mjs                 ← 把 src/ 内联进 index.html
tools/verify-engine.cjs   ← 引擎约束验证（6467 项断言）
tools/check-page.cjs      ← 模板与脚本的接线自检
tools/dom-smoke.cjs       ← 真实浏览器渲染结果自检
```

## 开发命令

```bash
npm run verify     # 只跑引擎约束验证
npm run build      # 重新构建 index.html
npm run check      # 验证 + 接线自检 + 构建（改完源码跑这个）
```

改界面请改 `src/` 下的源码，然后 `npm run check` 重新生成 `index.html`。

浏览器渲染自检（需要本机 Edge / Chrome）：

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu `
  --virtual-time-budget=3000 --dump-dom "file:///D:/DSH_TEST/four_fundamental_oprations/index.html" `
  > tools/_dom.html
node tools/dom-smoke.cjs tools/_dom.html
```

## 页面接口（浏览器控制台可用）

```js
FQ.getSheet()        // 当前题目：{ seed, params, questions, stats, warnings }
FQ.getParams()       // 当前参数
FQ.setParams({ maxValue: 20, types: ['arith'] })   // 改参数并重新出题
FQ.regenerate()      // 按当前界面参数重新出题
FQ.on('sheet:generated', sheet => {})              // 重新出题时回调
FQ.registerModule('print', { run(sheet) { /* 待实现 */ } })
```

`questions[i]` 的字段：

| 字段 | 说明 |
| --- | --- |
| `index` | 题号（从 1 开始） |
| `type` | `arith` / `mixed` / `unknown` |
| `tokens` | 展示用 token 数组，空位记为 `□`，运算符为 ASCII `+ - * /`，括号为独立 token |
| `slot` | 空位位置：`result` / `left` / `right` |
| `result` | 整个算式的值 |
| `answer` | 应填的答案（`unknown` 时可能不等于 `result`） |
| `operandCount` | 运算数个数 |
| `key` | 去重键 |
| `display` | 题面文本，如 `(12 + 8) × 3 = □` |
| `solution` | 含答案的完整等式，如 `(12 + 8) × 3 = 60` |

> 打印模块可直接用 `tokens` 做分列排版；自测模块可用 `answer` 判分；
> 批量模块换 `params.seed` 反复调 `FQ.engine.generateSheet` 即可。

## 验证情况

| 项目 | 结果 |
| --- | --- |
| 引擎约束验证 | 6467 项断言通过（10 组参数矩阵 × 60 题，含独立递归下降复算、token 层表内检查、种子可复现、异常参数归一化） |
| 页面接线自检 | 50 项断言通过 |
| 真实浏览器渲染 | 21 项断言通过，20/20 题渲染、约束校验 `通过 20/20` |
