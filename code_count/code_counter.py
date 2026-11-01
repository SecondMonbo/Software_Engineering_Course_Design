#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
code_counter.py — 命令行代码行数统计工具

用法:
    python code_counter.py <文件夹路径或GitHub链接> [--detail] [--all]

输出:
    汇总表, 列为  Language | files | blank | comment | code
    (blank=空行, comment=注释行, code=有效代码行), 最后一行 sum 为合计。

统计口径:
    逐字符状态机扫描, 能感知字符串字面量(例如 print("// 这不是注释")
    中的 "//" 不会被误判为注释)。每一物理行按优先级归类为:
        code     含代码字符(含多行字符串内部行)
        comment  仅含 行注释/块注释/文档字符串 内容
        blank    其余空行
    编码: 优先 UTF-8(含 BOM),失败自动回退 GBK 系列,再失败则跳过该文件。
"""

import argparse
import ast
from bisect import bisect_left
import os
import re
import statistics
import subprocess
import sys
import tempfile
import time
import unicodedata
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlsplit

# ---------------------------------------------------------------------------
# 语言定义: 每种语言需要知道自己的 行注释 / 块注释 / 字符串定界与转义规则
# ---------------------------------------------------------------------------


@dataclass
class LangSpec:
    name: str  # 语言显示名
    line: Tuple[str, ...] = ()  # 行注释起始符, 如 ("//",)
    block: Tuple[Tuple[str, str], ...] = ()  # 块注释 (起始, 结束), 如 (("/*", "*/"),)
    strings: Tuple[Tuple[str, Optional[str]], ...] = ()  # (定界符, 转义方式)
    doc: Tuple[str, ...] = ()  # 文档字符串定界符, 如 ('"""', "'''")


@dataclass
class FunctionStats:
    """某语言函数有效代码行数的汇总输入。"""

    function_lines: List[int]
    analyzed_files: int = 0
    failed_files: int = 0


def _mk(name, line=(), block=(), strings=(), doc=()):
    return LangSpec(name=name, line=line, block=block, strings=strings, doc=doc)


BS = "\\"  # 反斜杠转义
DOUBLE = "double"  # 双写定界符转义(如 SQL 的 '' 表示一个单引号)

# -- 语言规格 ----------------------------------------------------------------
PY = _mk("Python", line=("#",), strings=(("'", BS), ('"', BS)), doc=('"""', "'''"))

C_LANG = _mk("C", line=("//",), block=(("/*", "*/"),), strings=(("'", BS), ('"', BS)))
CPP = _mk("C++", line=("//",), block=(("/*", "*/"),), strings=(("'", BS), ('"', BS)))

