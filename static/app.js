// 타임라인 지도 시각화 앱 메인 스크립트

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
      // 통계 로드
      const summaryRes = await fetch("/api/summary");
      const summary = await summaryRes.json();

      document.getElementById("dataRangeBadge").innerText =
        `${summary.startDate || ""} ~ ${summary.endDate || ""}`;

      document.getElementById("statTotalDays").innerText = `${summary.totalDays.toLocaleString()}일`;
      document.getElementById("statTotalDistance").innerText = `${summary.totalDistanceKm.toLocaleString()} km`;
      document.getElementById("statTotalVisits").innerText = `${summary.totalVisits.toLocaleString()}회`;
      document.getElementById("statTotalPoints").innerText = `${summary.totalPoints.toLocaleString()}개`;

      // 통계 활동 리스트
      const statsList = document.getElementById("activityStatsList");
      statsList.innerHTML = "";
      summary.activities.forEach((act) => {
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
      const datesRes = await fetch("/api/dates");
      const datesData = await datesRes.json();
      allYears = datesData.years;

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
        // allYears는 내림차순 정렬 (2026, 2025, ... 2013)
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
      const res = await fetch(`/api/dates?year=${year}`);
      const data = await res.json();
      currentYearDates = data.dates.map((d) => d.date);

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
      const res = await fetch(`/api/day?date=${dateStr}`);
      dayData = await res.json();

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
      let url = `/api/heatmap?year=${year}`;
      if (month !== "all") url += `&month=${month}`;

      const res = await fetch(url);
      const data = await res.json();

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
  let activeVideoJobId = null;
  let videoPollInterval = null;

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

  // 영상 생성 요청 버튼
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
    startBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 제작 진행 중...`;
    statusCard.style.display = "flex";
    resultCard.style.display = "none";
    progressFill.style.width = "15%";
    statusText.innerText = "영상 제작 요청 중...";
    messageText.innerText = "지도를 다운로드하고 타임라인 프레임을 생성합니다.";

    try {
      const res = await fetch("/api/video/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.success) {
        alert("영상 제작 요청 실패: " + (data.error || "알 수 없는 오류"));
        resetRenderUI();
        return;
      }

      activeVideoJobId = data.job_id;
      // 상태 폴링 시작
      startPollingVideoStatus(activeVideoJobId);
    } catch (err) {
      console.error("렌더링 요청 오류:", err);
      alert("서버 통신 오류가 발생했습니다.");
      resetRenderUI();
    }
  });

  function resetRenderUI() {
    const startBtn = document.getElementById("startRenderBtn");
    startBtn.disabled = false;
    startBtn.innerHTML = `<i class="fa-solid fa-play"></i> 세로 동선 영상 만들기`;
  }

  function startPollingVideoStatus(jobId) {
    if (videoPollInterval) clearInterval(videoPollInterval);

    let progressVal = 20;
    videoPollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/video/status?job_id=${jobId}`);
        const data = await res.json();
        if (!data.success || !data.job) return;

        const job = data.job;
        const statusText = document.getElementById("renderStatusText");
        const messageText = document.getElementById("renderMessageText");
        const progressFill = document.getElementById("renderProgressFill");

        if (job.status === "processing") {
          progressVal = Math.min(90, progressVal + 5);
          progressFill.style.width = `${progressVal}%`;
          statusText.innerText = `영상 렌더링 중 (${progressVal}%)...`;
          messageText.innerText = job.message || "프레임을 그리는 중입니다...";
        } else if (job.status === "completed") {
          clearInterval(videoPollInterval);
          progressFill.style.width = "100%";
          statusText.innerText = "영상 제작 완료!";
          messageText.innerText = "아래에서 영상을 확인하고 다운로드하세요.";
          document.getElementById("renderSpinner").innerHTML = `<i class="fa-solid fa-check" style="color: #10b981;"></i>`;

          // 결과 카드 표시
          showVideoResult(job.video_url);
          resetRenderUI();
          loadRecentVideos();
        } else if (job.status === "failed") {
          clearInterval(videoPollInterval);
          statusText.innerText = "제작 실패";
          messageText.innerText = job.error || "렌더링 중 오류가 발생했습니다.";
          document.getElementById("renderSpinner").innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color: #ef4444;"></i>`;
          resetRenderUI();
        }
      } catch (e) {
        console.error("폴링 오류:", e);
      }
    }, 2000);
  }

  function showVideoResult(videoUrl) {
    const resultCard = document.getElementById("videoResultCard");
    const videoPlayer = document.getElementById("videoPlayer");
    const downloadBtn = document.getElementById("downloadVideoBtn");

    videoPlayer.src = videoUrl;
    downloadBtn.href = videoUrl;
    downloadBtn.setAttribute("download", videoUrl.split("/").pop());
    resultCard.style.display = "flex";
    videoPlayer.play().catch(() => {});
  }

  // 최근 생성된 영상 목록 로드
  async function loadRecentVideos() {
    try {
      const res = await fetch("/api/video/list");
      const data = await res.json();
      const listEl = document.getElementById("recentVideoList");
      if (!data.success || !data.videos || data.videos.length === 0) {
        listEl.innerHTML = `<div class="empty-state" style="padding: 10px; font-size: 0.78rem;">생성된 영상이 없습니다.</div>`;
        return;
      }

      listEl.innerHTML = data.videos
        .map((v) => {
          const mb = (v.size / (1024 * 1024)).toFixed(1);
          return `
            <div class="recent-item">
              <div class="recent-item-meta">
                <span class="recent-item-name" title="${v.filename}">${v.filename}</span>
                <span class="recent-item-size">${mb} MB</span>
              </div>
              <div class="recent-item-actions">
                <button class="recent-action-btn play-recent-btn" data-url="${v.url}">재생</button>
                <a href="${v.url}" class="recent-action-btn" download="${v.filename}">저장</a>
              </div>
            </div>
          `;
        })
        .join("");

      listEl.querySelectorAll(".play-recent-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          showVideoResult(btn.dataset.url);
        });
      });
    } catch (err) {
      console.error("영상 목록 로드 실패:", err);
    }
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

  openUploadBtn.addEventListener("click", () => {
    uploadModal.style.display = "flex";
    selectedFile = null;
    selectedFileName.innerText = "선택된 파일 없음";
    confirmUploadBtn.disabled = true;
    uploadProgressBox.style.display = "none";
  });

  function closeUploadModal() {
    uploadModal.style.display = "none";
  }

  closeUploadModalBtn.addEventListener("click", closeUploadModal);
  cancelUploadBtn.addEventListener("click", closeUploadModal);

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
    document.getElementById("uploadStatusText").innerText = "서버로 전송 및 데이터베이스 인덱싱 중입니다...";

    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: selectedFile,
      });

      const data = await res.json();
      if (data.success) {
        alert(`업로드 완료!\n총 ${data.stats.dates.toLocaleString()}일, ${data.stats.points.toLocaleString()}개 위치 포인트가 성공적으로 갱신되었습니다.`);
        closeUploadModal();
        // 전체 화면 리프레시
        loadInitialData();
      } else {
        alert("업로드 실패: " + (data.error || "알 수 없는 오류"));
      }
    } catch (err) {
      console.error("업로드 오류:", err);
      alert("업로드 중 오류가 발생했습니다: " + err);
    } finally {
      confirmUploadBtn.disabled = false;
      cancelUploadBtn.disabled = false;
      uploadProgressBox.style.display = "none";
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
