#include <iostream>

// C++ 行注释
int main() {
    const char *s = "/* not comment */";
    std::cout << s << std::endl;  // 尾部注释
    /* 块注释
       inside */
    return 0;
}
