#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Dependency-injected exporters for code-counting reports."""

import json
import statistics
import zipfile
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Dict, List, Mapping, Optional
from xml.etree import ElementTree

from code_counter import FunctionStats


@dataclass
class LanguageResult:
    language: str
    source_files: int
    code_lines: int
    blank_lines: int
    comment_lines: int
    function_count: Optional[int]
    function_lines_max: Optional[int]
    function_lines_min: Optional[int]
    function_lines_mean: Optional[float]
    function_lines_median: Optional[float]
    function_analysis_failed_files: int = 0


@dataclass
class CountReport:
    source: str
    generated_at: str
    skipped_files: int
    languages: List[LanguageResult]
    total: LanguageResult


def _language_result(
    language: str,
    counts: List[int],
    function_stats: Optional[FunctionStats],
) -> LanguageResult:
    files, blank, comment, code = counts
    if function_stats is None:
        function_metrics = (None, None, None, None, None)
        failed_files = 0
    elif function_stats.analyzed_files == 0 and function_stats.failed_files:
        function_metrics = (None, None, None, None, None)
        failed_files = function_stats.failed_files
    else:
        sizes = function_stats.function_lines
        function_metrics = (
            len(sizes),
            max(sizes) if sizes else 0,
            min(sizes) if sizes else 0,
            statistics.mean(sizes) if sizes else 0,
            statistics.median(sizes) if sizes else 0,
        )
        failed_files = function_stats.failed_files

    return LanguageResult(
        language=language,
        source_files=files,
        code_lines=code,
        blank_lines=blank,
        comment_lines=comment,
        function_count=function_metrics[0],
        function_lines_max=function_metrics[1],
        function_lines_min=function_metrics[2],
        function_lines_mean=function_metrics[3],
        function_lines_median=function_metrics[4],
        function_analysis_failed_files=failed_files,
    )


def build_report(
    agg: Dict[str, List[int]],
    function_stats: Dict[str, FunctionStats],
    source: str,
    skipped_files: int,
) -> CountReport:
    """Build the immutable-format-neutral data passed to each exporter."""
    languages = [
        _language_result(language, agg[language], function_stats.get(language))
        for language in sorted(agg, key=lambda name: (-agg[name][3], name))
    ]
    totals = [sum(values[index] for values in agg.values()) for index in range(4)]
    all_functions = FunctionStats([])
    for stats in function_stats.values():
        all_functions.function_lines.extend(stats.function_lines)
        all_functions.analyzed_files += stats.analyzed_files
        all_functions.failed_files += stats.failed_files

    return CountReport(
        source=source,
        generated_at=datetime.now().astimezone().isoformat(timespec="seconds"),
        skipped_files=skipped_files,
        languages=languages,
        total=_language_result("合计", totals, all_functions if function_stats else None),
    )


class ReportExporter(ABC):
    """Abstract export strategy injected into ExportService."""

    format_name: str
    extension: str

    @abstractmethod
    def export(self, report: CountReport, path: str) -> None:
        """Write a report to the requested path."""


class JsonReportExporter(ReportExporter):
    format_name = "JSON"
    extension = ".json"

    def export(self, report: CountReport, path: str) -> None:
        with open(path, "w", encoding="utf-8", newline="\n") as output:
            json.dump(asdict(report), output, ensure_ascii=False, indent=2)
            output.write("\n")


