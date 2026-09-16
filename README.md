# 🗺️ Timeline Route Visualizer (타임라인 동선 지도 & 세로 릴스 영상 제작기)

<p align="center">
  <img src="static/icon-512.png" alt="Timeline App Icon" width="130" height="130" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Developer-cybereun-f43f5e?style=for-the-badge&logo=github" alt="Developer" />
  <img src="https://img.shields.io/badge/Python-3.10+-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python" />
  <img src="https://img.shields.io/badge/PWA-Ready-10b981?style=for-the-badge&logo=pwa&logoColor=white" alt="PWA" />
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License" />
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-4c1?style=for-the-badge" alt="Platform" />
</p>

<p align="center">
  <b>Google Takeout 위치 기록(타임라인.json)을 활용한 나만의 감성 여행 지도 & 9:16 세로 릴스(Reels) 동선 영상 원클릭 제작기</b>
</p>

---

## ✨ 핵심 특징 (Key Features)

- 📱 **Threads / Instagram Reels 스타일 세로 영상(9:16) 원클릭 제작**
  - SNS에서 화제가 된 감각적인 핑크빛 궤적 애니메이션 비디오(MP4)를 클릭 한 번으로 제작
  - **상단 플로팅 카드**: 제목, 날짜(월/연도), 실시간 누적 주행거리(km) 자동 카운팅
- 📅 **유연한 기간 지정 지원**
  - 단일 연도 선택 (예: `2026년`, `2025년`, `2024년`)
  - **연도 범위 지정** (예: `2020년 ~ 2025년` 등 다년간의 전국 누적 여행 기록)
  - 상세 날짜 지정 (휴가/여행 주간 등 특정 시작일 ~ 종료일)
- 🗺️ **고화질 워터마크 없는 지도 (ESRI ArcGIS World Topo)**
  - OpenStreetMap의 403 차단 오류 및 상용 워터마크를 완벽 차단
  - 한반도 전역의 지형·도로·산맥·해안선이 선명하게 표현되는 고화질 지도 적용
  - **대한민국 전체 고정 뷰**: 화면이 흔들리거나 과도하게 줌인되지 않고 우리나라 전체가 세로 화면에 꽉 찬 상태에서 동선만 유려하게 그려짐
- 💻 **올인원 PWA 웹 애플리케이션 탑재**
  - 브라우저에서 날짜별 동선 탐색, 시간대별 애니메이션 플레이어, 13년 누적 밀도 히트맵 제공
  - **파일 드래그 & 드롭 업로드**: 누구든 본인의 `타임라인.json`을 웹에 끌어다 놓기만 하면 즉시 분석 및 시각화
  - 데스크톱 및 모바일에서 독립 앱(PWA)으로 설치 지원
- ⚡ **SQLite 기반 초고속 대용량 인덱싱**
  - 수십만 개의 GPS 좌표와 수만 개의 방문/이동 세그먼트를 밀리초 단위로 쿼리

---

## 🚀 빠른 시작 (Quick Start)

### 1. 필수 요구사항
- **Python 3.10** 이상
- FFmpeg (비디오 인코딩용, `imageio-ffmpeg` 패키지를 통해 자동 구성됨)

### 2. 설치 및 종속성 구성
```bash
git clone https://github.com/cybereun/timeline-route-visualizer.git
cd timeline-route-visualizer
pip install -r requirements.txt
```

### 3. 실행 방법

#### 방법 A. 통합 웹 애플리케이션 실행 (추천 ⭐)
Windows 환경에서는 `run.bat`을 더블클릭하거나, 터미널에서 다음을 실행합니다:
```bash
python server.py
```
브라우저에서 **http://localhost:8765** 접속:
1. 좌측 상단 **[불러오기]** 버튼을 눌러 본인의 `타임라인.json` 파일을 드래그&드롭
2. **[일별 동선]** 탭에서 날짜별 이동 경로 및 타임라인 슬라이더 재생
3. **[세로 영상 제작]** 탭에서 연도 범위(예: 2020~2025)를 선택하고 **[세로 동선 영상 만들기]** 클릭
4. 완성된 비디오를 인앱 플레이어로 즉시 감상하고 **[MP4 영상 다운로드]**!

#### 방법 B. 마우스 원클릭 비디오 제작 (Windows)
- 탐색기에서 `make_threads_video.bat` 더블클릭
- 콘솔 메뉴에서 연도 범위 또는 기간을 선택하면 즉시 렌더링 후 영상이 자동 재생됩니다.

#### 방법 C. 커맨드라인(CLI) 직접 실행
```bash
# 2020~2025년 대한민국 전체 고정 세로 릴스 비디오 제작
python visualizer.py -c korea -a portrait -r 720 -d 20 --start-date 2020-01-01 --end-date 2025-12-31 --title "2020~2025 전국 여행 동선" -o my_journey.mp4
```

---

## ⚙️ 주요 CLI 옵션 (`visualizer.py`)

