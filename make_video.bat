@echo off
chcp 65001 > nul
title Google Timeline Visualizer - 동선 영상 제작기
cd /d "%~dp0"

python create_video.py
pause
