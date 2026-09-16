@echo off
chcp 65001 > nul
title 타임라인 여행 동선 영상 제작기
cd /d "%~dp0"

python create_video.py
pause
