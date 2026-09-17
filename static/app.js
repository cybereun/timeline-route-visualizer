// 타임라인 지도 시각화 앱 메인 스크립트

// -------------------------------------------------------------
// 브라우저 로컬 저장소(IndexedDB) 기반 대용량 타임라인 데이터 관리자
// -------------------------------------------------------------
const TimelineStore = {
  DB_NAME: "TimelineRouteDB",
  DB_VERSION: 1,
  _db: null,

  async getDB() {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("days")) {
          db.createObjectStore("days", { keyPath: "date" });
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta");
        }
      };
      req.onsuccess = () => {
        this._db = req.result;
        resolve(this._db);
      };
      req.onerror = () => reject(req.error);
    });
  },

  async hasData() {
    try {
      const summary = await this.getMeta("summary");
      return !!(summary && summary.totalDays > 0);
    } catch {
      return false;
    }
  },

  async getMeta(key) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readonly");
      const store = tx.objectStore("meta");
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async getSummary() {
    return await this.getMeta("summary");
  },

  async getDates(year) {
    const allDates = (await this.getMeta("dates")) || [];
    const years = (await this.getMeta("years")) || [];
    if (!year) return { years, dates: allDates };
    const filtered = allDates.filter((d) => d.date.startsWith(`${year}-`));
    return { years, dates: filtered };
  },

  async getDay(date) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("days", "readonly");
      const store = tx.objectStore("days");
      const req = store.get(date);
      req.onsuccess = () => {
        const res = req.result;
        if (!res) {
          resolve({ date, segments: [], totalPoints: 0 });
        } else {
          resolve({
            date: res.date,
            segments: res.segments || [],
            totalPoints: res.totalPoints || 0,
          });
        }
      };
      req.onerror = () => reject(req.error);
    });
  },

  async getHeatmap(year, month) {
    const heatPoints = (await this.getMeta("heatPoints")) || [];
    let filtered = heatPoints;
    if (year && year !== "all") {
      filtered = filtered.filter((p) => p[2] === String(year));
    }
    if (month && month !== "all") {
      const mStr = String(month).padStart(2, "0");
      filtered = filtered.filter((p) => p[3] === mStr);
    }
    const points = filtered.slice(0, 25000).map((p) => [p[0], p[1], 0.7]);
    return { count: points.length, points };
  },

  async clearAll() {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["days", "meta"], "readwrite");
      tx.objectStore("days").clear();
      tx.objectStore("meta").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async parseAndImport(file, onProgress) {
    if (onProgress) {
      onProgress({
        percent: 15,
        text: `파일 읽는 중 (${(file.size / (1024 * 1024)).toFixed(1)} MB)...`,
      });
    }
    const text = await file.text();

    if (onProgress) {
      onProgress({ percent: 35, text: "JSON 파싱 중..." });
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error("올바른 JSON 파일 형식이 아닙니다: " + e.message);
    }

    const rawSegments = data.semanticSegments || (Array.isArray(data) ? data : []);
    if (!rawSegments || rawSegments.length === 0) {
      throw new Error("타임라인 동선 데이터(semanticSegments)를 찾을 수 없습니다.");
    }

    if (onProgress) {
      onProgress({
        percent: 55,
        text: `${rawSegments.length.toLocaleString()}개 동선 구간 분석 중...`,
      });
    }

    const coordRegex = /([+-]?\d+\.?\d*)\s*°?\s*,\s*([+-]?\d+\.?\d*)\s*°?/;
    function parseLatLng(strOrObj) {
      if (!strOrObj) return null;
      if (typeof strOrObj === "object") {
        if (strOrObj.lat !== undefined && strOrObj.lng !== undefined)
          return [Number(strOrObj.lat), Number(strOrObj.lng)];
        if (strOrObj.latitude !== undefined && strOrObj.longitude !== undefined)
          return [Number(strOrObj.latitude), Number(strOrObj.longitude)];
        if (strOrObj.latitudeE7 !== undefined && strOrObj.longitudeE7 !== undefined)
          return [strOrObj.latitudeE7 / 1e7, strOrObj.longitudeE7 / 1e7];
        if (strOrObj.latLng) return parseLatLng(strOrObj.latLng);
        return null;
      }
      const m = coordRegex.exec(String(strOrObj));
      if (m) {
        const lat = parseFloat(m[1]);
        const lng = parseFloat(m[2]);
        if (!isNaN(lat) && !isNaN(lng))
          return [Math.round(lat * 100000) / 100000, Math.round(lng * 100000) / 100000];
      }
      return null;
    }

    const dayMap = {};
    const activitiesMap = {};
    let totalPoints = 0;
    let totalDist = 0;
    let totalVisits = 0;
    let totalSegments = 0;
    const heatPoints = [];

    for (let i = 0; i < rawSegments.length; i++) {
      const s = rawSegments[i];
      const st = s.startTime || "";
      const et = s.endTime || "";
      const date = st.slice(0, 10) || et.slice(0, 10);
      if (!date) continue;
      totalSegments++;

      let duration = 0;
      if (st && et) {
        const diffMs = new Date(et) - new Date(st);
        if (!isNaN(diffMs) && diffMs > 0) duration = diffMs / 60000;
      }

      let segType = "UNKNOWN";
      let activityType = null;
      let distanceMeters = null;
      let placeId = null;
      let placeName = null;
      let placeAddress = null;
      let startLat = null,
        startLng = null;
      let endLat = null,
        endLng = null;

      if (s.activity) {
        segType = "ACTIVITY";
        const act = s.activity;
        distanceMeters = act.distanceMeters || null;
        const topCand = act.topCandidate || {};
        activityType = topCand.type || "UNKNOWN";

        if (act.start && act.start.latLng) {
          const p = parseLatLng(act.start.latLng);
          if (p) [startLat, startLng] = p;
        }
        if (act.end && act.end.latLng) {
          const p = parseLatLng(act.end.latLng);
          if (p) [endLat, endLng] = p;
        }

        if (distanceMeters) totalDist += distanceMeters;
        if (!activitiesMap[activityType])
          activitiesMap[activityType] = { count: 0, dist: 0 };
        activitiesMap[activityType].count++;
        activitiesMap[activityType].dist += distanceMeters || 0;
      } else if (s.visit) {
        segType = "VISIT";
        totalVisits++;
        const v = s.visit;
        const topCand = v.topCandidate || {};
        placeId = topCand.placeId || null;
        placeName = topCand.placeName || null;
        placeAddress = topCand.placeAddress || null;
        if (topCand.placeLocation && topCand.placeLocation.latLng) {
          const p = parseLatLng(topCand.placeLocation.latLng);
          if (p) {
            startLat = p[0];
            startLng = p[1];
            endLat = p[0];
            endLng = p[1];
          }
        }
      } else if (s.timelinePath) {
        segType = "PATH_ONLY";
      }

      const pointList = [];
      if (s.timelinePath && Array.isArray(s.timelinePath)) {
        for (const p of s.timelinePath) {
          const pt = parseLatLng(p.point);
          if (pt) {
            pointList.push([pt[0], pt[1], p.time || st]);
            totalPoints++;
            if (totalPoints % 5 === 0) {
              heatPoints.push([pt[0], pt[1], date.slice(0, 4), date.slice(5, 7)]);
            }
          }
        }
      } else if (startLat !== null && startLng !== null) {
        pointList.push([startLat, startLng, st]);
        totalPoints++;
        if (
          endLat !== null &&
          endLng !== null &&
          (endLat !== startLat || endLng !== startLng)
        ) {
          pointList.push([endLat, endLng, et]);
          totalPoints++;
        }
        if (totalPoints % 5 === 0) {
          heatPoints.push([startLat, startLng, date.slice(0, 4), date.slice(5, 7)]);
        }
      }

      const segObj = {
        id: i + 1,
        date,
        startTime: st,
        endTime: et,
        type: segType,
        activityType,
        distanceMeters,
        placeId,
        placeName,
        placeAddress,
        startLat,
        startLng,
        endLat,
        endLng,
        durationMinutes: Math.round(duration * 10) / 10,
        points: pointList,
      };

      if (!dayMap[date]) {
        dayMap[date] = { date, segments: [], totalPoints: 0, totalDist: 0 };
      }
      dayMap[date].segments.push(segObj);
      dayMap[date].totalPoints += pointList.length;
      if (distanceMeters) dayMap[date].totalDist += distanceMeters;
    }

    const datesArr = Object.keys(dayMap).sort();
    const datesList = datesArr.map((d) => ({
      date: d,
      count: dayMap[d].segments.length,
      dist: Math.round((dayMap[d].totalDist / 1000) * 100) / 100,
    }));

    const yearsSet = new Set(datesArr.map((d) => d.slice(0, 4)));
    const yearsList = Array.from(yearsSet).sort().reverse();

    const activities = Object.keys(activitiesMap)
      .map((k) => ({
        type: k,
        count: activitiesMap[k].count,
        distanceKm: Math.round((activitiesMap[k].dist / 1000) * 10) / 10,
      }))
      .sort((a, b) => b.count - a.count);

    const summary = {
      totalDays: datesArr.length,
      totalSegments,
      totalPoints,
      totalDistanceKm: Math.round((totalDist / 1000) * 10) / 10,
      totalVisits,
      startDate: datesArr[0] || "",
      endDate: datesArr[datesArr.length - 1] || "",
      activities,
    };

    if (onProgress) {
      onProgress({
        percent: 75,
        text: "브라우저 로컬 저장소(IndexedDB)에 저장 중...",
      });
    }

    const db = await this.getDB();
    await this.clearAll();

    // 일자별 배치 저장
    const daysKeys = Object.keys(dayMap);
    const batchSize = 500;
    for (let i = 0; i < daysKeys.length; i += batchSize) {
      const slice = daysKeys.slice(i, i + batchSize);
      await new Promise((resolve, reject) => {
        const tx = db.transaction("days", "readwrite");
        const store = tx.objectStore("days");
        for (const k of slice) {
          store.put(dayMap[k]);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      const pct = 75 + Math.round(((i + slice.length) / daysKeys.length) * 20);
      if (onProgress) {
        onProgress({
          percent: pct,
          text: `로컬 저장소 저장 중... (${Math.min(i + slice.length, daysKeys.length)}/${daysKeys.length}일)`,
        });
      }
    }

    // 메타데이터 저장
    await new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite");
      const store = tx.objectStore("meta");
      store.put(summary, "summary");
      store.put(datesList, "dates");
      store.put(yearsList, "years");
      store.put(heatPoints, "heatPoints");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    if (onProgress) {
      onProgress({ percent: 100, text: "완료!" });
    }

    return {
      success: true,
      stats: {
        dates: datesArr.length,
        points: totalPoints,
        segments: totalSegments,
        distanceKm: summary.totalDistanceKm,
      },
    };
  },
};

document.addEventListener("DOMContentLoaded", () => {
  // 상태 변수
  let map = null;
  let currentTileLayer = null;
  let dayRouteGroup = L.featureGroup();
  let dayMarkerGroup = L.featureGroup();
  let heatLayer = null;
  let playbackMarker = null;

  let currentYearDates = [];
  let allYears = [];
  let currentDate = null;
  let dayData = null;
  let dayAllPoints = []; // 시간순 정렬된 전체 포인트

  // 재생 상태
  let isPlaying = false;
  let playIndex = 0;
  let playTimer = null;
  let playbackSpeed = 3;

  // 활동 유형별 색상 및 한글명 매핑
  const activityConfig = {
    WALKING: { color: "#10b981", name: "도보", icon: "fa-person-walking" },
    IN_PASSENGER_VEHICLE: { color: "#f97316", name: "차량", icon: "fa-car" },
    IN_BUS: { color: "#f59e0b", name: "버스", icon: "fa-bus" },
    IN_SUBWAY: { color: "#06b6d4", name: "지하철", icon: "fa-train-subway" },
    IN_TRAIN: { color: "#8b5cf6", name: "기차", icon: "fa-train" },
    CYCLING: { color: "#14b8a6", name: "자전거", icon: "fa-bicycle" },
    FLYING: { color: "#ec4899", name: "비행기", icon: "fa-plane" },
    SKIING: { color: "#38bdf8", name: "스키", icon: "fa-person-skiing" },
    IN_FERRY: { color: "#0284c7", name: "페리/배", icon: "fa-ship" },
    UNKNOWN_ACTIVITY_TYPE: { color: "#64748b", name: "이동", icon: "fa-route" },
    UNKNOWN: { color: "#64748b", name: "이동", icon: "fa-route" },
    VISIT: { color: "#ef4444", name: "방문 장소", icon: "fa-location-dot" },
    PATH_ONLY: { color: "#64748b", name: "경로", icon: "fa-route" },
  };

  // 1. 지도 초기화
  function initMap() {
    map = L.map("map", {
      center: [35.85, 128.63], // 대구 기본 중심점
      zoom: 12,
      zoomControl: false,
    });

    L.control.zoom({ position: "bottomright" }).addTo(map);

    // 타일 레이어 설정
    const tileLayers = {
      osm: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}", {
        attribution: "© Esri",
        // Esri serves placeholder tiles above level 13 in Korean coverage.
        maxNativeZoom: 13,
        maxZoom: 19,
      }),
      "carto-dark": L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
        {
          attribution: "© Esri",
          maxZoom: 16,
        }
      ),
      satellite: L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        {
          attribution: "© Esri",
          maxZoom: 18,
        }
      ),
    };

    currentTileLayer = tileLayers["carto-dark"].addTo(map);

    // 타일 변경 이벤트
    document.querySelectorAll(".tile-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        document.querySelectorAll(".tile-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const tileKey = btn.dataset.tile;
        if (currentTileLayer) map.removeLayer(currentTileLayer);
        currentTileLayer = tileLayers[tileKey].addTo(map);
      });
    });

    map.addLayer(dayRouteGroup);
    map.addLayer(dayMarkerGroup);

    document.getElementById("fitBoundsBtn").addEventListener("click", fitToDayBounds);
  }

  // 2. 전체 통계 및 초기 날짜 목록 로드
  async function loadInitialData() {
    try {
      let summary = null;
      let datesData = null;

      if (await TimelineStore.hasData()) {
        summary = await TimelineStore.getSummary();
        datesData = await TimelineStore.getDates();
      } else {
        try {
          const summaryRes = await fetch("/api/summary");
          if (summaryRes.ok) summary = await summaryRes.json();
          const datesRes = await fetch("/api/dates");
          if (datesRes.ok) datesData = await datesRes.json();
        } catch (e) {
          console.log("서버 API 조회 건너뜀 (클라이언트 모드):", e);
        }
      }

      const clearDataBtn = document.getElementById("clearDataBtn");
      if (clearDataBtn) {
        clearDataBtn.style.display = (await TimelineStore.hasData()) ? "inline-flex" : "none";
      }

      if (!summary || !summary.totalDays) {
        document.getElementById("dataRangeBadge").innerText = "데이터 없음 (불러오기 필요)";
        document.getElementById("statTotalDays").innerText = "0일";
        document.getElementById("statTotalDistance").innerText = "0 km";
        document.getElementById("statTotalVisits").innerText = "0회";
        document.getElementById("statTotalPoints").innerText = "0개";
        document.getElementById("timelineList").innerHTML = `
          <div class="empty-state" style="padding: 24px 16px;">
            <i class="fa-solid fa-cloud-arrow-up" style="font-size: 2.2rem; color: #e90064; margin-bottom: 12px; display: block;"></i>
            <b style="font-size: 1rem; color: #f1f5f9;">타임라인 데이터가 없습니다</b><br>
            <span style="font-size: 0.82rem; color: #94a3b8; display: inline-block; margin-top: 6px;">
              상단 <strong>[불러오기]</strong> 버튼을 누르거나<br>
              <code>타임라인.json</code> 파일을 화면에 끌어다 놓으세요.
            </span>
          </div>
        `;
        return;
      }

      document.getElementById("dataRangeBadge").innerText =
        `${summary.startDate || ""} ~ ${summary.endDate || ""}`;

      document.getElementById("statTotalDays").innerText = `${summary.totalDays.toLocaleString()}일`;
      document.getElementById("statTotalDistance").innerText = `${summary.totalDistanceKm.toLocaleString()} km`;
      document.getElementById("statTotalVisits").innerText = `${summary.totalVisits.toLocaleString()}회`;
      document.getElementById("statTotalPoints").innerText = `${summary.totalPoints.toLocaleString()}개`;

      // 통계 활동 리스트
      const statsList = document.getElementById("activityStatsList");
      statsList.innerHTML = "";
      (summary.activities || []).forEach((act) => {
        const conf = activityConfig[act.type] || activityConfig.UNKNOWN;
        const row = document.createElement("div");
        row.className = "activity-stat-row";
        row.innerHTML = `
          <span><i class="fa-solid ${conf.icon}" style="color:${conf.color}"></i> ${conf.name}</span>
          <span><b>${act.count.toLocaleString()}건</b> (${act.distanceKm.toLocaleString()} km)</span>
        `;
        statsList.appendChild(row);
      });

      // 날짜 목록 로드
      allYears = datesData && datesData.years ? datesData.years : [];

      // 연도 셀렉트 채우기
      const yearSelect = document.getElementById("yearSelect");
      const heatYearSelect = document.getElementById("heatYearSelect");
      const videoYearSelect = document.getElementById("videoYearSelect");
      const videoStartYearSelect = document.getElementById("videoStartYearSelect");
      const videoEndYearSelect = document.getElementById("videoEndYearSelect");

      yearSelect.innerHTML = "";
      if (videoYearSelect) videoYearSelect.innerHTML = "";
      if (videoStartYearSelect) videoStartYearSelect.innerHTML = "";
      if (videoEndYearSelect) videoEndYearSelect.innerHTML = "";
      
      allYears.forEach((y) => {
        const opt = document.createElement("option");
        opt.value = y;
        opt.innerText = `${y}년`;
        yearSelect.appendChild(opt);

        const heatOpt = document.createElement("option");
        heatOpt.value = y;
        heatOpt.innerText = `${y}년`;
        heatYearSelect.appendChild(heatOpt);

        if (videoYearSelect) {
          const vyOpt = document.createElement("option");
          vyOpt.value = y;
          vyOpt.innerText = `${y}년`;
          videoYearSelect.appendChild(vyOpt);
        }

        if (videoStartYearSelect) {
          const vsOpt = document.createElement("option");
          vsOpt.value = y;
          vsOpt.innerText = `${y}년`;
          videoStartYearSelect.appendChild(vsOpt);
        }

        if (videoEndYearSelect) {
          const veOpt = document.createElement("option");
          veOpt.value = y;
          veOpt.innerText = `${y}년`;
          videoEndYearSelect.appendChild(veOpt);
        }
      });

      // 연도 범위 기본값 설정 (예: 2020 ~ 2025 또는 데이터 범위)
      if (videoStartYearSelect && videoEndYearSelect && allYears.length > 0) {
        const sortedAsc = [...allYears].sort((a, b) => a - b);
        const defStart = sortedAsc.includes(2020) ? 2020 : sortedAsc[0];
        const defEnd = sortedAsc.includes(2025) ? 2025 : sortedAsc[sortedAsc.length - 1];
        videoStartYearSelect.value = defStart;
        videoEndYearSelect.value = defEnd;
      }

      yearSelect.addEventListener("change", (e) => {
        onYearChange(e.target.value);
      });

      if (allYears.length > 0) {
        yearSelect.value = allYears[0];
        await onYearChange(allYears[0]);
      }
    } catch (err) {
      console.error("초기 데이터 로딩 오류:", err);
      document.getElementById("dataRangeBadge").innerText = "데이터 로딩 실패";
    }
  }

  // 3. 연도 변경 시 날짜 갱신
  async function onYearChange(year) {
    try {
      let data = null;
      if (await TimelineStore.hasData()) {
        data = await TimelineStore.getDates(year);
      } else {
        const res = await fetch(`/api/dates?year=${year}`);
        data = await res.json();
      }
      currentYearDates = (data.dates || []).map((d) => d.date);

      if (currentYearDates.length > 0) {
        // 해당 연도의 가장 최근 날짜 또는 첫 번째 날짜 선택
        const targetDate = currentYearDates[currentYearDates.length - 1];
        setDay(targetDate);
      } else {
        document.getElementById("timelineList").innerHTML =
          '<div class="empty-state">해당 연도에 기록된 동선이 없습니다.</div>';
      }
    } catch (err) {
      console.error("연도별 날짜 로딩 오류:", err);
    }
  }

  // 4. 날짜 변경 및 해당 날짜 데이터 로드
  async function setDay(dateStr) {
    if (!dateStr) return;
    currentDate = dateStr;
    document.getElementById("dateInput").value = dateStr;
    document.getElementById("currentDateTitle").innerText = `${formatDateKorean(dateStr)} 동선`;

    resetPlayback();

    try {
      if (await TimelineStore.hasData()) {
        dayData = await TimelineStore.getDay(dateStr);
      } else {
        const res = await fetch(`/api/day?date=${dateStr}`);
        dayData = await res.json();
      }

      renderDayOnMap(dayData);
      renderDaySummary(dayData);
      renderTimelineList(dayData);
    } catch (err) {
      console.error("일별 데이터 로딩 오류:", err);
    }
  }

  // 5. 일별 동선 지도 렌더링
  function renderDayOnMap(data) {
    dayRouteGroup.clearLayers();
    dayMarkerGroup.clearLayers();
    dayAllPoints = [];

    if (!data.segments || data.segments.length === 0) {
      return;
    }

    let latLngBounds = [];

    data.segments.forEach((seg, idx) => {
      const isVisit = seg.type === "VISIT";
      const actType = seg.activityType || (isVisit ? "VISIT" : seg.type);
      const conf = activityConfig[actType] || activityConfig.UNKNOWN;

      // 1) 세부 이동 경로 폴리라인
      if (seg.points && seg.points.length > 0) {
        const polyCoords = seg.points.map((p) => {
          dayAllPoints.push({ lat: p[0], lng: p[1], time: p[2], segIdx: idx });
          return [p[0], p[1]];
        });

        if (polyCoords.length > 1) {
          const polyline = L.polyline(polyCoords, {
            color: conf.color,
            weight: 5,
            opacity: 0.85,
            lineJoin: "round",
          });

          // 툴팁
          const startTime = seg.startTime ? seg.startTime.substr(11, 8) : "";
          const endTime = seg.endTime ? seg.endTime.substr(11, 8) : "";
          const distKm = seg.distanceMeters ? (seg.distanceMeters / 1000).toFixed(2) : 0;
          polyline.bindTooltip(
            `<b>${conf.name}</b> (${startTime} ~ ${endTime})<br>이동거리: ${distKm} km`,
            { sticky: true }
          );

          polyline.on("click", () => highlightSegment(idx));
          dayRouteGroup.addLayer(polyline);
        }

        polyCoords.forEach((c) => latLngBounds.push(c));
      }

      // 2) 방문지 마커
      if (isVisit && seg.startLat && seg.startLng) {
        const lat = seg.startLat;
        const lng = seg.startLng;
        latLngBounds.push([lat, lng]);

        const startTime = seg.startTime ? seg.startTime.substr(11, 5) : "";
        const endTime = seg.endTime ? seg.endTime.substr(11, 5) : "";
        const placeName = seg.placeName || seg.placeAddress || "방문 장소";
        const stayDuration = seg.durationMinutes ? `${Math.round(seg.durationMinutes)}분 체류` : "";

        const iconHtml = `
          <div class="visit-custom-pin" title="${placeName}">
            <i class="fa-solid fa-location-dot"></i>
          </div>
        `;
        const customIcon = L.divIcon({
          html: iconHtml,
          className: "",
          iconSize: [28, 28],
          iconAnchor: [14, 28],
        });

        const marker = L.marker([lat, lng], { icon: customIcon });
        marker.bindPopup(`
          <div style="font-size:13px; line-height:1.4;">
            <b style="color:#ef4444; font-size:14px;"><i class="fa-solid fa-location-dot"></i> ${placeName}</b><br>
            <span style="color:#64748b;">시간: ${startTime} ~ ${endTime} (${stayDuration})</span>
            ${seg.placeAddress ? `<br><span style="color:#94a3b8; font-size:11px;">${seg.placeAddress}</span>` : ""}
          </div>
        `);
        marker.on("click", () => highlightSegment(idx));
        dayMarkerGroup.addLayer(marker);
      }
    });

    // 포인트 시간순 정렬
    dayAllPoints.sort((a, b) => (a.time || "").localeCompare(b.time || ""));

    // 슬라이더 범위 설정
    const slider = document.getElementById("timelineSlider");
    slider.max = Math.max(0, dayAllPoints.length - 1);
    slider.value = 0;
    if (dayAllPoints.length > 0) {
      document.getElementById("currentTimeLabel").innerText = (dayAllPoints[0].time || "").substr(11, 8);
    }

    // 영역 맞춤
    if (latLngBounds.length > 0) {
      map.fitBounds(latLngBounds, { padding: [40, 40], maxZoom: 16 });
    }
  }

  // 6. 일별 요약 통계 렌더링
  function renderDaySummary(data) {
    let totalDistMeters = 0;
    let visitCount = 0;

    (data.segments || []).forEach((s) => {
      if (s.distanceMeters) totalDistMeters += s.distanceMeters;
      if (s.type === "VISIT") visitCount++;
    });

    document.getElementById("summaryDistance").innerText = `${(totalDistMeters / 1000).toFixed(1)} km`;
    document.getElementById("summaryVisits").innerText = `${visitCount} 곳`;
    document.getElementById("summarySegments").innerText = `${(data.segments || []).length} 개`;
    document.getElementById("summaryPoints").innerText = `${(data.totalPoints || 0).toLocaleString()} 개`;
  }

  // 7. 타임라인 상세 리스트 렌더링
  function renderTimelineList(data) {
    const listEl = document.getElementById("timelineList");
    listEl.innerHTML = "";

    if (!data.segments || data.segments.length === 0) {
      listEl.innerHTML = '<div class="empty-state">이 날짜에는 기록된 동선이 없습니다.</div>';
      return;
    }

    data.segments.forEach((seg, idx) => {
      const isVisit = seg.type === "VISIT";
      const actType = seg.activityType || (isVisit ? "VISIT" : seg.type);
      const conf = activityConfig[actType] || activityConfig.UNKNOWN;

      const startTime = seg.startTime ? seg.startTime.substr(11, 5) : "--:--";
      const endTime = seg.endTime ? seg.endTime.substr(11, 5) : "--:--";

      let title = conf.name;
      let desc = "";

      if (isVisit) {
        title = seg.placeName || "체류 장소";
        desc = `${Math.round(seg.durationMinutes || 0)}분 머무름`;
        if (seg.placeAddress) desc += ` · ${seg.placeAddress}`;
      } else {
        const distKm = seg.distanceMeters ? (seg.distanceMeters / 1000).toFixed(1) : 0;
        desc = `${distKm} km 이동 (${Math.round(seg.durationMinutes || 0)}분 소요)`;
      }

      const item = document.createElement("div");
      item.className = "timeline-item";
      item.dataset.segIdx = idx;
      item.innerHTML = `
        <div class="timeline-item-icon" style="background-color:${conf.color}">
          <i class="fa-solid ${conf.icon}"></i>
        </div>
        <div class="timeline-item-content">
          <div class="timeline-item-title">${title}</div>
          <div class="timeline-item-desc">${desc}</div>
        </div>
        <div class="timeline-item-time">${startTime}<br>${endTime}</div>
      `;

      item.addEventListener("click", () => {
        highlightSegment(idx);
        focusSegment(seg);
      });

      listEl.appendChild(item);
    });
  }

  // 특정 세그먼트 하이라이트 및 이동
  function highlightSegment(segIdx) {
    document.querySelectorAll(".timeline-item").forEach((el) => {
      el.classList.toggle("active", parseInt(el.dataset.segIdx) === segIdx);
    });
  }

  function focusSegment(seg) {
    if (seg.startLat && seg.startLng) {
      map.flyTo([seg.startLat, seg.startLng], 15, { duration: 1.0 });
    } else if (seg.points && seg.points.length > 0) {
      map.flyTo([seg.points[0][0], seg.points[0][1]], 15, { duration: 1.0 });
    }
  }

  function fitToDayBounds() {
    if (dayRouteGroup.getLayers().length > 0 || dayMarkerGroup.getLayers().length > 0) {
      const group = L.featureGroup([dayRouteGroup, dayMarkerGroup]);
      map.fitBounds(group.getBounds(), { padding: [40, 40] });
    }
  }

  // 8. 동선 애니메이션 플레이어 기능
  function togglePlayback() {
    if (isPlaying) {
      pausePlayback();
    } else {
      startPlayback();
    }
  }

  function startPlayback() {
    if (dayAllPoints.length === 0) return;
    isPlaying = true;
    const playBtn = document.getElementById("playBtn");
    playBtn.innerHTML = '<i class="fa-solid fa-pause"></i> 일시정지';
    playBtn.classList.remove("btn-primary");
    playBtn.classList.add("btn-secondary");

    if (playIndex >= dayAllPoints.length - 1) {
      playIndex = 0;
    }

    runPlayStep();
  }

  function pausePlayback() {
    isPlaying = false;
    clearTimeout(playTimer);
    const playBtn = document.getElementById("playBtn");
    playBtn.innerHTML = '<i class="fa-solid fa-play"></i> 재생';
    playBtn.classList.add("btn-primary");
    playBtn.classList.remove("btn-secondary");
  }

  function resetPlayback() {
    pausePlayback();
    playIndex = 0;
    document.getElementById("timelineSlider").value = 0;
    if (playbackMarker) {
      map.removeLayer(playbackMarker);
      playbackMarker = null;
    }
    if (dayAllPoints.length > 0) {
      document.getElementById("currentTimeLabel").innerText = (dayAllPoints[0].time || "").substr(11, 8);
    }
  }

  function runPlayStep() {
    if (!isPlaying) return;
    if (playIndex >= dayAllPoints.length) {
      pausePlayback();
      return;
    }

    const pt = dayAllPoints[playIndex];
    updatePlaybackPosition(pt);

    document.getElementById("timelineSlider").value = playIndex;
    document.getElementById("currentTimeLabel").innerText = (pt.time || "").substr(11, 8);

    if (pt.segIdx !== undefined) {
      highlightSegment(pt.segIdx);
    }

    playIndex++;
    // 속도에 따른 딜레이 계산
    const delay = Math.max(30, 200 / playbackSpeed);
    playTimer = setTimeout(runPlayStep, delay);
  }

  function updatePlaybackPosition(pt) {
    const latLng = [pt.lat, pt.lng];
    if (!playbackMarker) {
      const pulseIcon = L.divIcon({
        className: "pulse-marker",
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });
      playbackMarker = L.marker(latLng, { icon: pulseIcon }).addTo(map);
    } else {
      playbackMarker.setLatLng(latLng);
    }
    map.panTo(latLng, { animate: true, duration: 0.2 });
  }

  // 슬라이더 이벤트
  document.getElementById("timelineSlider").addEventListener("input", (e) => {
    pausePlayback();
    playIndex = parseInt(e.target.value);
    if (dayAllPoints[playIndex]) {
      const pt = dayAllPoints[playIndex];
      updatePlaybackPosition(pt);
      document.getElementById("currentTimeLabel").innerText = (pt.time || "").substr(11, 8);
      if (pt.segIdx !== undefined) highlightSegment(pt.segIdx);
    }
  });

  document.getElementById("playBtn").addEventListener("click", togglePlayback);
  document.getElementById("resetPlayBtn").addEventListener("click", resetPlayback);
  document.getElementById("playbackSpeed").addEventListener("change", (e) => {
    playbackSpeed = parseInt(e.target.value);
  });

  // 날짜 피커 변경
  document.getElementById("dateInput").addEventListener("change", (e) => {
    setDay(e.target.value);
  });

  // 이전/다음 날짜 버튼
  document.getElementById("prevDayBtn").addEventListener("click", () => {
    if (!currentDate) return;
    const idx = currentYearDates.indexOf(currentDate);
    if (idx > 0) {
      setDay(currentYearDates[idx - 1]);
    } else {
      // 이전 연도 탐색
      const yIdx = allYears.indexOf(currentDate.substr(0, 4));
      if (yIdx < allYears.length - 1) {
        const prevYear = allYears[yIdx + 1];
        document.getElementById("yearSelect").value = prevYear;
        onYearChange(prevYear);
      }
    }
  });

  document.getElementById("nextDayBtn").addEventListener("click", () => {
    if (!currentDate) return;
    const idx = currentYearDates.indexOf(currentDate);
    if (idx >= 0 && idx < currentYearDates.length - 1) {
      setDay(currentYearDates[idx + 1]);
    } else {
      // 다음 연도 탐색
      const yIdx = allYears.indexOf(currentDate.substr(0, 4));
      if (yIdx > 0) {
        const nextYear = allYears[yIdx - 1];
        document.getElementById("yearSelect").value = nextYear;
        onYearChange(nextYear);
      }
    }
  });

  // 9. 히트맵 기능
  async function loadHeatmap() {
    const year = document.getElementById("heatYearSelect").value;
    const month = document.getElementById("heatMonthSelect").value;

    document.getElementById("heatPointCount").innerText = "포인트 로딩 중...";

    try {
      let data = null;
      if (await TimelineStore.hasData()) {
        data = await TimelineStore.getHeatmap(year, month);
      } else {
        let url = `/api/heatmap?year=${year}`;
        if (month !== "all") url += `&month=${month}`;
        const res = await fetch(url);
        data = await res.json();
      }

      if (heatLayer) {
        map.removeLayer(heatLayer);
      }

      if (data.points && data.points.length > 0) {
        heatLayer = L.heatLayer(data.points, {
          radius: 20,
          blur: 15,
          maxZoom: 15,
          gradient: { 0.2: "#3b82f6", 0.5: "#10b981", 0.7: "#f59e0b", 1.0: "#ef4444" },
        }).addTo(map);

        document.getElementById("heatPointCount").innerText = `표시된 포인트: ${data.count.toLocaleString()}개`;

        // 첫 번째 포인트로 이동
        map.setView([data.points[0][0], data.points[0][1]], 12);
      } else {
        document.getElementById("heatPointCount").innerText = "표시할 포인트가 없습니다.";
      }
    } catch (err) {
      console.error("히트맵 로딩 실패:", err);
      document.getElementById("heatPointCount").innerText = "히트맵 로딩 오류";
    }
  }

  document.getElementById("applyHeatmapBtn").addEventListener("click", loadHeatmap);

  // 10. 탭 전환 처리
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));

      btn.classList.add("active");
      const tabId = `tab-${btn.dataset.tab}`;
      document.getElementById(tabId).classList.add("active");

      // 레이어 표시/숨김 제어
      if (btn.dataset.tab === "daily") {
        if (heatLayer && map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
        map.addLayer(dayRouteGroup);
        map.addLayer(dayMarkerGroup);
        fitToDayBounds();
      } else if (btn.dataset.tab === "heatmap") {
        resetPlayback();
        if (map.hasLayer(dayRouteGroup)) map.removeLayer(dayRouteGroup);
        if (map.hasLayer(dayMarkerGroup)) map.removeLayer(dayMarkerGroup);
        if (heatLayer && !map.hasLayer(heatLayer)) map.addLayer(heatLayer);
        else loadHeatmap();
      } else if (btn.dataset.tab === "video") {
        resetPlayback();
        loadRecentVideos();
      }
    });
  });

  // 11. 세로 영상 제작 (Reels / Shorts) 기능
  let currentBrowserVideo = null;

  // 기간 설정 모드 탭 제어 (단일 연도 / 연도 범위 / 상세 날짜)
  const videoSingleYearRow = document.getElementById("videoSingleYearRow");
  const videoYearRangeRow = document.getElementById("videoYearRangeRow");
  const videoCustomDateRow = document.getElementById("videoCustomDateRow");
  const videoTitleInput = document.getElementById("videoTitleInput");

  document.querySelectorAll("#videoModeGroup .pill-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#videoModeGroup .pill-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const mode = btn.dataset.mode;

      videoSingleYearRow.style.display = "none";
      videoYearRangeRow.style.display = "none";
      videoCustomDateRow.style.display = "none";

      if (mode === "preset") {
        videoSingleYearRow.style.display = "block";
        const y = document.getElementById("videoYearSelect").value || "2026";
        videoTitleInput.value = `${y}년 대한민국 여행 동선`;
      } else if (mode === "year_range") {
        videoYearRangeRow.style.display = "block";
        const sy = document.getElementById("videoStartYearSelect").value || "2020";
        const ey = document.getElementById("videoEndYearSelect").value || "2025";
        videoTitleInput.value = `${sy}~${ey}년 여행 동선`;
      } else if (mode === "custom_date") {
        videoCustomDateRow.style.display = "block";
        videoTitleInput.value = "나의 여행 동선";
      }
    });
  });

  // 연도 선택 변경 시 제목 자동 업데이트
  document.getElementById("videoYearSelect").addEventListener("change", (e) => {
    videoTitleInput.value = `${e.target.value}년 대한민국 여행 동선`;
  });

  document.getElementById("videoStartYearSelect").addEventListener("change", () => {
    const sy = document.getElementById("videoStartYearSelect").value;
    const ey = document.getElementById("videoEndYearSelect").value;
    videoTitleInput.value = `${sy}~${ey}년 여행 동선`;
  });

  document.getElementById("videoEndYearSelect").addEventListener("change", () => {
    const sy = document.getElementById("videoStartYearSelect").value;
    const ey = document.getElementById("videoEndYearSelect").value;
    videoTitleInput.value = `${sy}~${ey}년 여행 동선`;
  });

  async function loadSelectedVideoDays(payload, onProgress) {
    const usesLocalData = await TimelineStore.hasData();
    let dateData;
    if (usesLocalData) {
      dateData = await TimelineStore.getDates();
    } else {
      const response = await fetch("/api/dates");
      if (!response.ok) throw new Error("타임라인 날짜 목록을 불러오지 못했습니다.");
      dateData = await response.json();
      if (dateData.error) throw new Error(dateData.error);
    }

    const startDate = payload.start_date || `${payload.year}-01-01`;
    const endDate = payload.end_date || `${payload.year}-12-31`;
    const dates = (dateData.dates || [])
      .map((entry) => entry.date)
      .filter((date) => date >= startDate && date <= endDate);
    if (!dates.length) throw new Error("선택한 기간의 타임라인 기록이 없습니다. 먼저 타임라인 JSON을 불러와 주세요.");

    const days = [];
    const batchSize = 8;
    for (let index = 0; index < dates.length; index += batchSize) {
      const batch = dates.slice(index, index + batchSize);
      const loaded = await Promise.all(batch.map(async (date) => {
        if (usesLocalData) return TimelineStore.getDay(date);
        const response = await fetch(`/api/day?date=${encodeURIComponent(date)}`);
        if (!response.ok) throw new Error(`${date} 경로 데이터를 불러오지 못했습니다.`);
        const day = await response.json();
        if (day.error) throw new Error(day.error);
        return day;
      }));
      days.push(...loaded);
      onProgress(5 + Math.round(((index + batch.length) / dates.length) * 20), `경로 데이터를 읽는 중 (${index + batch.length}/${dates.length}일)`);
    }
    return days;
  }

  // 브라우저에서 경로를 그리고 MediaRecorder로 영상을 인코딩합니다.
  document.getElementById("startRenderBtn").addEventListener("click", async () => {
    const activeModeBtn = document.querySelector("#videoModeGroup .pill-btn.active");
    const mode = activeModeBtn ? activeModeBtn.dataset.mode : "preset";
    const camera = document.getElementById("videoCameraSelect").value;
    const title = videoTitleInput.value.trim() || "나의 여행 동선";
    const duration = parseInt(document.getElementById("videoDurationSelect").value) || 20;
    const resolution = document.getElementById("videoResSelect").value;

    const payload = {
      camera,
      title,
      duration,
      resolution,
      aspect: "portrait", // 9:16 세로
      fps: "30",
    };

    if (mode === "preset") {
      const year = document.getElementById("videoYearSelect").value;
      payload.year = parseInt(year);
    } else if (mode === "year_range") {
      const startYear = parseInt(document.getElementById("videoStartYearSelect").value);
      const endYear = parseInt(document.getElementById("videoEndYearSelect").value);
      if (startYear > endYear) {
        alert("시작 연도는 종료 연도보다 작거나 같아야 합니다.");
        return;
      }
      payload.start_date = `${startYear}-01-01`;
      payload.end_date = `${endYear}-12-31`;
    } else if (mode === "custom_date") {
      const sDate = document.getElementById("videoStartDate").value;
      const eDate = document.getElementById("videoEndDate").value;
      if (!sDate || !eDate) {
        alert("시작 날짜와 종료 날짜를 모두 선택해 주세요.");
        return;
      }
      if (sDate > eDate) {
        alert("시작일은 종료일보다 이전이어야 합니다.");
        return;
      }
      payload.start_date = sDate;
      payload.end_date = eDate;
    }

    // UI 상태 변경
    const startBtn = document.getElementById("startRenderBtn");
    const statusCard = document.getElementById("renderStatusCard");
    const resultCard = document.getElementById("videoResultCard");
    const progressFill = document.getElementById("renderProgressFill");
    const statusText = document.getElementById("renderStatusText");
    const messageText = document.getElementById("renderMessageText");

    startBtn.disabled = true;
    startBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 브라우저에서 제작 중...`;
    document.getElementById("videoPlayer").pause();
    statusCard.style.display = "flex";
    resultCard.style.display = "none";
    progressFill.style.width = "3%";
    statusText.innerText = "브라우저 영상 준비 중...";
    messageText.innerText = "선택한 이동 경로를 브라우저에서 읽고 있습니다.";
    document.getElementById("renderSpinner").innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i>`;

    try {
      const days = await loadSelectedVideoDays(payload, (percent, message) => {
        progressFill.style.width = `${percent}%`;
        messageText.innerText = message;
      });
      statusText.innerText = "브라우저에서 영상 인코딩 중...";
      messageText.innerText = "영상 제작이 끝날 때까지 이 탭을 열어 두세요.";
      const result = await BrowserVideoRenderer.renderVideo({
        days,
        title,
        camera,
        duration,
        resolution,
        onTilesProgress: (progress) => {
          const percent = 25 + Math.round(progress * 7);
          progressFill.style.width = `${percent}%`;
          messageText.innerText = `배경 지도를 준비하는 중 (${Math.round(progress * 100)}%)`;
        },
        onProgress: (progress) => {
          const percent = 32 + Math.round(progress * 67);
          progressFill.style.width = `${percent}%`;
          messageText.innerText = `브라우저에서 프레임을 녹화하는 중 (${Math.round(progress * 100)}%). 이 탭을 열어 두세요.`;
        },
      });

      if (currentBrowserVideo) URL.revokeObjectURL(currentBrowserVideo.url);
      currentBrowserVideo = {
        url: URL.createObjectURL(result.blob),
        filename: result.filename,
        size: result.blob.size,
      };
      progressFill.style.width = "100%";
      statusText.innerText = "영상 제작 완료!";
      messageText.innerText = `${result.filename} · 브라우저에서 제작했습니다.`;
      document.getElementById("renderSpinner").innerHTML = `<i class="fa-solid fa-check" style="color: #10b981;"></i>`;
      showVideoResult(currentBrowserVideo.url, result.filename);
      await loadRecentVideos();
      resetRenderUI();
    } catch (err) {
      console.error("브라우저 영상 제작 오류:", err);
      statusText.innerText = "영상 제작에 실패했습니다.";
      messageText.innerText = err.message || "브라우저에서 영상을 만들지 못했습니다.";
      document.getElementById("renderSpinner").innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color: #ef4444;"></i>`;
      resetRenderUI();
    }
  });

  function resetRenderUI() {
    const startBtn = document.getElementById("startRenderBtn");
    startBtn.disabled = false;
    startBtn.innerHTML = `<i class="fa-solid fa-play"></i> 세로 동선 영상 만들기`;
  }

  function showVideoResult(videoUrl, filename) {
    const resultCard = document.getElementById("videoResultCard");
    const videoPlayer = document.getElementById("videoPlayer");
    const downloadBtn = document.getElementById("downloadVideoBtn");

    videoPlayer.src = videoUrl;
    downloadBtn.href = videoUrl;
    const downloadName = filename || videoUrl.split("/").pop();
    downloadBtn.setAttribute("download", downloadName);
    const format = downloadName.toLowerCase().endsWith(".webm") ? "WebM" : "MP4";
    downloadBtn.innerHTML = `<i class="fa-solid fa-download"></i> ${format} 영상 다운로드`;
    resultCard.style.display = "flex";
    videoPlayer.play().catch(() => {});
  }

  // 최근 생성된 영상 목록 로드
  async function loadRecentVideos() {
    const listEl = document.getElementById("recentVideoList");
    let serverVideos = [];
    try {
      const res = await fetch("/api/video/list");
      const data = await res.json();
      if (data.success && Array.isArray(data.videos)) serverVideos = data.videos;
    } catch (err) {
      console.error("영상 목록 로드 실패:", err);
    }

    const videos = [
      ...(currentBrowserVideo ? [currentBrowserVideo] : []),
      ...serverVideos,
    ];
    if (!videos.length) {
      listEl.innerHTML = `<div class="empty-state" style="padding: 10px; font-size: 0.78rem;">생성된 영상이 없습니다.</div>`;
      return;
    }

    listEl.innerHTML = videos
        .map((v) => {
          const mb = (v.size / (1024 * 1024)).toFixed(1);
          return `
            <div class="recent-item">
              <div class="recent-item-meta">
                <span class="recent-item-name" title="${v.filename}">${v.filename}</span>
                <span class="recent-item-size">${mb} MB</span>
              </div>
              <div class="recent-item-actions">
                <button class="recent-action-btn play-recent-btn" data-url="${v.url}" data-filename="${v.filename}">재생</button>
                <a href="${v.url}" class="recent-action-btn" download="${v.filename}">저장</a>
              </div>
            </div>
          `;
        })
        .join("");

      listEl.querySelectorAll(".play-recent-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          showVideoResult(btn.dataset.url, btn.dataset.filename);
        });
      });
  }

  document.getElementById("refreshVideosBtn").addEventListener("click", loadRecentVideos);

  // 12. JSON 파일 업로드 모달 기능
  const uploadModal = document.getElementById("uploadModal");
  const openUploadBtn = document.getElementById("openUploadBtn");
  const closeUploadModalBtn = document.getElementById("closeUploadModalBtn");
  const cancelUploadBtn = document.getElementById("cancelUploadBtn");
  const dropZone = document.getElementById("dropZone");
  const fileInput = document.getElementById("fileInput");
  const confirmUploadBtn = document.getElementById("confirmUploadBtn");
  const selectedFileName = document.getElementById("selectedFileName");
  const uploadProgressBox = document.getElementById("uploadProgressBox");
  let selectedFile = null;

  // 도움말 모달 엘리먼트
  const helpModal = document.getElementById("helpModal");
  const openHelpBtn = document.getElementById("openHelpBtn");
  const closeHelpModalBtn = document.getElementById("closeHelpModalBtn");
  const closeHelpModalFooterBtn = document.getElementById("closeHelpModalFooterBtn");
  const uploadHelpLink = document.getElementById("uploadHelpLink");
  const helpGoUploadBtn = document.getElementById("helpGoUploadBtn");
  const deviceTabBtns = document.querySelectorAll(".device-tab-btn");
  const guideGalaxy = document.getElementById("guide-galaxy");
  const guideIphone = document.getElementById("guide-iphone");

  function openHelpModal() {
    if (helpModal) helpModal.style.display = "flex";
  }

  function closeHelpModal() {
    if (helpModal) helpModal.style.display = "none";
  }

  if (openHelpBtn) openHelpBtn.addEventListener("click", openHelpModal);
  if (closeHelpModalBtn) closeHelpModalBtn.addEventListener("click", closeHelpModal);
  if (closeHelpModalFooterBtn) closeHelpModalFooterBtn.addEventListener("click", closeHelpModal);

  if (uploadHelpLink) {
    uploadHelpLink.addEventListener("click", (e) => {
      e.preventDefault();
      closeUploadModal();
      openHelpModal();
    });
  }

  if (helpGoUploadBtn) {
    helpGoUploadBtn.addEventListener("click", () => {
      closeHelpModal();
      openUploadModal();
    });
  }

  // 기종 탭 전환
  deviceTabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      deviceTabBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const device = btn.getAttribute("data-device");
      if (device === "galaxy") {
        guideGalaxy.style.display = "flex";
        guideIphone.style.display = "none";
      } else {
        guideGalaxy.style.display = "none";
        guideIphone.style.display = "flex";
      }
    });
  });

  function openUploadModal() {
    uploadModal.style.display = "flex";
    selectedFile = null;
    selectedFileName.innerText = "선택된 파일 없음";
    confirmUploadBtn.disabled = true;
    uploadProgressBox.style.display = "none";
  }

  openUploadBtn.addEventListener("click", openUploadModal);

  function closeUploadModal() {
    uploadModal.style.display = "none";
  }

  closeUploadModalBtn.addEventListener("click", closeUploadModal);
  cancelUploadBtn.addEventListener("click", closeUploadModal);

  // 모달 배경 클릭 시 닫기
  window.addEventListener("click", (e) => {
    if (e.target === uploadModal) closeUploadModal();
    if (e.target === helpModal) closeHelpModal();
  });

  // ESC 키 누를 때 모달 닫기
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeUploadModal();
      closeHelpModal();
    }
  });

  dropZone.addEventListener("click", () => fileInput.click());

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
  });

  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelected(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileSelected(e.target.files[0]);
    }
  });

  function handleFileSelected(file) {
    if (!file.name.endsWith(".json")) {
      alert("JSON 파일(.json)만 업로드할 수 있습니다.");
      return;
    }
    selectedFile = file;
    selectedFileName.innerText = `${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`;
    confirmUploadBtn.disabled = false;
  }

  confirmUploadBtn.addEventListener("click", async () => {
    if (!selectedFile) return;

    confirmUploadBtn.disabled = true;
    cancelUploadBtn.disabled = true;
    uploadProgressBox.style.display = "flex";
    const statusText = document.getElementById("uploadStatusText");
    statusText.innerText = "파일 준비 중...";

    try {
      const stats = await TimelineStore.parseAndImport(selectedFile, (p) => {
        statusText.innerText = `${p.text} (${p.percent}%)`;
      });

      alert(`✅ 타임라인 데이터 불러오기 완료!\n\n- 기록 일수: ${stats.stats.dates.toLocaleString()}일\n- 위치 포인트: ${stats.stats.points.toLocaleString()}개\n- 총 주행/이동거리: ${stats.stats.distanceKm.toLocaleString()} km\n\n브라우저 로컬 저장소(IndexedDB)에 안전하게 저장되어 새로고침하거나 오프라인에서도 유지됩니다.`);
      closeUploadModal();
      // 전체 화면 리프레시
      await loadInitialData();
    } catch (err) {
      console.error("업로드/파싱 오류:", err);
      alert("타임라인 파일 분석 중 오류가 발생했습니다:\n" + err.message);
    } finally {
      confirmUploadBtn.disabled = false;
      cancelUploadBtn.disabled = false;
      uploadProgressBox.style.display = "none";
    }
  });

  // 데이터 초기화 버튼
  const clearDataBtn = document.getElementById("clearDataBtn");
  if (clearDataBtn) {
    clearDataBtn.addEventListener("click", async () => {
      if (confirm("브라우저 로컬 저장소에 저장된 타임라인 데이터를 모두 삭제하시겠습니까?")) {
        await TimelineStore.clearAll();
        closeUploadModal();
        await loadInitialData();
        alert("타임라인 데이터가 초기화되었습니다.");
      }
    });
  }

  // 전체 화면 드래그 & 드롭 지원
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (file.name.endsWith(".json")) {
        openUploadModal();
        handleFileSelected(file);
      }
    }
  });

  // 13. PWA 서비스 워커 등록 및 원클릭 앱 설치 기능
  let deferredPrompt = null;
  const installAppBtn = document.getElementById("installAppBtn");

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/static/sw.js").catch((err) => {
        console.log("Service Worker 등록 무시:", err);
      });
    });
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installAppBtn) {
      installAppBtn.style.display = "inline-flex";
    }
  });

  if (installAppBtn) {
    installAppBtn.addEventListener("click", async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === "accepted") {
          installAppBtn.style.display = "none";
        }
        deferredPrompt = null;
      } else {
        alert("브라우저 주소창 우측의 [설치 ⊕] 아이콘을 누르시면 PC 또는 모바일에 독립 앱으로 설치하실 수 있습니다!");
      }
    });
  }

  // 유틸 함수
  function formatDateKorean(dateStr) {
    if (!dateStr || dateStr.length < 10) return dateStr;
    const parts = dateStr.split("-");
    return `${parts[0]}년 ${parseInt(parts[1])}월 ${parseInt(parts[2])}일`;
  }

  // 초기화 실행
  initMap();
  loadInitialData();
});