JAVA = _mk("Java", line=("//",), block=(("/*", "*/"),), strings=(("'", BS), ('"', BS)))
CS = _mk("C#", line=("//",), block=(("/*", "*/"),), strings=(("'", BS), ('"', BS)))
JS = _mk(
    "JavaScript",
    line=("//",),
    block=(("/*", "*/"),),
    strings=(("'", BS), ('"', BS), ("`", BS)),
)
TS = _mk(
    "TypeScript",
    line=("//",),
    block=(("/*", "*/"),),
    strings=(("'", BS), ('"', BS), ("`", BS)),
)
GO = _mk(
    "Go",
    line=("//",),
    block=(("/*", "*/"),),
    strings=(("'", BS), ('"', BS), ("`", None)),
)
RS = _mk("Rust", line=("//",), block=(("/*", "*/"),), strings=(("'", BS), ('"', BS)))
KT = _mk("Kotlin", line=("//",), block=(("/*", "*/"),), strings=(("'", BS), ('"', BS)))
SWIFT = _mk(
    "Swift", line=("//",), block=(("/*", "*/"),), strings=(("'", BS), ('"', BS))
)
DART = _mk("Dart", line=("//",), block=(("/*", "*/"),), strings=(("'", BS), ('"', BS)))
SCALA = _mk(
    "Scala", line=("//",), block=(("/*", "*/"),), strings=(("'", BS), ('"', BS))
)
GROOVY = _mk(
    "Groovy", line=("//",), block=(("/*", "*/"),), strings=(("'", BS), ('"', BS))
)
OBJC = _mk(
    "Objective-C", line=("//",), block=(("/*", "*/"),), strings=(("'", BS), ('"', BS))
)
PHP = _mk(
    "PHP", line=("//", "#"), block=(("/*", "*/"),), strings=(("'", BS), ('"', BS))
)
RB = _mk(
    "Ruby", line=("#",), block=(("=begin", "=end"),), strings=(("'", BS), ('"', BS))
)
PERL = _mk(
    "Perl", line=("#",), block=(("=pod", "=cut"),), strings=(("'", BS), ('"', BS))
)
SH = _mk("Shell", line=("#",), strings=(("'", None), ('"', BS)))
PS1 = _mk(
    "PowerShell", line=("#",), block=(("<#", "#>"),), strings=(("'", None), ('"', "`"))
)
SQL = _mk("SQL", line=("--",), block=(("/*", "*/"),), strings=(("'", DOUBLE),))
LUA = _mk("Lua", line=("--",), block=(("--[[", "]]"),), strings=(("'", BS), ('"', BS)))
HTML = _mk("HTML", block=(("<!--", "-->"),), strings=(('"', None), ("'", None)))
XML = _mk("XML", block=(("<!--", "-->"),), strings=(('"', None), ("'", None)))
CSS = _mk("CSS", block=(("/*", "*/"),), strings=(('"', None), ("'", None)))
SCSS = _mk(
    "SCSS/Less", line=("//",), block=(("/*", "*/"),), strings=(('"', None), ("'", None))
)
JSON = _mk("JSON", strings=(('"', BS),))
YAML = _mk("YAML", line=("#",), strings=(('"', BS), ("'", None)))
TOML = _mk("TOML", line=("#",), strings=(('"', BS), ("'", None)))
INI = _mk("INI/Properties", line=("#", ";", "!"))
VB = _mk("Visual Basic", line=("'",), strings=(('"', DOUBLE),))
PAS = _mk(
    "Pascal", line=("//",), block=(("{", "}"), ("(*", "*)")), strings=(("'", DOUBLE),)
)
F90 = _mk("Fortran", line=("!",), strings=(("'", None), ('"', None)))
MATLAB = _mk("MATLAB", line=("%",), strings=(("'", None), ('"', None)))
R = _mk("R", line=("#",), strings=(("'", BS), ('"', BS)))
JSONC = _mk("JSONC", line=("//",), block=(("/*", "*/"),), strings=(('"', BS),))

# 扩展名 -> 语言 映射 (均为小写、不含点)
EXT_MAP: Dict[str, LangSpec] = {}
for _ext, _spec in {
    # Python
    "py": PY,
    "pyw": PY,
    # C(.h 头文件按 C 计)
    "c": C_LANG,
    "h": C_LANG,
    # C++
    "cpp": CPP,
    "cc": CPP,
    "cxx": CPP,
    "c++": CPP,
    "hpp": CPP,
    "hh": CPP,
    "hxx": CPP,
    "h++": CPP,
    # 其他 C 风格
    "java": JAVA,
    "cs": CS,
    "js": JS,
    "mjs": JS,
    "cjs": JS,
    "jsx": JS,
    "ts": TS,
    "tsx": TS,
    "go": GO,
    "rs": RS,
    "kt": KT,
    "kts": KT,
    "swift": SWIFT,
    "dart": DART,
    "scala": SCALA,
    "sc": SCALA,
    "groovy": GROOVY,
    "mm": OBJC,
    # 脚本
    "php": PHP,
    "phtml": PHP,
    "php3": PHP,
    "php4": PHP,
    "php5": PHP,
    "rb": RB,
    "rake": RB,
    "pl": PERL,
    "pm": PERL,
    "t": PERL,
    "sh": SH,
    "bash": SH,
    "zsh": SH,
    "ksh": SH,
    "ps1": PS1,
    "psm1": PS1,
    "psd1": PS1,
    "lua": LUA,
    "m": MATLAB,
    "r": R,
    # 数据 / 标记
    "sql": SQL,
    "html": HTML,
    "htm": HTML,
    "xhtml": HTML,
    "xml": XML,
    "xsd": XML,
    "xsl": XML,
    "xslt": XML,
    "svg": XML,
    "css": CSS,
    "scss": SCSS,
    "sass": SCSS,
    "less": SCSS,
    "json": JSON,
    "jsonc": JSONC,
    "yml": YAML,
    "yaml": YAML,
    "toml": TOML,
    "ini": INI,
    "cfg": INI,
    "conf": INI,
    "properties": INI,
    # 其他
    "vb": VB,
    "vbs": VB,
    "pas": PAS,
    "pp": PAS,
    "f90": F90,
    "f95": F90,
    "f03": F90,
    "f08": F90,
    "f": F90,
    "for": F90,
    "f77": F90,
}.items():
    EXT_MAP[_ext] = _spec

