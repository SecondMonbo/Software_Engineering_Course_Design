// 单行注释
const s = "not // comment # neither";

/* 块注释
   第二行 */
let total = 0;  // 尾部注释

function add(a, b) {
  // 注释
  const t = `template ${a} + ${b}`;
  return t.length;
}

total = add(1, 2);
