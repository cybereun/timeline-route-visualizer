"""
타임라인 JSON 파서 및 SQLite 변환 스크립트
위치: C:\Temp\timeline\타임라인.json -> timeline.db
"""

import json
import os
import re
import sqlite3
import sys
import time

JSON_PATH = r"C:\Temp\timeline\타임라인.json"
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "timeline.db")

coord_regex = re.compile(r"([+-]?\d+\.?\d*)\s*°?\s*,\s*([+-]?\d+\.?\d*)\s*°?")


def parse_lat_lng(point_str):
    if not point_str:
        return None, None
    m = coord_regex.search(str(point_str))
    if m:
        try:
            return float(m.group(1)), float(m.group(2))
        except ValueError:
            return None, None
    return None, None


def init_db(conn):
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS segments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT,
            start_time TEXT,
            end_time TEXT,
            seg_type TEXT,
            activity_type TEXT,
            distance_meters REAL,
            place_id TEXT,
            place_name TEXT,
            place_address TEXT,
            start_lat REAL,
            start_lng REAL,
            end_lat REAL,
            end_lng REAL,
            duration_minutes REAL
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS points (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            segment_id INTEGER,
            date TEXT,
            time TEXT,
            lat REAL,
            lng REAL,
            FOREIGN KEY(segment_id) REFERENCES segments(id)
        )
    """)

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_seg_date ON segments(date)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_pts_date ON points(date)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_pts_seg ON points(segment_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_pts_lat_lng ON points(lat, lng)")
    conn.commit()


def calculate_duration_minutes(start_time, end_time):
    # e.g., "2013-01-01T12:26:50.000+09:00"
    if not start_time or not end_time:
        return 0.0
    try:
        from datetime import datetime

        # Python 3.7+ supports fromisoformat with offset
        # Replace Z with +00:00 if present
        st = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
        et = datetime.fromisoformat(end_time.replace("Z", "+00:00"))
        return max(0.0, (et - st).total_seconds() / 60.0)
    except Exception:
        return 0.0


def parse_and_import_json(json_file_path, db_path=DB_PATH):
    if not os.path.exists(json_file_path):
        raise FileNotFoundError(f"타임라인 JSON 파일을 찾을 수 없습니다: {json_file_path}")

    start_ts = time.time()
    with open(json_file_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    raw_segments = data.get("semanticSegments", [])
    if not raw_segments and isinstance(data, list):
        raw_segments = data

    if os.path.exists(db_path):
        try:
            os.remove(db_path)
        except Exception:
            pass

    conn = sqlite3.connect(db_path)
    init_db(conn)
    cursor = conn.cursor()

    seg_batch = []
    pts_batch = []
    inserted_segs = 0
    inserted_pts = 0

    for i, s in enumerate(raw_segments, 1):
        st = s.get("startTime", "")
        et = s.get("endTime", "")
        date = st[:10] if st else (et[:10] if et else "")
        duration = calculate_duration_minutes(st, et)

        seg_type = "UNKNOWN"
        activity_type = None
        distance = None
        place_id = None
        place_name = None
        place_address = None
        start_lat, start_lng = None, None
        end_lat, end_lng = None, None

        if "activity" in s:
            seg_type = "ACTIVITY"
            act = s["activity"]
            distance = act.get("distanceMeters")
            top_cand = act.get("topCandidate", {})
            activity_type = top_cand.get("type", "UNKNOWN")

            if "start" in act and "latLng" in act["start"]:
                start_lat, start_lng = parse_lat_lng(act["start"]["latLng"])
            if "end" in act and "latLng" in act["end"]:
                end_lat, end_lng = parse_lat_lng(act["end"]["latLng"])

        elif "visit" in s:
            seg_type = "VISIT"
            v = s["visit"]
            top_cand = v.get("topCandidate", {})
            place_id = top_cand.get("placeId")
            place_loc = top_cand.get("placeLocation", {})
            if "latLng" in place_loc:
                start_lat, start_lng = parse_lat_lng(place_loc["latLng"])
                end_lat, end_lng = start_lat, start_lng
            place_name = top_cand.get("placeName")
            place_address = top_cand.get("placeAddress")

        elif "timelinePath" in s:
            seg_type = "PATH_ONLY"

        seg_id = i
        seg_batch.append((
            seg_id,
            date,
            st,
            et,
            seg_type,
            activity_type,
            distance,
            place_id,
            place_name,
            place_address,
            start_lat,
            start_lng,
            end_lat,
            end_lng,
            round(duration, 1),
        ))

        # timelinePath 포인트 파싱
        if "timelinePath" in s:
            for p in s["timelinePath"]:
                pt_lat, pt_lng = parse_lat_lng(p.get("point"))
                pt_time = p.get("time", "")
                if pt_lat is not None and pt_lng is not None:
                    pt_date = pt_time[:10] if pt_time else date
                    pts_batch.append(
                        (seg_id, pt_date, pt_time, pt_lat, pt_lng)
                    )
        elif start_lat is not None and start_lng is not None:
            # timelinePath가 없더라도 시작점과 끝점 등록
            pts_batch.append((seg_id, date, st, start_lat, start_lng))
            if (
                end_lat is not None
                and end_lng is not None
                and (end_lat != start_lat or end_lng != start_lng)
            ):
                pts_batch.append((seg_id, date, et, end_lat, end_lng))

        if len(seg_batch) >= 5000:
            cursor.executemany(
                """
                INSERT INTO segments (
                    id, date, start_time, end_time, seg_type, activity_type,
                    distance_meters, place_id, place_name, place_address,
                    start_lat, start_lng, end_lat, end_lng, duration_minutes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
                seg_batch,
            )
            inserted_segs += len(seg_batch)
            seg_batch.clear()

        if len(pts_batch) >= 10000:
            cursor.executemany(
                """
                INSERT INTO points (segment_id, date, time, lat, lng)
                VALUES (?, ?, ?, ?, ?)
            """,
                pts_batch,
            )
            inserted_pts += len(pts_batch)
            pts_batch.clear()

        if i % 10000 == 0:
            print(f"처리 진행률: {i}/{len(raw_segments)} ({i*100//len(raw_segments)}%)")

    if seg_batch:
        cursor.executemany(
            """
            INSERT INTO segments (
                id, date, start_time, end_time, seg_type, activity_type,
                distance_meters, place_id, place_name, place_address,
                start_lat, start_lng, end_lat, end_lng, duration_minutes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
            seg_batch,
        )
        inserted_segs += len(seg_batch)

    if pts_batch:
        cursor.executemany(
            """
            INSERT INTO points (segment_id, date, time, lat, lng)
            VALUES (?, ?, ?, ?, ?)
        """,
            pts_batch,
        )
        inserted_pts += len(pts_batch)

    conn.commit()

    # 통계 확인
    cursor.execute("SELECT COUNT(*) FROM segments")
    total_segs = cursor.fetchone()[0]
    cursor.execute("SELECT COUNT(*) FROM points")
    total_pts = cursor.fetchone()[0]
    cursor.execute("SELECT COUNT(DISTINCT date) FROM segments WHERE date != ''")
    total_dates = cursor.fetchone()[0]

    conn.close()
    elapsed = time.time() - start_ts
    return {
        "success": True,
        "segments": total_segs,
        "points": total_pts,
        "dates": total_dates,
        "elapsedSeconds": round(elapsed, 2)
    }


def main():
    if not os.path.exists(JSON_PATH):
        print(f"오류: 타임라인 JSON 파일을 찾을 수 없습니다: {JSON_PATH}")
        sys.exit(1)
    res = parse_and_import_json(JSON_PATH, DB_PATH)
    print(f"\n변환 완료! (총 {res['elapsedSeconds']}초 소요)")
    print(f"- 저장된 세그먼트 수: {res['segments']:,}건")
    print(f"- 저장된 좌표 포인트 수: {res['points']:,}건")
    print(f"- 총 기록 날짜 수: {res['dates']:,}일")


if __name__ == "__main__":
    main()
