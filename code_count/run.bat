@echo off
rem 便捷启动: 把文件夹拖到本图标上, 或双击后按提示操作
chcp 65001 >nul
python "%~dp0code_counter.py" %*
echo.
pause
