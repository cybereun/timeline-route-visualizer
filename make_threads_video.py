"""
Threads / Reels / Shorts 전용 세로형(9:16) 동선 영상 제작기
인스타그램 스레드(Threads)에서 화제가 된 바로 그 형태의 세로 여행 비디오를 생성합니다.
"""

import os
import subprocess
import sys
from datetime import datetime

DEFAULT_JSON = r"C:\Temp\timeline\타임라인.json"
VISUALIZER_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "visualizer.py")


def clear_console():
    os.system("cls" if os.name == "nt" else "clear")


def main():
    clear_console()
    print("=" * 65)
    print(" 📱 Threads / Reels / Shorts 전용 여행 동선 영상 제작기")
    print("=" * 65)
    print(" Threads(@kim3kimkim)에 올라온 것과 동일한 세로(9:16) 비율의")
    print(" 감각적인 동선 애니메이션 비디오(MP4)를 제작합니다.\n")

    json_path = DEFAULT_JSON
    if not os.path.exists(json_path):
        print(f"[알림] 기본 파일 경로({DEFAULT_JSON})에 파일이 없습니다.")
        custom = input("타임라인.json 파일 경로를 입력하세요: ").strip().strip('"')
        if os.path.exists(custom):
            json_path = custom
        else:
            print("[오류] 유효한 파일을 찾을 수 없습니다.")
            input("엔터를 누르면 종료합니다...")
            return

    print(f"✔ 타임라인 파일: {json_path}\n")

    print("📌 제작할 기간을 선택하세요:")
    print("  [1] 2026년 전체 (올해)")
    print("  [2] 2025년 전체 (작년)")
    print("  [3] 2024년 전체")
    print("  [4] 연도 범위 지정 (예: 2020 ~ 2025년)")
    print("  [5] 특정 단일 연도 직접 입력 (예: 2023)")
    print("  [6] 특정 날짜 범위 직접 입력 (시작일 ~ 종료일)")

    choice = input("선택 번호 입력 [기본값: 1]: ").strip()
    if not choice:
        choice = "1"

    target_year = None
    start_date = None
    end_date = None

    if choice == "1":
        target_year = "2026"
    elif choice == "2":
        target_year = "2025"
    elif choice == "3":
        target_year = "2024"
    elif choice == "4":
        sy = input("시작 연도 입력 (예: 2020): ").strip()
        ey = input("종료 연도 입력 (예: 2025): ").strip()
        start_date = f"{sy}-01-01"
        end_date = f"{ey}-12-31"
        title_preset = f"{sy}~{ey}년 여행 동선"
    elif choice == "5":
        y = input("연도 입력 (예: 2023): ").strip()
        target_year = y if y else "2026"
    elif choice == "6":
        start_date = input("시작 날짜 (YYYY-MM-DD 또는 YYYY-MM): ").strip()
        end_date = input("종료 날짜 (YYYY-MM-DD 또는 YYYY-MM): ").strip()

    print()

    # 화질 선택 (720p 세로: 720x1280, 1080p 세로: 1080x1920)
    print("📌 화질을 선택하세요:")
    print("  [1] 720p (720 × 1280 - 인스타/스레드 추천, 빠른 제작)")
    print("  [2] 1080p (1080 × 1920 - FHD 초고화질)")
    res_choice = input("선택 번호 입력 [기본값: 1]: ").strip()
    resolution = "1080" if res_choice == "2" else "720"

    print()

    # 영상 길이
    dur_input = input("📌 영상 길이(초 단위, 10~60초) [기본값: 20초]: ").strip()
    try:
        duration = int(dur_input) if dur_input else 20
        duration = max(10, min(60, duration))
    except ValueError:
        duration = 20

    # 카메라 스타일 선택
    print("📌 카메라 스타일을 선택하세요:")
    print("  [1] 대한민국 전체 고정 뷰 (추천: 확대 없이 우리나라 전체가 한눈에 보임)")
    print("  [2] 동적 카메라 (Dynamic: 이동 경로를 따라 확대/이동)")
    cam_choice = input("선택 번호 입력 [기본값: 1]: ").strip()
    camera_mode = "dynamic" if cam_choice == "2" else "korea"

    print()

    # 영상 제목
    if 'title_preset' in locals():
        default_title = title_preset
    elif target_year:
        default_title = f"{target_year}년 여행 기록"
    else:
        default_title = "나의 여행 동선"
    title_input = input(f"📌 영상 상단 제목 [기본값: {default_title}]: ").strip()
    title = title_input if title_input else default_title

    # 출력 파일명
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_filename = f"threads_story_{timestamp}.mp4"
    output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), out_filename)

    cmd = [
        sys.executable,
        VISUALIZER_PY,
        "-i", json_path,
        "-o", output_path,
        "-a", "portrait",  # 9:16 세로
        "-r", resolution,
        "-c", camera_mode, # korea(전체 고정) 또는 dynamic
        "-d", str(duration),
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

    print("\n" + "=" * 65)
    print(" 🚀 Threads 스타일 세로 영상 렌더링을 시작합니다...")
    print("    (지도를 다운로드하며 부드러운 애니메이션 프레임을 생성합니다)")
    print("=" * 65)

    try:
        res = subprocess.run(cmd)
        if res.returncode == 0:
            print("\n" + "=" * 65)
            print(" 🎉 세로 동선 영상(MP4) 제작 완료!")
            print(f" 📂 저장 위치: {output_path}")
            print(" 📱 Threads, Instagram Reels, Shorts에 바로 업로드하실 수 있습니다.")
            print("=" * 65)

            # 비디오 자동 재생
            try:
                if os.name == "nt":
                    os.startfile(output_path)
            except Exception:
                pass
        else:
            print(f"\n[오류] 렌더링 실패 (반환 코드: {res.returncode})")
    except Exception as e:
        print(f"\n[오류 발생]: {e}")

    input("\n엔터를 누르면 메뉴를 마칩니다...")


if __name__ == "__main__":
    main()
