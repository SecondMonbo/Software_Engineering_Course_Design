#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""代码行数统计工具的图形界面。"""

import os
import queue
import statistics
import subprocess
import tempfile
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from typing import Dict, List, Optional, Tuple

from code_counter import FunctionStats, collect, github_clone_url
from code_counter_export import (
    DEFAULT_EXPORTERS,
    CountReport,
    ExportService,
    build_report,
)


HEADERS = (
    "语言",
    "源文件数",
    "代码行数",
    "空行数",
    "注释行数",
    "函数个数",
    "最大值",
    "最小值",
    "均值",
    "中位数",
)
FUNCTION_STATS = ("—", "—", "—", "—", "—")
ColumnRow = Tuple[str, ...]


def _function_cells(
    language: str, function_stats: Dict[str, FunctionStats]
) -> Tuple[str, str, str, str, str]:
    stats = function_stats.get(language)
    if stats is None:
        return FUNCTION_STATS
    if stats.analyzed_files == 0 and stats.failed_files:
        return ("分析失败", "—", "—", "—", "—")
    sizes = stats.function_lines
    if not sizes:
        return ("0", "0", "0", "0", "0")
    mean = statistics.mean(sizes)
    median = statistics.median(sizes)

    def format_average(value: float) -> str:
        formatted = f"{value:,.1f}"
        return formatted[:-2] if formatted.endswith(".0") else formatted

    return (
        f"{len(sizes):,}",
        f"{max(sizes):,}",
        f"{min(sizes):,}",
        format_average(mean),
        format_average(median),
    )


def make_rows(
    agg: Dict[str, List[int]],
    function_stats: Dict[str, FunctionStats],
) -> List[ColumnRow]:
    """将 collect 的汇总结果转换为界面表格行。"""
    languages = sorted(agg, key=lambda name: (-agg[name][3], name))
    rows = []
    for language in languages:
        files, blank, comment, code = agg[language]
        rows.append(
            (
                language,
                f"{files:,}",
                f"{code:,}",
                f"{blank:,}",
                f"{comment:,}",
                *_function_cells(language, function_stats),
            )
        )

    if agg:
        totals = [sum(values[index] for values in agg.values()) for index in range(4)]
        all_function_stats = FunctionStats([])
        for stats in function_stats.values():
            all_function_stats.function_lines.extend(stats.function_lines)
            all_function_stats.analyzed_files += stats.analyzed_files
            all_function_stats.failed_files += stats.failed_files
        total_function_stats = (
            {"合计": all_function_stats} if function_stats else {}
        )
        rows.append(
            (
                "合计",
                f"{totals[0]:,}",
                f"{totals[3]:,}",
                f"{totals[1]:,}",
                f"{totals[2]:,}",
                *_function_cells("合计", total_function_stats),
            )
        )
    return rows


def scan_path(path: str, include_all: bool):
    """统计本地目录或 GitHub 仓库，并返回汇总和跳过文件数。"""
    function_stats: Dict[str, FunctionStats] = {}
    clone_url = github_clone_url(path)
    if clone_url:
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
            except FileNotFoundError as exc:
                raise RuntimeError("未找到 Git，请先安装 Git 并确保 git 命令可用。") from exc
            except subprocess.CalledProcessError as exc:
                raise RuntimeError(
                    "克隆 GitHub 仓库失败: " + (exc.stderr.strip() or str(exc))
                ) from exc
            agg, _, skipped = collect(
                checkout,
                skip_junk=not include_all,
                function_stats=function_stats,
            )
            return agg, skipped, function_stats

    if not os.path.exists(path):
        raise ValueError(f"路径不存在: {path}")
    if not os.path.isdir(path):
        raise ValueError(f"不是文件夹: {path}")

    agg, _, skipped = collect(
        path,
        skip_junk=not include_all,
        function_stats=function_stats,
    )
    return agg, skipped, function_stats