| 옵션 | 설명 | 기본값 |
|---|---|---|
| `-c, --camera-movement` | 카메라 시점 (`korea`: 대한민국 전체 고정, `dynamic`: 경로 추적, `steady`: 부드러운 팔로우) | `korea` |
| `-a, --aspect-ratio` | 화면 비율 (`portrait`: 9:16 세로, `landscape`: 16:9 가로, `square`: 1:1) | `portrait` |
| `-r, --resolution` | 단축 해상도 (`720`, `1080`) | `720` |
| `-d, --duration` | 영상 총 재생 시간 (초 단위) | `20` |
| `--start-date` | 시작 날짜 (YYYY-MM-DD) | - |
| `--end-date` | 종료 날짜 (YYYY-MM-DD) | - |
| `--year` | 단일 연도 지정 (YYYY) | - |
| `--title` | 상단 플로팅 카드 제목 | `대한민국 여행 동선` |

---

## 📂 프로젝트 구조

```text
timeline-route-visualizer/
├── server.py              # 통합 웹앱 백엔드 서버 (ThreadingHTTPServer + REST API)
├── visualizer.py          # 고화질 타일 맵 합성 및 MP4 비디오 렌더링 코어 엔진
├── parse_timeline.py      # 대용량 타임라인 JSON 파싱 및 SQLite 인덱싱
├── make_threads_video.py  # 스레드/릴스 전용 대화형 콘솔 비디오 제작기
├── run.bat                # 웹 서버 원클릭 실행 배치 파일
├── make_threads_video.bat # 비디오 제작 원클릭 실행 배치 파일
├── requirements.txt       # 의존성 패키지 목록
└── static/                # 웹 프론트엔드 정적 자산
    ├── index.html         # 올인원 대시보드 UI
    ├── style.css          # 모던 다크 테마 & 반응형 스타일
    ├── app.js             # Leaflet 지도 제어, 영상 제작 폴링, PWA 처리
    ├── manifest.json      # PWA 앱 매니페스트
    ├── sw.js              # PWA 서비스 워커
    ├── favicon.ico        # 브라우저 탭 멀티 파비콘
    ├── favicon-32x32.png  # 파비콘 PNG
    └── icon-512.png       # 512x512 고화질 투명 앱 아이콘
```

---

## 📱 Google 타임라인 데이터 가져오기 가이드

Google 지도에 저장된 이동 기록을 앱에서 사용하려면 먼저 타임라인 데이터를 JSON 파일로 내보내기 해야 합니다.

### 🤖 갤럭시 / 안드로이드
1. 휴대폰의 **설정** 앱을 엽니다.
2. **위치**를 선택합니다.
3. **위치 서비스**를 선택합니다.
4. **타임라인**을 선택합니다.
5. **타임라인 데이터 내보내기**를 누릅니다.
6. **계속**을 선택합니다.
7. 파일을 저장할 위치를 선택합니다.
8. **저장**을 누릅니다.
> **경로 요약**: `설정` → `위치` → `위치 서비스` → `타임라인` → `타임라인 데이터 내보내기`

### 🍎 아이폰 / iPad
1. **Google Maps** 앱을 실행합니다.
2. 오른쪽 위의 **프로필 사진**을 누릅니다.
3. **설정**을 선택합니다.
4. **개인 콘텐츠(Personal content)**를 선택합니다.
5. 타임라인 설정 섹션으로 스크롤합니다.
6. **타임라인 데이터 내보내기**를 선택합니다.
7. 화면의 안내에 따라 백업을 진행합니다.
8. 파일 앱 또는 원하는 위치에 저장합니다.
> **경로 요약**: `Google Maps 앱` → `프로필 아이콘` → `설정` → `개인 콘텐츠` → `타임라인 데이터 내보내기`

### 📁 파일명 안내
- 보통 내보내기한 파일 이름은 `location-history.json` 또는 사용자 지정 이름의 `.json` 파일입니다.
- 앱 실행 후 상단 **[도움말]** 또는 **[불러오기]** 버튼을 통해 업로드하시면 됩니다.

---

## ☁️ Vercel 배포 안내

본 프로젝트는 Vercel Python Serverless 런타임 호환을 지원합니다:
- `server.py` 최상위에 `handler = TimelineRequestHandler`가 정의되어 있어 Vercel Serverless Function으로 즉시 빌드 및 서빙됩니다.
- `vercel.json`을 통해 전체 경로가 통합 라우팅됩니다.
- *참고: 비디오(MP4) 고화질 렌더링은 OpenCV와 FFmpeg를 통한 로컬 하드웨어 자원이 필요하므로 로컬 실행(`python server.py`)을 권장합니다.*

---

## 🔒 개인정보 보호 (Privacy First)

- 본 프로그램은 사용자의 모든 위치 데이터(`타임라인.json`, `timeline.db`)를 **로컬 컴퓨터 내에서만 처리**합니다.
- 외부 서버로 개인의 이동 경로 데이터가 전송되지 않으므로 안심하고 사용하실 수 있습니다.
- Git 리포지토리에는 사용자의 개인 JSON 및 DB, 생성된 비디오 파일이 포함되지 않도록 `.gitignore`가 기본 설정되어 있습니다.

---

## 👨‍💻 Developer
Developed by **cybereun** with Google DeepMind Antigravity.
