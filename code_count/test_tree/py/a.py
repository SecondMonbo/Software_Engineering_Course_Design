#!/usr/bin/env python3
"""模块级 docstring
第二行 docstring
第三行"""

import os  # 导入模块

# 纯注释行

def hello(name):
    """函数 docstring
    第二行
    """
    # 函数内注释
    msg = "这段 # 不是注释 // 也不是"
    print(msg)  # 尾部注释
    return len(name)

value = '''多行字符串
第二行'''

if __name__ == "__main__":
    print(hello("world"))
