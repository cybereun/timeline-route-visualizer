@echo off
chcp 65001 > nul
title 내 동선 타임라인 지도
echo ========================================================
echo          내 동선 타임라인 지도 시각화 프로그램
echo ========================================================
echo.

cd /d "%~dp0"

REM DB 파일 존재 여부 확인
if not exist "timeline.db" (
    echo [안내] timeline.db 파일이 없습니다.
    echo C:\Temp\timeline\타임라인.json 파일을 읽어 DB를 생성합니다...
    python parse_timeline.py
    if errorlevel 1 (
        echo [오류] DB 생성 중 오류가 발생했습니다.
        pause
        exit /b 1
    )
    echo.
)

echo [안내] 로컬 웹 서버를 실행합니다... (접속: http://localhost:8765)
echo [안내] 잠시 후 기본 웹 브라우저가 자동으로 실행됩니다.
echo [종료] 프로그램을 종료하려면 이 창에서 Ctrl+C 를 누르거나 창을 닫으세요.
echo.
python server.py

pause
