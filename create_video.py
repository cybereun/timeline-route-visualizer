"""
타임라인 여행 동선 비디오 생성기 (Google Timeline Visualizer 런처)
C:\Temp\timeline\타임라인.json 데이터를 바탕으로 멋진 여행 애니메이션 MP4 영상을 제작합니다.
"""

import os
import subprocess
import sys
from datetime import datetime

DEFAULT_JSON = r"C:\Temp\timeline\타임라인.json"
VISUALIZER_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "visualizer.py")


def clear_console():
    os.system("cls" if os.name == "nt" else "clear")


def prompt_choice(prompt_text, options, default_idx=0):
    print(prompt_text)
    for i, opt in enumerate(options, 1):
        marker = " (기본값)" if i - 1 == default_idx else ""
        print(f"  [{i}] {opt['label']}{marker}")
    while True:
        choice = input(f"선택 번호 입력 [기본값: {default_idx + 1}]: ").strip()
        if not choice:
            return options[default_idx]["value"]
        if choice.isdigit():
            idx = int(choice) - 1
            if 0 <= idx < len(options):
                return options[idx]["value"]
        print("잘못된 입력입니다. 올바른 번호를 입력해 주세요.")


def main():
    clear_console()
    print("=" * 60)
    print("      🎬 Google 타임라인 여행 동선 영상 제작기 (Visualizer)")
    print("=" * 60)
    print("  Google 지도 타임라인 데이터를 바탕으로 부드러운 카메라 무빙과")
    print("  이동 경로 궤적이 담긴 고화질 MP4 영상을 생성합니다.\n")

    json_path = DEFAULT_JSON
    if not os.path.exists(json_path):
        print(f"[알림] 기본 파일 경로({DEFAULT_JSON})에 파일이 없습니다.")
        custom = input("타임라인.json 파일 전체 경로를 입력하세요: ").strip().strip('"')
        if os.path.exists(custom):
            json_path = custom
        else:
            print("[오류] 유효한 파일을 찾을 수 없습니다.")
            input("엔터를 누르면 종료합니다...")
            return

    print(f"✔ 타임라인 파일: {json_path}\n")

    # 1. 기간 선택
    period_options = [
        {"label": "2026년 전체 (올해)", "value": ("year", "2026")},
        {"label": "2025년 전체", "value": ("year", "2025")},
        {"label": "2024년 전체", "value": ("year", "2024")},
        {"label": "2026년 최근 1개월 (2026-08 ~ 2026-09)", "value": ("range", ("2026-08-01", "2026-09-15"))},
        {"label": "직접 연도 입력", "value": ("custom_year", None)},
        {"label": "직접 날짜 범위 입력 (시작일 ~ 종료일)", "value": ("custom_range", None)},
    ]
    period_type, period_val = prompt_choice("1. 영상으로 만들 기간을 선택하세요:", period_options, default_idx=0)

    start_date = None
    end_date = None
    target_year = None

    if period_type == "year":
        target_year = period_val
    elif period_type == "range":
        start_date, end_date = period_val
    elif period_type == "custom_year":
        y = input("연도를 입력하세요 (예: 2023): ").strip()
        target_year = y if y else "2026"
    elif period_type == "custom_range":
        s = input("시작 날짜 (YYYY-MM-DD 또는 YYYY-MM): ").strip()
        e = input("종료 날짜 (YYYY-MM-DD 또는 YYYY-MM): ").strip()
        start_date = s if s else "2026-08-01"
        end_date = e if e else "2026-09-15"

    print()

    # 2. 화면 비율 선택
    aspect_options = [
        {"label": "정사각형 (1:1) - 인스타그램 피드, 일반 소장용", "value": "square"},
        {"label": "세로 (9:16) - 인스타 릴스, 유튜브 쇼츠, 틱톡용", "value": "portrait"},
        {"label": "가로 (16:9) - 유튜브 일반 영상, PC/TV 재생용", "value": "landscape"},
    ]
    aspect_ratio = prompt_choice("2. 영상 화면 비율을 선택하세요:", aspect_options, default_idx=0)
    print()

    # 3. 해상도 선택
    res_options = [
        {"label": "720p (빠른 렌더링 & 좋은 화질 추천)", "value": "720"},
        {"label": "1080p (고화질)", "value": "1080"},
        {"label": "480p (초고속 렌더링)", "value": "480"},
    ]
    resolution = prompt_choice("3. 영상 해상도를 선택하세요:", res_options, default_idx=0)
    print()

    # 4. 카메라 무빙 방식 선택
    camera_options = [
        {"label": "대한민국 전체 고정 뷰 (추천: 확대 없이 우리나라 전체가 한눈에 보임)", "value": "korea"},
        {"label": "동적 카메라 (Dynamic - 이동에 맞춰 부드럽게 줌인/줌아웃)", "value": "dynamic"},
        {"label": "안정적 카메라 (Steady - 일정한 시야 유지)", "value": "steady"},
        {"label": "클로즈업 카메라 (Close-up - 경로에 근접하여 상세 추적)", "value": "close_up"},
        {"label": "고정 카메라 (Fixed - 시작/종료 지점 기준 고정)", "value": "fixed"},
    ]
    camera_movement = prompt_choice("4. 카메라 움직임 스타일을 선택하세요:", camera_options, default_idx=0)
    print()

    # 5. 영상 길이
    duration_input = input("5. 영상 재생 시간(초 단위, 10~120) [기본값: 20초]: ").strip()
    try:
        duration = int(duration_input) if duration_input else 20
        duration = max(10, min(120, duration))
    except ValueError:
        duration = 20
    print(f"✔ 영상 길이: {duration}초\n")

    # 6. 영상 제목
    default_title = f"{target_year}년 여행 동선" if target_year else f"{start_date} ~ {end_date} 동선"
    title_input = input(f"6. 영상 상단 제목 [기본값: {default_title}]: ").strip()
    title = title_input if title_input else default_title
    print(f"✔ 제목: {title}\n")

    # 7. 출력 파일명
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_filename = f"travel_{timestamp}.mp4"
    output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), out_filename)

    # 명령줄 조합
    cmd = [
        sys.executable,
        VISUALIZER_PY,
        "-i", json_path,
        "-o", output_path,
        "--aspect-ratio", aspect_ratio,
        "--resolution", resolution,
        "--camera-movement", camera_movement,
        "--duration", str(duration),
        "--fps", "30",
        "--title", title,
    ]

    if target_year:
        cmd.extend(["--year", str(target_year)])
    else:
        if start_date:
            cmd.extend(["--start-date", start_date])
        if end_date:
            cmd.extend(["--end-date", end_date])

    print("=" * 60)
    print(" 🚀 영상 렌더링을 시작합니다. 잠시만 기다려 주세요...")
    print("=" * 60)

    try:
        res = subprocess.run(cmd)
        if res.returncode == 0:
            print("\n" + "=" * 60)
            print(" 🎉 축하합니다! 동선 영상이 성공적으로 제작되었습니다!")
            print(f" 📂 저장 위치: {output_path}")
            print("=" * 60)

            # 비디오 자동 재생
            try:
                if os.name == "nt":
                    os.startfile(output_path)
            except Exception:
                pass
        else:
            print(f"\n[오류] 렌더링 중 문제가 발생했습니다 (반환 코드: {res.returncode})")
    except Exception as e:
        print(f"\n[오류 발생]: {e}")

    input("\n엔터를 누르면 메뉴를 마칩니다...")


if __name__ == "__main__":
    main()
