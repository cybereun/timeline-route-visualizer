from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import json
import mimetypes
import os
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid
import webbrowser

PORT = 8765
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
IS_VERCEL = bool(os.environ.get("VERCEL"))

if IS_VERCEL:
    DB_PATH = "/tmp/timeline.db"
    VIDEOS_DIR = "/tmp/generated_videos"
else:
    DB_PATH = os.path.join(BASE_DIR, "timeline.db")
    VIDEOS_DIR = os.path.join(BASE_DIR, "generated_videos")

STATIC_DIR = os.path.join(BASE_DIR, "static")
os.makedirs(VIDEOS_DIR, exist_ok=True)

# 렌더링 작업 상태 관리 {job_id: {status, progress, message, file, created_at, error}}
RENDER_JOBS = {}


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='segments'")
    if not cursor.fetchone():
        import parse_timeline
        parse_timeline.init_db(conn)
    return conn


class TimelineRequestHandler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        # 콘솔 로그 간소화
        pass

    def get_effective_path(self):
        # Vercel Serverless Function에서 rewrites 후의 원래 요청 경로 복원
        matched = self.headers.get("x-matched-path")
        if matched and matched.startswith("/api/"):
            return matched
        forwarded = self.headers.get("x-forwarded-uri")
        if forwarded and forwarded.startswith("/api/"):
            return forwarded
        return self.path

    def do_OPTIONS(self):
        # CORS Preflight 대응
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        raw_path = self.get_effective_path()
        parsed_url = urllib.parse.urlparse(raw_path)
        path = parsed_url.path
        query = urllib.parse.parse_qs(parsed_url.query)

        if path == "/" or path == "/index.html":
            self.serve_file(os.path.join(STATIC_DIR, "index.html"), "text/html")
        elif path.startswith("/static/"):
            rel_path = path[8:]  # strip /static/
            file_path = os.path.join(STATIC_DIR, rel_path)
            self.serve_file(file_path)
        elif path.startswith("/videos/"):
            rel_path = path[8:]  # strip /videos/
            file_path = os.path.join(VIDEOS_DIR, rel_path)
            self.serve_file(file_path, "video/mp4")
        elif path == "/api/dates":
            self.handle_api_dates(query)
        elif path == "/api/day":
            self.handle_api_day(query)
        elif path == "/api/heatmap":
            self.handle_api_heatmap(query)
        elif path == "/api/summary":
            self.handle_api_summary()
        elif path == "/api/video/status":
            self.handle_api_video_status(query)
        elif path == "/api/video/list":
            self.handle_api_video_list()
        else:
            self.send_error(404, "Not Found")

    def do_POST(self):
        raw_path = self.get_effective_path()
        parsed_url = urllib.parse.urlparse(raw_path)
        path = parsed_url.path

        if path == "/api/video/render":
            self.handle_api_video_render()
        elif path == "/api/upload":
            self.handle_api_upload()
        else:
            self.send_error(404, "Not Found")

    def serve_file(self, file_path, content_type=None):
        if not os.path.exists(file_path) or os.path.isdir(file_path):
            self.send_error(404, "File Not Found")
            return
        if not content_type:
            content_type, _ = mimetypes.guess_type(file_path)
            if not content_type:
                content_type = "application/octet-stream"

        try:
            with open(file_path, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header(
                "Content-Type", f"{content_type}; charset=utf-8"
            )
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(content)
            self.wfile.flush()
        except Exception as e:
            self.send_error(500, f"Server Error: {str(e)}")

    def send_json(self, data):
        content = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(content)
        self.wfile.flush()

    def handle_api_dates(self, query):
        year = query.get("year", [None])[0]
        conn = get_db()
        cursor = conn.cursor()

        if year:
            cursor.execute(
                """
                SELECT date, COUNT(*) as seg_count, SUM(COALESCE(distance_meters, 0)) as total_dist
                FROM segments
                WHERE date LIKE ? AND date != ''
                GROUP BY date
                ORDER BY date ASC
            """,
                (f"{year}-%",),
            )
        else:
            cursor.execute("""
                SELECT date, COUNT(*) as seg_count, SUM(COALESCE(distance_meters, 0)) as total_dist
                FROM segments
                WHERE date != ''
                GROUP BY date
                ORDER BY date ASC
            """)

        rows = cursor.fetchall()
        dates = [
            {
                "date": r["date"],
                "count": r["seg_count"],
                "dist": round(r["total_dist"] / 1000.0, 2)
                if r["total_dist"]
                else 0.0,
            }
            for r in rows
        ]

        # 고유 연도 목록
        cursor.execute("""
            SELECT DISTINCT SUBSTR(date, 1, 4) as yr
            FROM segments
            WHERE date != '' AND LENGTH(date) >= 4
            ORDER BY yr DESC
        """)
        years = [r["yr"] for r in cursor.fetchall()]

        conn.close()
        self.send_json({"years": years, "dates": dates})

    def handle_api_day(self, query):
        date = query.get("date", [None])[0]
        if not date:
            self.send_json({"error": "date 파라미터가 필요합니다."})
            return

        conn = get_db()
        cursor = conn.cursor()

        # 해당 날짜의 세그먼트 조회
        cursor.execute(
            """
            SELECT * FROM segments
            WHERE date = ?
            ORDER BY start_time ASC
        """,
            (date,),
        )
        segs = cursor.fetchall()

        result_segments = []
        all_day_points = []

        for s in segs:
            seg_id = s["id"]
            # 해당 세그먼트의 points 조회
            cursor.execute(
                """
                SELECT time, lat, lng FROM points
                WHERE segment_id = ?
                ORDER BY time ASC, id ASC
            """,
                (seg_id,),
            )
            pts = cursor.fetchall()
            point_list = [[p["lat"], p["lng"], p["time"]] for p in pts]

            seg_dict = {
                "id": s["id"],
                "date": s["date"],
                "startTime": s["start_time"],
                "endTime": s["end_time"],
                "type": s["seg_type"],
                "activityType": s["activity_type"],
                "distanceMeters": s["distance_meters"],
                "placeId": s["place_id"],
                "placeName": s["place_name"],
                "placeAddress": s["place_address"],
                "startLat": s["start_lat"],
                "startLng": s["start_lng"],
                "endLat": s["end_lat"],
                "endLng": s["end_lng"],
                "durationMinutes": s["duration_minutes"],
                "points": point_list,
            }
            result_segments.append(seg_dict)
            for p in point_list:
                all_day_points.append(p)

        conn.close()
        self.send_json({
            "date": date,
            "segments": result_segments,
            "totalPoints": len(all_day_points),
        })

    def handle_api_heatmap(self, query):
        year = query.get("year", [None])[0]
        month = query.get("month", [None])[0]

        conn = get_db()
        cursor = conn.cursor()

        params = []
        where_clauses = ["lat IS NOT NULL", "lng IS NOT NULL"]

        if year and year != "all":
            if month and month != "all":
                target_prefix = f"{year}-{month.zfill(2)}%"
            else:
                target_prefix = f"{year}%"
            where_clauses.append("date LIKE ?")
            params.append(target_prefix)

        where_sql = " AND ".join(where_clauses)

        # 포인트가 많을 수 있으므로 적절히 샘플링 (10배수 또는 round)
        # SQLite에서 빠른 로딩을 위해 최대 25,000개 포인트로 추출
        query_sql = f"""
            SELECT lat, lng
            FROM points
            WHERE {where_sql}
            LIMIT 25000
        """
        cursor.execute(query_sql, params)
        rows = cursor.fetchall()

        # [lat, lng, intensity]
        points = [[round(r["lat"], 5), round(r["lng"], 5), 0.7] for r in rows]
        conn.close()
        self.send_json({"count": len(points), "points": points})

    def handle_api_summary(self):
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            "SELECT COUNT(DISTINCT date) FROM segments WHERE date != ''"
        )
        total_days = cursor.fetchone()[0]

        cursor.execute("SELECT COUNT(*) FROM segments")
        total_segs = cursor.fetchone()[0]

        cursor.execute("SELECT COUNT(*) FROM points")
        total_points = cursor.fetchone()[0]

        cursor.execute(
            "SELECT SUM(COALESCE(distance_meters, 0)) FROM segments"
        )
        total_dist_meters = cursor.fetchone()[0] or 0.0

        cursor.execute("SELECT COUNT(*) FROM segments WHERE seg_type = 'VISIT'")
        total_visits = cursor.fetchone()[0]

        # 활동 유형별 빈도
        cursor.execute("""
            SELECT activity_type, COUNT(*) as cnt, SUM(COALESCE(distance_meters, 0)) as dist
            FROM segments
            WHERE seg_type = 'ACTIVITY' AND activity_type IS NOT NULL
            GROUP BY activity_type
            ORDER BY cnt DESC
        """)
        activities = [
            {
                "type": r["activity_type"],
                "count": r["cnt"],
                "distanceKm": round(r["dist"] / 1000.0, 1)
                if r["dist"]
                else 0.0,
            }
            for r in cursor.fetchall()
        ]

        # 날짜 최소/최대
        cursor.execute(
            "SELECT MIN(date), MAX(date) FROM segments WHERE date != ''"
        )
        min_date, max_date = cursor.fetchone()

        conn.close()
        self.send_json({
            "totalDays": total_days,
            "totalSegments": total_segs,
            "totalPoints": total_points,
            "totalDistanceKm": round(total_dist_meters / 1000.0, 1),
            "totalVisits": total_visits,
            "startDate": min_date,
            "endDate": max_date,
            "activities": activities,
        })

    def handle_api_video_render(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            params = json.loads(body.decode("utf-8")) if body else {}

            job_id = str(uuid.uuid4())[:8]
            timestamp_str = time.strftime("%Y%m%d_%H%M%S")
            filename = f"timeline_video_{timestamp_str}_{job_id}.mp4"
            output_file = os.path.join(VIDEOS_DIR, filename)

            # 옵션 파싱
            year = params.get("year")
            start_date = params.get("start_date")
            end_date = params.get("end_date")
            title = params.get("title") or "나의 여행 동선"
            camera = params.get("camera") or "korea"
            aspect = params.get("aspect") or "portrait"
            duration = int(params.get("duration") or 20)
            resolution = str(params.get("resolution") or "720")
            fps = str(params.get("fps") or "30")

            RENDER_JOBS[job_id] = {
                "job_id": job_id,
                "status": "queued",
                "progress": 0,
                "message": "렌더링 준비 중...",
                "file": filename,
                "video_url": f"/videos/{filename}",
                "title": title,
                "created_at": time.time(),
                "error": None
            }

            # 백그라운드 스레드에서 렌더링 실행
            def run_render():
                try:
                    RENDER_JOBS[job_id]["status"] = "processing"
                    RENDER_JOBS[job_id]["message"] = "지도 타일 로드 및 애니메이션 프레임 생성 중..."
                    RENDER_JOBS[job_id]["progress"] = 20

                    vis_script = os.path.join(BASE_DIR, "visualizer.py")
                    cmd = [
                        sys.executable,
                        vis_script,
                        "-o", output_file,
                        "-a", aspect,
                        "-r", resolution,
                        "-c", camera,
                        "-d", str(duration),
                        "--fps", fps,
                        "--title", title,
                    ]

                    if year:
                        cmd.extend(["--year", str(year)])
                    else:
                        if start_date:
                            cmd.extend(["--start-date", str(start_date)])
                        if end_date:
                            cmd.extend(["--end-date", str(end_date)])

                    proc = subprocess.Popen(
                        cmd,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                        cwd=BASE_DIR
                    )

                    stdout, stderr = proc.communicate()
                    if proc.returncode == 0 and os.path.exists(output_file) and os.path.getsize(output_file) > 1000:
                        RENDER_JOBS[job_id]["status"] = "completed"
                        RENDER_JOBS[job_id]["progress"] = 100
                        RENDER_JOBS[job_id]["message"] = "동선 영상 제작 완료!"
                    else:
                        err_msg = stderr.strip() or stdout.strip() or f"코드 {proc.returncode}"
                        RENDER_JOBS[job_id]["status"] = "failed"
                        RENDER_JOBS[job_id]["error"] = err_msg
                        RENDER_JOBS[job_id]["message"] = f"제작 실패: {err_msg[:100]}"
                except Exception as exc:
                    RENDER_JOBS[job_id]["status"] = "failed"
                    RENDER_JOBS[job_id]["error"] = str(exc)
                    RENDER_JOBS[job_id]["message"] = f"오류 발생: {str(exc)}"

            th = threading.Thread(target=run_render, daemon=True)
            th.start()

            self.send_json({
                "success": True,
                "job_id": job_id,
                "message": "영상 렌더링이 시작되었습니다."
            })
        except Exception as e:
            self.send_json({"success": False, "error": str(e)})

    def handle_api_video_status(self, query):
        job_id = query.get("job_id", [None])[0]
        if not job_id or job_id not in RENDER_JOBS:
            self.send_json({"success": False, "error": "존재하지 않는 작업 ID입니다."})
            return
        self.send_json({"success": True, "job": RENDER_JOBS[job_id]})

    def handle_api_video_list(self):
        videos = []
        if os.path.exists(VIDEOS_DIR):
            for f in sorted(os.listdir(VIDEOS_DIR), reverse=True):
                if f.endswith(".mp4"):
                    fp = os.path.join(VIDEOS_DIR, f)
                    videos.append({
                        "filename": f,
                        "url": f"/videos/{f}",
                        "size": os.path.getsize(fp),
                        "mtime": os.path.getmtime(fp)
                    })
        self.send_json({"success": True, "videos": videos})

    def handle_api_upload(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length <= 0:
                self.send_json({"success": False, "error": "전송된 데이터가 없습니다."})
                return

            temp_upload_path = os.path.join(BASE_DIR, "temp_uploaded_timeline.json")
            # 스트리밍 저장
            remaining = content_length
            chunk_size = 65536
            with open(temp_upload_path, "wb") as f:
                while remaining > 0:
                    chunk = self.rfile.read(min(remaining, chunk_size))
                    if not chunk:
                        break
                    f.write(chunk)
                    remaining -= len(chunk)

            # parse_timeline 모듈 호출
            import parse_timeline
            stats = parse_timeline.parse_and_import_json(temp_upload_path, DB_PATH)

            try:
                os.remove(temp_upload_path)
            except Exception:
                pass

            self.send_json({
                "success": True,
                "message": "타임라인 데이터가 성공적으로 적재되었습니다!",
                "stats": stats
            })
        except Exception as e:
            self.send_json({"success": False, "error": str(e)})


def run_server():
    if not os.path.exists(DB_PATH):
        print(f"알림: DB 파일({DB_PATH})이 없습니다. 기본 빈 데이터베이스를 초기화합니다.")
        conn = sqlite3.connect(DB_PATH)
        import parse_timeline
        parse_timeline.init_db(conn)
        conn.close()

    auto_open = "--no-browser" not in sys.argv

    server_address = ("", PORT)
    httpd = ThreadingHTTPServer(server_address, TimelineRequestHandler)
    print(f"=======================================================")
    print(f" 타임라인 지도 시각화 서버가 실행되었습니다!")
    print(f" 접속 주소: http://localhost:{PORT}")
    print(f" 종료하려면 Ctrl+C 를 누르세요.")
    print(f"=======================================================")

    if auto_open:
        try:
            webbrowser.open(f"http://localhost:{PORT}")
        except Exception:
            pass

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n서버를 종료합니다.")
        httpd.server_close()


# Vercel Serverless Function 진입점 (Top-level handler & app export)
handler = TimelineRequestHandler
app = TimelineRequestHandler

if __name__ == "__main__":
    run_server()
