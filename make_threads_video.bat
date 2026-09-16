@echo off
chcp 65001 > nul
title Threads / Reels 여행 동선 영상 제작기
cd /d "%~dp0"

python make_threads_video.py
pause