class TextReportExporter(ReportExporter):
    format_name = "TXT"
    extension = ".txt"

    @staticmethod
    def _value(value: object) -> str:
        return "—" if value is None else str(value)

    def export(self, report: CountReport, path: str) -> None:
        headers = (
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
        rows = [
            (
                row.language,
                row.source_files,
                row.code_lines,
                row.blank_lines,
                row.comment_lines,
                row.function_count,
                row.function_lines_max,
                row.function_lines_min,
                row.function_lines_mean,
                row.function_lines_median,
            )
            for row in report.languages
        ]
        total = report.total
        rows.append(
            (
                total.language,
                total.source_files,
                total.code_lines,
                total.blank_lines,
                total.comment_lines,
                total.function_count,
                total.function_lines_max,
                total.function_lines_min,
                total.function_lines_mean,
                total.function_lines_median,
            )
        )

        with open(path, "w", encoding="utf-8", newline="\n") as output:
            output.write(f"代码统计报告\n统计来源：{report.source}\n")
            output.write(f"生成时间：{report.generated_at}\n")
            output.write(f"跳过文件：{report.skipped_files}\n\n")
            output.write("\t".join(headers) + "\n")
            for row in rows:
                output.write(
                    "\t".join(self._value(value) for value in row) + "\n"
                )


class DocxReportExporter(ReportExporter):
    format_name = "DOCX"
    extension = ".docx"

    @staticmethod
    def _append_text(parent, tag: str, text: object) -> None:
        paragraph = ElementTree.SubElement(parent, f"{{{_WORD_NS}}}{tag}")
        run = ElementTree.SubElement(paragraph, f"{{{_WORD_NS}}}r")
        value = ElementTree.SubElement(run, f"{{{_WORD_NS}}}t")
        value.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        value.text = "—" if text is None else str(text)

    @classmethod
    def _table_cell(cls, row, value: object) -> None:
        cell = ElementTree.SubElement(row, f"{{{_WORD_NS}}}tc")
        properties = ElementTree.SubElement(cell, f"{{{_WORD_NS}}}tcPr")
        ElementTree.SubElement(
            properties,
            f"{{{_WORD_NS}}}tcW",
            {
                f"{{{_WORD_NS}}}w": "1200",
                f"{{{_WORD_NS}}}type": "dxa",
            },
        )
        paragraph = ElementTree.SubElement(cell, f"{{{_WORD_NS}}}p")
        run = ElementTree.SubElement(paragraph, f"{{{_WORD_NS}}}r")
        text = ElementTree.SubElement(run, f"{{{_WORD_NS}}}t")
        text.text = "—" if value is None else str(value)

    @classmethod
    def _document_xml(cls, report: CountReport) -> bytes:
        document = ElementTree.Element(f"{{{_WORD_NS}}}document")
        body = ElementTree.SubElement(document, f"{{{_WORD_NS}}}body")
        cls._append_text(body, "p", "代码统计报告")
        cls._append_text(body, "p", f"统计来源：{report.source}")
        cls._append_text(body, "p", f"生成时间：{report.generated_at}")
        cls._append_text(body, "p", f"跳过文件：{report.skipped_files}")

        table = ElementTree.SubElement(body, f"{{{_WORD_NS}}}tbl")
        properties = ElementTree.SubElement(table, f"{{{_WORD_NS}}}tblPr")
        borders = ElementTree.SubElement(properties, f"{{{_WORD_NS}}}tblBorders")
        for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
            ElementTree.SubElement(
                borders,
                f"{{{_WORD_NS}}}{edge}",
                {
                    f"{{{_WORD_NS}}}val": "single",
                    f"{{{_WORD_NS}}}sz": "4",
                    f"{{{_WORD_NS}}}space": "0",
                    f"{{{_WORD_NS}}}color": "808080",
                },
            )
        grid = ElementTree.SubElement(table, f"{{{_WORD_NS}}}tblGrid")
        for _ in range(10):
            ElementTree.SubElement(grid, f"{{{_WORD_NS}}}gridCol", {"{http://schemas.openxmlformats.org/wordprocessingml/2006/main}w": "1200"})

        headers = (
            "语言", "源文件数", "代码行数", "空行数", "注释行数",
            "函数个数", "最大值", "最小值", "均值", "中位数",
        )
        rows = [headers]
        for item in report.languages + [report.total]:
            rows.append(
                (
                    item.language,
                    item.source_files,
                    item.code_lines,
                    item.blank_lines,
                    item.comment_lines,
                    item.function_count,
                    item.function_lines_max,
                    item.function_lines_min,
                    item.function_lines_mean,
                    item.function_lines_median,
                )
            )

        for values in rows:
            row = ElementTree.SubElement(table, f"{{{_WORD_NS}}}tr")
            for value in values:
                cls._table_cell(row, value)

        section = ElementTree.SubElement(body, f"{{{_WORD_NS}}}sectPr")
        ElementTree.SubElement(
            section,
            f"{{{_WORD_NS}}}pgSz",
            {
                "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}w": "16838",
                "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}h": "11906",
                "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}orient": "landscape",
            },
        )
        return ElementTree.tostring(document, encoding="utf-8", xml_declaration=True)

    def export(self, report: CountReport, path: str) -> None:
        content_types = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            "</Types>"
        )
        package_relationships = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            "</Relationships>"
        )
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as document:
            document.writestr("[Content_Types].xml", content_types)
            document.writestr("_rels/.rels", package_relationships)
            document.writestr("word/document.xml", self._document_xml(report))


_WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


class ExportService:
    """Selects an exporter from an injected format-to-strategy registry."""

    def __init__(self, exporters: Mapping[str, ReportExporter]):
        if not exporters:
            raise ValueError("至少需要注册一种报告导出器。")
        self._exporters = dict(exporters)

    @property
    def formats(self) -> Mapping[str, ReportExporter]:
        return self._exporters

    def export(self, report: CountReport, format_name: str, path: str) -> None:
        try:
            exporter = self._exporters[format_name.lower()]
        except KeyError as exc:
            raise ValueError(f"不支持的导出格式：{format_name}") from exc
        exporter.export(report, path)


DEFAULT_EXPORTERS: Mapping[str, ReportExporter] = {
    "json": JsonReportExporter(),
    "txt": TextReportExporter(),
    "docx": DocxReportExporter(),
}