def main() -> None:
    root = tk.Tk()
    root.title("代码行数统计")
    root.geometry("1120x620")
    root.minsize(900, 420)

    path_var = tk.StringVar()
    include_all_var = tk.BooleanVar(value=False)
    status_var = tk.StringVar(value="选择或输入项目文件夹，然后点击“开始统计”。")
    result_queue = queue.Queue()
    current_report: Optional[CountReport] = None
    export_service = ExportService(DEFAULT_EXPORTERS)

    toolbar = ttk.Frame(root, padding=(12, 12, 12, 8))
    toolbar.pack(fill="x")
    toolbar.columnconfigure(1, weight=1)

    ttk.Label(toolbar, text="文件夹路径 / GitHub 链接：").grid(
        row=0, column=0, padx=(0, 8)
    )
    path_entry = ttk.Entry(toolbar, textvariable=path_var)
    path_entry.grid(row=0, column=1, sticky="ew")

    def choose_folder() -> None:
        folder = filedialog.askdirectory(title="选择要统计的项目文件夹")
        if folder:
            path_var.set(folder)

    ttk.Button(toolbar, text="浏览...", command=choose_folder).grid(
        row=0, column=2, padx=(8, 0)
    )

    options = ttk.Frame(root, padding=(12, 0, 12, 8))
    options.pack(fill="x")
    ttk.Checkbutton(
        options,
        text="统计常见依赖和隐藏目录（包含 .git、node_modules 等）",
        variable=include_all_var,
    ).pack(side="left")

    table_frame = ttk.Frame(root, padding=(12, 0, 12, 8))
    table_frame.pack(fill="both", expand=True)
    table_frame.rowconfigure(0, weight=1)
    table_frame.columnconfigure(0, weight=1)

    columns = tuple(f"column_{index}" for index in range(len(HEADERS)))
    table = ttk.Treeview(
        table_frame,
        columns=columns,
        show="headings",
        height=15,
    )
    widths = (105, 90, 100, 85, 95, 85, 85, 85, 85, 90)
    for column, heading, width in zip(columns, HEADERS, widths):
        table.heading(column, text=heading)
        table.column(column, width=width, minwidth=60, anchor="center", stretch=True)

    vertical_scroll = ttk.Scrollbar(
        table_frame, orient="vertical", command=table.yview
    )
    horizontal_scroll = ttk.Scrollbar(
        table_frame, orient="horizontal", command=table.xview
    )
    table.configure(
        yscrollcommand=vertical_scroll.set,
        xscrollcommand=horizontal_scroll.set,
    )
    table.grid(row=0, column=0, sticky="nsew")
    vertical_scroll.grid(row=0, column=1, sticky="ns")
    horizontal_scroll.grid(row=1, column=0, sticky="ew")

    footer = ttk.Frame(root, padding=(12, 0, 12, 12))
    footer.pack(fill="x")
    status_label = ttk.Label(footer, textvariable=status_var)
    status_label.pack(side="left", fill="x", expand=True)

    export_format_var = tk.StringVar(value="JSON")
    export_format = ttk.Combobox(
        footer,
        textvariable=export_format_var,
        values=("JSON", "TXT", "DOCX"),
        state="readonly",
        width=7,
    )
    export_format.pack(side="right", padx=(8, 0))

    def save_report() -> None:
        if current_report is None:
            messagebox.showwarning("尚无统计结果", "请先完成一次统计。", parent=root)
            return

        format_name = export_format_var.get().lower()
        exporter = export_service.formats[format_name]
        path = filedialog.asksaveasfilename(
            title="保存统计结果",
            defaultextension=exporter.extension,
            filetypes=[
                (f"{exporter.format_name} 文件", f"*{exporter.extension}"),
                ("所有文件", "*.*"),
            ],
        )
        if not path:
            return

        base, extension = os.path.splitext(path)
        if extension.lower() != exporter.extension:
            path = base + exporter.extension if extension else path + exporter.extension

        try:
            export_service.export(current_report, format_name, path)
        except (OSError, ValueError) as exc:
            messagebox.showerror("保存失败", str(exc), parent=root)
            return
        status_var.set(f"统计结果已保存：{path}")
        messagebox.showinfo("保存成功", f"统计结果已保存到：\n{path}", parent=root)

    export_button = ttk.Button(
        footer, text="导出结果", command=save_report, state="disabled"
    )
    export_button.pack(side="right")

    def poll_result() -> None:
        nonlocal current_report
        try:
            result = result_queue.get_nowait()
        except queue.Empty:
            root.after(100, poll_result)
            return

        run_button.configure(state="normal")
        status, payload = result
        if status == "error":
            status_var.set("统计失败。")
            messagebox.showerror("统计失败", payload, parent=root)
            return

        agg, skipped, function_stats = payload
        current_report = build_report(
            agg,
            function_stats,
            path_var.get().strip().strip('"'),
            skipped,
        )
        table.delete(*table.get_children())
        for row in make_rows(agg, function_stats):
            table.insert("", "end", values=row)
        file_count = sum(values[0] for values in agg.values())
        parse_failures = sum(stats.failed_files for stats in function_stats.values())
        export_button.configure(state="normal")
        status_var.set(
            f"统计完成：{len(agg)} 种语言，{file_count:,} 个源文件，"
            f"跳过 {skipped:,} 个文件。"
            + (
                f"另有 {parse_failures:,} 个文件无法解析函数。"
                if parse_failures
                else ""
            )
        )

    def start_scan() -> None:
        nonlocal current_report
        path = path_var.get().strip().strip('"')
        if not path:
            messagebox.showwarning("缺少路径", "请先输入文件夹路径或 GitHub 链接。", parent=root)
            return
        include_all = include_all_var.get()

        run_button.configure(state="disabled")
        export_button.configure(state="disabled")
        current_report = None
        table.delete(*table.get_children())
        status_var.set("正在统计，请稍候...")

        def worker() -> None:
            try:
                result_queue.put(("success", scan_path(path, include_all)))
            except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
                result_queue.put(("error", str(exc)))

        threading.Thread(target=worker, daemon=True).start()
        root.after(100, poll_result)

    run_button = ttk.Button(toolbar, text="开始统计", command=start_scan)
    run_button.grid(row=0, column=3, padx=(8, 0))
    path_entry.bind("<Return>", lambda _event: start_scan())

    root.mainloop()


if __name__ == "__main__":
    main()
