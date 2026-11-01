# code_counter — 代码行数统计工具

一个代码行数统计程序（Python 编写，无第三方依赖），支持命令行运行，并提供代码函数统计表格界面。

## 功能

- 输入一个**文件夹路径**或 **GitHub 仓库链接**，自动递归统计源码
- 识别常见编程语言（扩展名 → 语言映射内置 35+ 种）
- 输出 **Language | files | blank | comment | code** 汇总表，最后一行 **sum** 为合计
  （blank=空行，comment=注释行，code=有效代码行）
- **字符串感知式**扫描：逐字符状态机处理，`print("// 这不是注释")` 里的 `//`、`"# 不是注释"` 里的 `#` **不会被误判**为注释
- 加 `--detail` 可查看每个文件的明细（同样分 blank / comment / code）
- 图形界面可将统计结果保存为 **JSON、TXT 或 DOCX**；导出器采用抽象策略并通过 `ExportService` 注入，新增格式可独立扩展
- 编码自动处理：**UTF-8 优先，失败自动回退 GBK**（中文 Windows 常见）
- 运行结束时输出**本次任务耗时**（自动选择 毫秒 / 秒 / 分秒 单位）
- 自动跳过 `.git`、`node_modules`、`__pycache__` 等非源码目录（可用 `--all` 关闭）

## 使用方法

```text
python code_counter.py <文件夹路径或GitHub链接> [--detail] [--all]
```

示例：

```text
python code_counter.py D:\my_project
python code_counter.py D:\my_project --detail
python code_counter.py D:\my_project --all
python code_counter.py https://github.com/user/repo
python code_counter.py https://github.com/user/repo --detail
```

### 图形界面

双击 `run_gui.bat`，或运行：

```text
python code_counter_ui.py
```

界面支持输入或浏览选择项目文件夹，也支持 GitHub 仓库链接；点击“开始统计”后会调用与命令行相同的行数统计逻辑，并统计 C、C++、Java、Python、C# 中的函数。表格展示源文件数、代码行数、空行数、注释行数、函数个数，以及每个函数有效代码行数的最大值、最小值、均值和中位数。函数行数包含定义签名，排除空行和纯注释行。Python 使用标准库 AST；其余语言使用轻量语法扫描，不等同于完整编译器解析。无法解析的 Python 文件会在状态栏提示，其他语言的复杂语法可能影响扫描精度。

统计完成后，选择 JSON、TXT 或 DOCX 格式，点击“导出结果”并选择保存位置。JSON 保存结构化结果；TXT 保存便于查看的表格；DOCX 保存含统计摘要和表格的 Word 文档。所有格式均使用 Python 标准库生成，无需额外安装导出依赖。

统计 GitHub 仓库时需要本机已安装 Git 且网络可访问 GitHub。程序会浅克隆默认分支到临时目录，
统计完成后自动删除；提供指向仓库子目录或分支的网页链接时，仍统计该仓库默认分支的完整内容。

在 Windows 上也可以把文件夹图标直接**拖到**命令行窗口里，自动填入路径。

若不想手动输入，可双击 `run.bat` 后按提示拖入文件夹，或在资源管理器里把文件夹拖到
`run.bat` 图标上运行。

## 输出示例

```text
正在统计: D:\my_project
(默认跳过 .git / node_modules / __pycache__ 等目录, 加 --all 可包含)

Language    files  blank  comment  code
---------------------------------------
Python          2      5       11    11
JSON            1      0        0     8
JavaScript      1      3        4     7
C               1      1        3     6
C++             1      1        3     6
sum             6     10       21    38
跳过: 2 个文件(无法识别的扩展名 / 二进制或无法解码)

耗时: 8.4 毫秒
```

## 参数说明

| 参数                     | 说明                                                          |
| ------------------------ | ------------------------------------------------------------- |
| `文件夹路径或GitHub链接` | 要统计的本地目录或 GitHub 仓库（必需）                        |
| `--detail`               | 在汇总之外，再按语言列出每个文件的明细                        |
| `--all`                  | 不跳过 `node_modules`、`__pycache__`、`.git` 等常见非源码目录 |
| `-h / --help`            | 显示帮助                                                      |

## 统计口径（重要）

每一物理行按优先级归入三类之一，三者之和 = 该文件总行数：

- **code（有效代码行）**：行内存在代码字符。字符串字面量内部的注释符号不算注释，
  多行字符串字面量内部的每一行按代码行计（如 `s = """a\nb"""` 的两行都计入 code）。
- **comment（注释行）**：整行只含 行注释（`//`、`#`、`--`…）、块注释（`/* */`、`<!-- -->`…）
  或文档字符串（行首无代码的 Python docstring）的内容。代码行末尾的尾部注释仍算 code。
- **blank（空行）**：其余没有任何有效内容的行。

需要注意的简化规则：

- 块注释内部**只有空白**的行计 blank，含注释文字的行计 comment。
- Python 的 docstring 若位于行首（前面无代码）按 comment 剔除；
  若是赋值/表达式中的三引号字符串则按 code 计。
- 未识别扩展名的文件会被**跳过**并在末尾提示数量，不会按文本乱统计。

## 支持的语言（扩展名 → 语言）

Python、**C**（.c/.h）与 **C++**（.cpp/.cc/.cxx/.c++/.hpp/.hh/.hxx/.h++，分开统计）、
Java、C#、JavaScript/TypeScript、Go、Rust、Kotlin、Swift、Dart、
Scala、Groovy、Objective-C(.mm)、PHP、Ruby、Perl、Shell、PowerShell、SQL、Lua、
MATLAB(.m)、R、HTML、XML/SVG、CSS/SCSS/Less、JSON/JSONC、YAML、TOML、
INI/Properties、Visual Basic、Pascal、Fortran 等。

如需调整或增删，直接修改 `code_counter.py` 顶部 `EXT_MAP` 附近的语言规格表即可
（每种语言只需声明：行注释符、块注释对、字符串定界符与转义方式）。

## 常见问题

- **中文乱码**：本程序强制以 UTF-8 输出。旧版 `cmd` 若乱码，先执行 `chcp 65001`，
  或改用 `python -X utf8 code_counter.py <路径>`；Windows Terminal 通常无需处理。
- **某类文件没被统计**：扩展名不在内置列表内（被计入"跳过"数量）。
- **耗时是怎么算的**：从进入主流程（`main()` 开始）到全部输出打印完成的墙钟时间，
  用 `time.perf_counter()` 单调计时，**不含** Python 解释器启动与模块导入。
  小于 1 秒显示毫秒，小于 60 秒显示秒（3 位小数），更长显示 `X 分 Y 秒`。
- **耗时主要花在哪**：几乎全是"读文件 + 逐字符扫描"，实测吞吐约 **2.6 MB/s**；
  文件个数的开销很小（3000 个小文件约 0.5 秒）。所以几十万个文件、数百 MB 源码的
  超大目录（例如带嵌套 `node_modules` 的前端工程）可能需要数十秒到数分钟。