# 递归时默认跳过的"非源码"目录; --all 可关闭
JUNK_DIRS = {
    ".git",
    ".svn",
    ".hg",
    ".idea",
    ".vscode",
    ".vs",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".tox",
    ".cache",
    "node_modules",
    "venv",
    ".venv",
    "env",
    ".env",
    "dist",
    "build",
    "target",
    "out",
    "bin",
    "obj",
    "coverage",
    ".next",
    ".nuxt",
}

# ---------------------------------------------------------------------------
# 核心计数: 逐字符状态机, 逐行归类为 blank / comment / code
# ---------------------------------------------------------------------------


def count_lines(text: str, spec: LangSpec) -> Tuple[int, int, int]:
    """统计一个文件的 (空行数, 注释行数, 有效代码行数)。

    每一物理行按优先级归类:
        code     —— 该行存在代码字符(含多行字符串字面量内部的行);
        comment  —— 该行只含 行注释 / 块注释 / 文档字符串 内容;
        blank    —— 其余(无任何有效内容)的空行。
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    n = len(text)

    blank = 0
    comment = 0
    code = 0
    line_code = False  # 当前行是否已出现代码字符
    line_comment = False  # 当前行是否已出现注释内容
    i = 0
    mode = "normal"  # normal | block(注释/文档字符串) | string
    block_end: Optional[str] = None
    str_delim: Optional[str] = None
    str_esc: Optional[str] = None

    def newline():
        """当前物理行结束: 归类并复位。"""
        nonlocal blank, comment, code, line_code, line_comment
        if line_code:
            code += 1
        elif line_comment:
            comment += 1
        else:
            blank += 1
        line_code = False
        line_comment = False

    while i < n:
        if mode == "block":
            if block_end and text.startswith(block_end, i):
                i += len(block_end)
                line_comment = True  # 结束定界符属于注释
                block_end = None
                mode = "normal"
                continue
            c = text[i]
            if c == "\n":
                newline()
            elif not c.isspace():
                line_comment = True  # 块注释正文(行首/行中)
            i += 1
            continue

        if mode == "string":
            # 转义字符: 吃掉反斜杠/重音符 后的下一个字符(避免误关字符串)
            if str_esc and str_esc != DOUBLE and text.startswith(str_esc, i):
                if i + 1 < n and text[i + 1] != "\n":
                    i += 2
                else:
                    i += 1
                continue
            # 双写定界符转义, 如 SQL 的 'it''s' => 两个引号是转义而非关闭
            if (
                str_esc == DOUBLE
                and str_delim
                and text.startswith(str_delim + str_delim, i)
            ):
                i += len(str_delim) * 2
                continue
            # 字符串结束
            if str_delim and text.startswith(str_delim, i):
                i += len(str_delim)
                line_code = True  # 结束定界符属于代码
                str_delim = None
                str_esc = None
                mode = "normal"
                continue
            c = text[i]
            if c == "\n":
                line_code = True  # 多行字符串内部的行按代码行计
                newline()
            i += 1
            continue

        # ---------------- mode == normal ----------------
        # 1) 行注释: 该行含注释内容, 跳到本行结尾
        matched = False
        for m in spec.line:
            if text.startswith(m, i):
                line_comment = True
                j = text.find("\n", i)
                i = n if j == -1 else j
                matched = True
                break
        if matched:
            continue
        # 2) 文档字符串(行首尚无代码时按注释处理, 如 Python 的 docstring)
        for m in spec.doc:
            if not line_code and text.startswith(m, i):
                line_comment = True
                mode = "block"
                block_end = m
                i += len(m)
                matched = True
                break
        if matched:
            continue
        # 3) 块注释
        for s, e in spec.block:
            if text.startswith(s, i):
                line_comment = True
                mode = "block"
                block_end = e
                i += len(s)
                matched = True
                break
        if matched:
            continue
        # 4) 字符串字面量
        for d, esc in spec.strings:
            if text.startswith(d, i):
                line_code = True  # 起始定界符属于代码
                mode = "string"
                str_delim = d
                str_esc = esc
                i += len(d)
                matched = True
                break
        if matched:
            continue
        # 5) 普通字符 / 换行
        c = text[i]
        if c == "\n":
            newline()
        elif not c.isspace():
            line_code = True
        i += 1

    # 文件末尾没有换行符时, 补计最后一行
    if text and not text.endswith("\n"):
        if mode == "string":  # 未闭合字符串的尾行按代码行计
            line_code = True
        newline()
    return blank, comment, code


FUNCTION_LANGUAGES = {"C", "C++", "Java", "Python", "C#"}
FUNCTION_NAME_RE = re.compile(r"[A-Za-z_~]\w*(?:(?:::)\s*[A-Za-z_~]\w*)*\s*$")
CONTROL_KEYWORDS = {
    "if",
    "else",
    "for",
    "foreach",
    "while",
    "switch",
    "catch",
    "using",
    "lock",
    "synchronized",
    "do",
    "try",
    "return",
    "sizeof",
    "decltype",
    "noexcept",
    "requires",
    "new",
    "delete",
}


def _mask_c_like(text: str) -> str:
    """Hide comments and strings while preserving offsets and line breaks."""
    masked = list(text)
    i = 0
    mode = "normal"
    quote = ""
    while i < len(text):
        if mode == "line_comment":
            if text[i] == "\n":
                mode = "normal"
            else:
                masked[i] = " "
            i += 1
            continue
        if mode == "block_comment":
            if text.startswith("*/", i):
                masked[i] = masked[i + 1] = " "
                i += 2
                mode = "normal"
            else:
                if text[i] != "\n":
                    masked[i] = " "
                i += 1
            continue
        if mode == "string":
            if text[i] == "\\" and i + 1 < len(text):
                if text[i] != "\n":
                    masked[i] = " "
                i += 1
                if text[i] != "\n":
                    masked[i] = " "
                i += 1
            elif text[i] == quote:
                masked[i] = " "
                i += 1
                mode = "normal"
            else:
                if text[i] != "\n":
                    masked[i] = " "
                i += 1
            continue

        if text.startswith("//", i):
            masked[i] = masked[i + 1] = " "
            i += 2
            mode = "line_comment"
        elif text.startswith("/*", i):
            masked[i] = masked[i + 1] = " "
            i += 2
            mode = "block_comment"
        elif text[i] == "#" and not text[text.rfind("\n", 0, i) + 1 : i].strip():
            line_end = text.find("\n", i)
            line_end = len(text) if line_end == -1 else line_end
            for position in range(i, line_end):
                masked[position] = " "
            i = line_end
        elif text[i] in ('"', "'"):
            quote = text[i]
            masked[i] = " "
            i += 1
            mode = "string"
        else:
            i += 1
    return "".join(masked)


def _function_body_open(text: str, closing_paren: int) -> Optional[int]:
    """Find a function body after its signature, ignoring trailing qualifiers."""
    parens = 0
    brackets = 0
    for i in range(closing_paren + 1, len(text)):
        char = text[i]
        if char == "(":
            parens += 1
        elif char == ")":
            if parens == 0:
                return None
            parens -= 1
        elif char == "[":
            brackets += 1
        elif char == "]":
            brackets -= 1
        elif parens == 0 and brackets == 0:
            if char == "{":
                return i
            if char in ";=}":
                return None
    return None


def _c_like_function_lines(text: str, spec: LangSpec) -> List[int]:
    masked = _mask_c_like(text)
    boundaries = [
        i for i, char in enumerate(masked) if char in ";{}"
    ]
    paren_stack = []
    brace_stack = []
    paren_pairs = {}
    brace_pairs = {}
    for i, char in enumerate(masked):
        if char == "(":
            paren_stack.append(i)
        elif char == ")" and paren_stack:
            paren_pairs[paren_stack.pop()] = i
        elif char == "{":
            brace_stack.append(i)
        elif char == "}" and brace_stack:
            brace_pairs[brace_stack.pop()] = i

    sizes = []
    for opening, closing in paren_pairs.items():
        name_window_start = max(0, opening - 256)
        name_match = FUNCTION_NAME_RE.search(masked[name_window_start:opening])
        if name_match is None:
            continue
        name = name_match.group(0).split("::")[-1].strip()
        if name in CONTROL_KEYWORDS:
            continue

        name_start = name_window_start + name_match.start()
        previous = masked[max(0, name_start - 256) : name_start].rstrip()
        if previous.endswith((".", ">", "]")):
            continue

        body_open = _function_body_open(masked, closing)
        if body_open is None:
            continue
        body_close = brace_pairs.get(body_open)
        if body_close is None:
            continue

        boundary_index = bisect_left(boundaries, name_start) - 1
        boundary = boundaries[boundary_index] if boundary_index >= 0 else -1
        start = boundary + 1
        while start < name_start and masked[start].isspace():
            start += 1
        prefix = masked[start:name_start]
        access_label = re.match(r"\s*(?:public|private|protected)\s*:\s*", prefix)
        if access_label:
            start += access_label.end()
        snippet = text[start : body_close + 1]
        sizes.append(count_lines(snippet, spec)[2])
    return sizes


def function_line_counts(text: str, spec: LangSpec) -> Optional[List[int]]:
    """Return per-function effective code lines, or None if analysis is unsupported."""
    if spec.name not in FUNCTION_LANGUAGES:
        return None
    if spec.name != "Python":
        return _c_like_function_lines(text, spec)

    try:
        tree = ast.parse(text)
    except SyntaxError:
        return None

    lines = text.splitlines(keepends=True)
    sizes = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        start = min(
            (decorator.lineno for decorator in node.decorator_list),
            default=node.lineno,
        )
        end = node.end_lineno or node.lineno
        snippet = "".join(lines[start - 1 : end])
        sizes.append(count_lines(snippet, spec)[2])
    return sizes


# ---------------------------------------------------------------------------
# 文件读取 / 遍历
# ---------------------------------------------------------------------------


def read_text(path: str) -> Optional[str]:
    """UTF-8 优先, 失败回退 GBK 系列; 二进制或无法解码返回 None。"""
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError:
        return None
    if not raw:
        return ""
    if b"\x00" in raw[:4096]:  # 疑似二进制
        return None
    for enc in ("utf-8-sig", "gb18030"):  # gb18030 兼容全部 GBK
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return None


def match_spec(filename: str) -> Optional[LangSpec]:
    ext = os.path.splitext(filename)[1].lstrip(".").lower()
    return EXT_MAP.get(ext)


def collect(
    root: str,
    skip_junk: bool,
    function_stats: Optional[Dict[str, FunctionStats]] = None,
):
    """遍历目录, 返回 (按语言汇总, 按语言明细, 跳过文件数)。

    汇总条目结构: 语言名 -> [文件数, 空行, 注释行, 代码行]
    明细条目结构: 语言名 -> [(相对路径, 空行, 注释行, 代码行), ...]
    """
    agg: Dict[str, List[int]] = {}  # 语言名 -> [files, blank, comment, code]
    detail: Dict[str, List[Tuple[str, int, int, int]]] = {}
    skipped = 0
    root_abs = os.path.abspath(root)

    for dirpath, dirnames, filenames in os.walk(root_abs):
        if skip_junk:
            kept = []
            for d in dirnames:
                if d.startswith(".") or d in JUNK_DIRS:
                    continue
                kept.append(d)
            dirnames[:] = kept
        for fn in sorted(filenames):
            path = os.path.join(dirpath, fn)
            spec = match_spec(fn)
            if spec is None:
                skipped += 1
                continue
            text = read_text(path)
            if text is None:
                skipped += 1
                continue
            blank, comment, code = count_lines(text, spec)
            st = agg.setdefault(spec.name, [0, 0, 0, 0])
            st[0] += 1
            st[1] += blank
            st[2] += comment
            st[3] += code
            detail.setdefault(spec.name, []).append(
                (os.path.relpath(path, root_abs), blank, comment, code)
            )
            if function_stats is not None and spec.name in FUNCTION_LANGUAGES:
                stats = function_stats.setdefault(spec.name, FunctionStats([]))
                sizes = function_line_counts(text, spec)
                if sizes is None:
                    stats.failed_files += 1
                else:
                    stats.analyzed_files += 1
                    stats.function_lines.extend(sizes)
    return agg, detail, skipped


def github_clone_url(source: str) -> Optional[str]:
    """将 GitHub 仓库网页链接转换为 clone URL; 非 GitHub URL 返回 None。"""
    parsed = urlsplit(source)
    if parsed.scheme.lower() not in ("http", "https") or parsed.netloc.lower() not in (
        "github.com",
        "www.github.com",
    ):
        return None
    parts = [part for part in parsed.path.strip("/").split("/") if part]
    if len(parts) < 2:
        raise ValueError("GitHub 链接应包含用户名和仓库名")
    owner, repo = parts[0], parts[1]
    if repo.endswith(".git"):
        repo = repo[:-4]
    if not owner or not repo:
        raise ValueError("GitHub 链接应包含用户名和仓库名")
    return f"https://github.com/{owner}/{repo}.git"


# ---------------------------------------------------------------------------
# 输出格式化
# ---------------------------------------------------------------------------


def disp_w(s: str) -> int:
    """按终端显示宽度计: CJK 全角字符占 2 格。"""
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in s)


def fmt_duration(seconds: float) -> str:
    """把秒数格式化为易读的耗时文本(毫秒 / 秒 / 分秒)。"""
    if seconds < 1:
        return f"{seconds * 1000:.1f} 毫秒"
    if seconds < 60:
        return f"{seconds:.3f} 秒"
    minutes, sec = divmod(seconds, 60)
    return f"{int(minutes)} 分 {sec:.1f} 秒"


def print_table(
    headers: List[str], rows: List[List[str]], right_cols: Tuple[int, ...] = ()
) -> None:
    """打印对齐表格。第一列左对齐, right_cols 指定的列右对齐。"""
    ncols = len(headers)
    widths = [0] * ncols
    for c in range(ncols):
        widths[c] = max(disp_w(headers[c]), *(disp_w(str(r[c])) for r in rows))

    def render(cells):
        parts = []
        for c in range(ncols):
            s = str(cells[c])
            gap = widths[c] - disp_w(s)
            parts.append((" " * gap + s) if c in right_cols else (s + " " * gap))
        return "  ".join(parts)

    print(render(headers))
    print("-" * (sum(widths) + 2 * (ncols - 1)))
    for r in rows:
        print(render(r))


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def main(argv: Optional[List[str]] = None) -> int:
    t_start = time.perf_counter()  # 计时起点: 任务开始

    # 强制以 UTF-8 输出, 避免中文路径/内容在部分终端下乱码;
    # 若在旧版 cmd 出现乱码, 可先执行  chcp 65001  或用  python -X utf8 运行
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    ap = argparse.ArgumentParser(
        prog="code_counter",
        description="统计文件夹或 GitHub 仓库内代码的种类, 以及空行/注释/代码的行数。",
        epilog="示例: python code_counter.py https://github.com/user/repo --detail",
    )
    ap.add_argument(
        "path", metavar="路径或GitHub链接", help="要统计的目录或 GitHub 仓库链接"
    )
    ap.add_argument(
        "--detail", action="store_true", help="除汇总外, 再按语言列出每个文件的明细"
    )
    ap.add_argument(
        "--all",
        action="store_true",
        help="不跳过 node_modules / __pycache__ / .git 等常见非源码目录",
    )
    args = ap.parse_args(argv)

    try:
        clone_url = github_clone_url(args.path)
    except ValueError as exc:
        print(f"[错误] {exc}")
        return 1

    if clone_url:
        print(f"正在克隆 GitHub 仓库: {args.path}")
        with tempfile.TemporaryDirectory(prefix="code_counter_") as temp_dir:
            checkout = os.path.join(temp_dir, "repo")
            try:
                subprocess.run(
                    ["git", "clone", "--depth", "1", "--", clone_url, checkout],
                    check=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                )
            except FileNotFoundError:
                print("[错误] 未找到 Git，请先安装 Git 并确保 git 命令可用。")
                return 1
            except subprocess.CalledProcessError as exc:
                message = exc.stderr.strip() or str(exc)
                print(f"[错误] 克隆 GitHub 仓库失败: {message}")
                return 1
            agg, detail, skipped = collect(checkout, skip_junk=not args.all)
    else:
        if not os.path.exists(args.path):
            print(f"[错误] 路径不存在: {args.path}")
            return 1
        if not os.path.isdir(args.path):
            print(f"[错误] 不是文件夹: {args.path}")
            return 1
        agg, detail, skipped = collect(args.path, skip_junk=not args.all)

    display_path = args.path if clone_url else os.path.abspath(args.path)
    print(f"正在统计: {display_path}")
    if not args.all:
        print("(默认跳过 .git / node_modules / __pycache__ 等目录, 加 --all 可包含)")
    print()

    if not agg:
        print("没有找到可识别的代码文件。")
        print(f"耗时: {fmt_duration(time.perf_counter() - t_start)}")
        return 0

    # ---- 按语言汇总表 + sum 合计行 ----
    langs = sorted(agg.keys(), key=lambda k: (-agg[k][3], k))  # 按代码行降序
    headers = ["Language", "files", "blank", "comment", "code"]
    rows: List[List[str]] = []
    for k in langs:
        f, b, cm, cd = agg[k]
        rows.append([k, f"{f:,}", f"{b:,}", f"{cm:,}", f"{cd:,}"])
    tf = sum(v[0] for v in agg.values())
    tb = sum(v[1] for v in agg.values())
    tc = sum(v[2] for v in agg.values())
    tk = sum(v[3] for v in agg.values())
    rows.append(["sum", f"{tf:,}", f"{tb:,}", f"{tc:,}", f"{tk:,}"])

    print_table(headers, rows, right_cols=(1, 2, 3, 4))

    if skipped:
        print(f"跳过: {skipped:,} 个文件(无法识别的扩展名 / 二进制或无法解码)")

    # ---- 文件明细 ----
    if args.detail:
        print()
        print("—— 文件明细 ——")
        for k in langs:
            items = sorted(detail[k], key=lambda it: (-it[3], it[0]))
            print()
            print(f"[{k}] {agg[k][0]:,} 个文件")
            d_headers = ["文件", "blank", "comment", "code"]
            d_rows = [[rel, f"{b:,}", f"{cm:,}", f"{cd:,}"] for rel, b, cm, cd in items]
            print_table(d_headers, d_rows, right_cols=(1, 2, 3))

    # ---- 耗时: 从任务开始到全部输出完成 ----
    print()
    print(f"耗时: {fmt_duration(time.perf_counter() - t_start)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
