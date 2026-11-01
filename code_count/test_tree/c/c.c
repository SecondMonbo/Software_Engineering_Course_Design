#include <stdio.h>

/* 文件头注释
   第二行 */
int main(void) {
    // 行注释
    const char *s = "/* 不是注释 */ // 也不是";
    printf("%s\n", s); /* 尾部块注释 */
    return 0;          // 完成
}
