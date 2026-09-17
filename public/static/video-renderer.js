(function (root, factory) {
  const renderer = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = renderer;
  if (root) root.BrowserVideoRenderer = renderer;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile';
  const MAX_ROUTE_POINTS = 12000;
  const MAX_TILES = 180;
  const FPS = 30;
  const OUTRO_SECONDS = 1.5;
  const OUTRO_TRANSITION_SECONDS = 1.0;

  function coordinates(point) {
    if (Array.isArray(point)) return [Number(point[0]), Number(point[1])];
    if (point && typeof point === 'object') return [Number(point.lat), Number(point.lng)];
    return [NaN, NaN];
  }

  function pointCount(days) {
    let count = 0;
    for (const day of days || []) {
      for (const segment of day.segments || []) {
        for (const point of segment.points || []) {
          const [lat, lng] = coordinates(point);
          if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 540) count++;
        }
      }
    }
    return count;
  }

  function unwrapLongitude(longitude, previous) {
    if (!Number.isFinite(previous)) return longitude;
    while (longitude - previous > 180) longitude -= 360;
    while (longitude - previous < -180) longitude += 360;
    return longitude;
  }

  function distanceKm(a, b) {
    const radians = (degrees) => degrees * Math.PI / 180;
    const dLat = radians(b.lat - a.lat);
    const dLng = radians(b.lng - a.lng);
    const lat1 = radians(a.lat);
    const lat2 = radians(b.lat);
    const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
  }

  function interpolateLatLon(p1, p2, fraction) {
    if (fraction <= 0) return { lat: p1.lat, lng: p1.lng };
    if (fraction >= 1) return { lat: p2.lat, lng: p2.lng };
    const r = Math.PI / 180;
    const phi1 = p1.lat * r, lam1 = p1.lng * r;
    const phi2 = p2.lat * r, lam2 = p2.lng * r;
    const ax = Math.cos(phi1) * Math.cos(lam1), ay = Math.cos(phi1) * Math.sin(lam1), az = Math.sin(phi1);
    const bx = Math.cos(phi2) * Math.cos(lam2), by = Math.cos(phi2) * Math.sin(lam2), bz = Math.sin(phi2);
    const dot = Math.max(-1, Math.min(1, ax * bx + ay * by + az * bz));
    const omega = Math.acos(dot);
    let left, right;
    if (Math.sin(omega) < 1e-8) {
      left = 1 - fraction;
      right = fraction;
    } else {
      left = Math.sin((1 - fraction) * omega) / Math.sin(omega);
      right = Math.sin(fraction * omega) / Math.sin(omega);
    }
    const x = left * ax + right * bx;
    const y = left * ay + right * by;
    const z = left * az + right * bz;
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / r;
    const lng = Math.atan2(y, x) / r;
    return { lat, lng };
  }

  function buildRoute(days, options) {
    const maxPoints = Math.max(2, Number(options && options.maxPoints) || MAX_ROUTE_POINTS);
    const stride = Math.max(1, Math.ceil(pointCount(days) / maxPoints));
    const paths = [];
    const bounds = { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity };
    let previousLongitude = NaN;

    for (const day of days || []) {
      for (const segment of day.segments || []) {
        const source = segment.points || [];
        const validCount = source.reduce((count, raw) => {
          const [lat, lng] = coordinates(raw);
          return count + (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 540 ? 1 : 0);
        }, 0);
        if (!validCount) continue;

        const path = [];
        let validIndex = 0;
        for (const raw of source) {
          const [lat, rawLng] = coordinates(raw);
          if (!Number.isFinite(lat) || !Number.isFinite(rawLng) || Math.abs(lat) > 90 || Math.abs(rawLng) > 540) continue;
          const lng = unwrapLongitude(rawLng, previousLongitude);
          previousLongitude = lng;
          const keep = validIndex === 0 || validIndex === validCount - 1 || validIndex % stride === 0;
          if (keep) {
            const point = {
              lat,
              lng,
              time: Array.isArray(raw) ? raw[2] || '' : raw.time || '',
              date: day.date || segment.date || '',
            };
            path.push(point);
            bounds.minLat = Math.min(bounds.minLat, lat);
            bounds.maxLat = Math.max(bounds.maxLat, lat);
            bounds.minLng = Math.min(bounds.minLng, lng);
            bounds.maxLng = Math.max(bounds.maxLng, lng);
          }
          validIndex++;
        }
        if (path.length) paths.push({ date: day.date || segment.date || '', points: path });
      }
    }

    const points = paths.flatMap((path) => path.points);
    let totalDistanceKm = 0;
    const cumDist = [];
    for (const path of paths) {
      for (let i = 0; i < path.points.length; i++) {
        if (i === 0 && cumDist.length > 0) {
          cumDist.push(totalDistanceKm);
        } else if (i > 0) {
          totalDistanceKm += distanceKm(path.points[i - 1], path.points[i]);
          cumDist.push(totalDistanceKm);
        } else {
          cumDist.push(0.0);
        }
      }
    }

    return {
      paths,
      points,
      bounds,
      cumDist,
      distanceKm: totalDistanceKm,
      sourcePointCount: pointCount(days),
    };
  }

  function positionAtDistance(route, distanceKm) {
    const points = (route && route.points) || [];
    const cumDist = (route && route.cumDist) || [];
    if (!points.length) return null;
    if (points.length === 1 || !cumDist.length || cumDist.at(-1) <= 0) {
      return { ...points[0], index: 0, fraction: 0 };
    }
    const maxDist = cumDist.at(-1);
    const target = Math.max(0, Math.min(maxDist, Number(distanceKm) || 0));
    let low = 0, high = cumDist.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (cumDist[mid] < target) low = mid + 1;
      else high = mid;
    }
    const toIndex = Math.max(1, low);
    const fromIndex = toIndex - 1;
    const segment = cumDist[toIndex] - cumDist[fromIndex];
    const fraction = segment <= 0 ? 0 : (target - cumDist[fromIndex]) / segment;
    const inter = interpolateLatLon(points[fromIndex], points[toIndex], fraction);
    return {
      lat: inter.lat,
      lng: inter.lng,
      date: points[fromIndex].date || points[toIndex].date || '',
      index: fromIndex,
      fraction,
    };
  }

  function buildJourneyTiming(cumDist) {
    const totalKm = (cumDist && cumDist.length) ? cumDist.at(-1) : 0;
    if (!cumDist || cumDist.length < 2 || totalKm <= 0) {
      return (progress) => totalKm * Math.max(0, Math.min(1, Number(progress) || 0));
    }
    const exponent = 0.85;
    const distances = [0.0];
    const effective = [0.0];
    let effectiveTotal = 0.0;
    for (let i = 1; i < cumDist.length; i++) {
      const segment = cumDist[i] - cumDist[i - 1];
      if (segment <= 0) continue;
      effectiveTotal += Math.pow(segment, exponent);
      distances.push(cumDist[i]);
      effective.push(effectiveTotal);
    }
    if (effectiveTotal <= 0 || distances.length < 2) {
      return (progress) => totalKm * Math.max(0, Math.min(1, Number(progress) || 0));
    }
    const xValues = effective.map((val) => val / effectiveTotal);
    return function distanceAt(progress) {
      const elapsed = Math.max(0, Math.min(1, Number(progress) || 0));
      let low = 0, high = xValues.length - 1;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (xValues[mid] < elapsed) low = mid + 1;
        else high = mid;
      }
      const toIndex = Math.max(1, low);
      const fromIndex = toIndex - 1;
      const width = xValues[toIndex] - xValues[fromIndex];
      const fraction = width <= 0 ? 0 : (elapsed - xValues[fromIndex]) / width;
      return distances[fromIndex] + (distances[toIndex] - distances[fromIndex]) * fraction;
    };
  }

  function easeOutCubic(t) {
    const c = Math.max(0, Math.min(1, t));
    return 1 - Math.pow(1 - c, 3);
  }

  function easeInOutCubic(t) {
    const c = Math.max(0, Math.min(1, t));
    return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
  }

  function mercatorY(latitude) {
    const safeLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
    const sine = Math.sin(safeLatitude * Math.PI / 180);
    return 0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI);
  }

  function computeViewBounds(route, camera, width, height) {
    let minLng = route.bounds.minLng;
    let maxLng = route.bounds.maxLng;
    let minLat = route.bounds.minLat;
    let maxLat = route.bounds.maxLat;

    const overlapsKorea = minLat <= 39.7 && maxLat >= 32.8 && minLng <= 132.5 && maxLng >= 124.2;
    if (camera === 'korea' && overlapsKorea) {
      minLng = 124.2;
      maxLng = 132.5;
      minLat = 32.8;
      maxLat = 39.7;
    }

    let left = (minLng + 180) / 360;
    let right = (maxLng + 180) / 360;
    let top = mercatorY(maxLat);
    let bottom = mercatorY(minLat);
    const centerX = (left + right) / 2;
    const centerY = (top + bottom) / 2;
    let spanX = Math.max(right - left, 0.003);
    let spanY = Math.max(bottom - top, 0.003);
    const aspect = width / height;

    if (spanX / spanY < aspect) spanX = spanY * aspect;
    else spanY = spanX / aspect;

    const padding = camera === 'steady' ? 1.28 : 1.12;
    spanX *= padding;
    spanY *= padding;
    return {
      minX: centerX - spanX / 2,
      maxX: centerX + spanX / 2,
      minY: centerY - spanY / 2,
      maxY: centerY + spanY / 2,
    };
  }

  function tileRange(bounds, zoom) {
    const scale = 2 ** zoom;
    const firstX = Math.floor(bounds.minX * scale);
    const lastX = Math.floor(bounds.maxX * scale);
    const firstY = Math.max(0, Math.floor(bounds.minY * scale));
    const lastY = Math.min(scale - 1, Math.floor(bounds.maxY * scale));
    return { scale, firstX, lastX, firstY, lastY, count: (lastX - firstX + 1) * (lastY - firstY + 1) };
  }

  function chooseTileZoom(bounds) {
    let zoom = 13;
    let range = tileRange(bounds, zoom);
    while (zoom > 1 && range.count > MAX_TILES) range = tileRange(bounds, --zoom);
    return { zoom, ...range };
  }

  async function loadTiles(bounds, onProgress) {
    const selection = chooseTileZoom(bounds);
    const jobs = [];
    for (let x = selection.firstX; x <= selection.lastX; x++) {
      for (let y = selection.firstY; y <= selection.lastY; y++) {
        if (y >= 0 && y < selection.scale) jobs.push({ x, y, wrappedX: ((x % selection.scale) + selection.scale) % selection.scale });
      }
    }

    const tiles = new Map();
    let nextJob = 0;
    let finished = 0;
    const worker = async () => {
      while (nextJob < jobs.length) {
        const job = jobs[nextJob++];
        try {
          const response = await fetch(`${TILE_URL}/${selection.zoom}/${job.y}/${job.wrappedX}`, { mode: 'cors' });
          if (!response.ok) throw new Error(`지도 타일 응답 ${response.status}`);
          const bitmap = await createImageBitmap(await response.blob());
          tiles.set(`${job.x},${job.y}`, bitmap);
        } catch (error) {
          console.warn('지도 타일을 불러오지 못했습니다:', error);
        } finally {
          finished++;
          if (onProgress) onProgress(finished / Math.max(1, jobs.length));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, jobs.length) }, worker));
    return { tiles, ...selection };
  }

  function roundedRect(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
  }

  function formatDistance(kilometers) {
    return Math.max(0, Number(kilometers) || 0).toLocaleString('en-US', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  }

  function formatMonthYear(value) {
    const date = String(value || '').trim();
    const match = date.match(/^(\d{4})-(\d{2})/);
    if (!match) return date;
    const month = Number(match[2]);
    if (month < 1 || month > 12) return date;
    const timestamp = Date.UTC(Number(match[1]), month - 1, 1);
    return new Intl.DateTimeFormat('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(timestamp);
  }

  function getProgressivePaths(route, progress) {
    const totalPoints = route.points ? route.points.length : 0;
    if (!totalPoints) return [];
    const safeProgress = Math.max(0, Math.min(1, Number(progress) || 0));
    let remaining = Math.max(1, Math.ceil(safeProgress * totalPoints));
    const visiblePaths = [];

    for (const path of route.paths || []) {
      if (remaining <= 0) break;
      const points = path.points.slice(0, Math.min(path.points.length, remaining));
      if (points.length) visiblePaths.push({ ...path, points });
      remaining -= points.length;
    }
    return visiblePaths;
  }

  function frameRenderer(canvas, route, view, tileSet, options) {
    const context = canvas.getContext('2d', { alpha: false });
    const width = canvas.width;
    const height = canvas.height;
    const scale = Math.min(width, height) / 720.0;
    const viewWidth = view.maxX - view.minX;
    const viewHeight = view.maxY - view.minY;
    const project = (point) => ({
      x: ((point.lng + 180) / 360 - view.minX) / viewWidth * width,
      y: (mercatorY(point.lat) - view.minY) / viewHeight * height,
    });

    const projectedPoints = (route.points || []).map(project);
    const totalKm = route.distanceKm || 0;
    const distanceAt = buildJourneyTiming(route.cumDist || []);
    const duration = Number(options && options.duration) || 20;
    const totalFrames = Math.max(1, Math.round(duration * FPS));
    const outroFrames = Math.min(Math.round(OUTRO_SECONDS * FPS), totalFrames - 1);
    const journeyFrames = totalFrames - outroFrames;
    const outroTransitionFrames = Math.max(1, Math.round(OUTRO_TRANSITION_SECONDS * FPS));

    // Pre-render map tiles onto an offscreen canvas for instantaneous rendering
    let bgCanvas = null;
    if (typeof document !== 'undefined' && document.createElement && tileSet && tileSet.tiles) {
      bgCanvas = document.createElement('canvas');
      bgCanvas.width = width;
      bgCanvas.height = height;
      const bgCtx = bgCanvas.getContext('2d', { alpha: false });
      bgCtx.fillStyle = '#bfe8f2';
      bgCtx.fillRect(0, 0, width, height);

      const firstX = tileSet.firstX;
      const lastX = tileSet.lastX;
      const firstY = tileSet.firstY;
      const lastY = tileSet.lastY;
      const tileScale = tileSet.scale;
      for (let x = firstX; x <= lastX; x++) {
        for (let y = firstY; y <= lastY; y++) {
          const bitmap = tileSet.tiles.get(`${x},${y}`);
          if (!bitmap) continue;
          const tileLeft = (x / tileScale - view.minX) / viewWidth * width;
          const tileRight = ((x + 1) / tileScale - view.minX) / viewWidth * width;
          const tileTop = (y / tileScale - view.minY) / viewHeight * height;
          const tileBottom = ((y + 1) / tileScale - view.minY) / viewHeight * height;
          bgCtx.drawImage(bitmap, tileLeft, tileTop, tileRight - tileLeft, tileBottom - tileTop);
        }
      }
    }

    return function drawFrame(progress, frameIdx, totalF = totalFrames) {
      const currentFrame = typeof frameIdx === 'number'
        ? frameIdx
        : Math.round(Math.max(0, Math.min(1, Number(progress) || 0)) * (totalF - 1));

      let jProgress, oProgress;
      if (currentFrame < journeyFrames) {
        jProgress = journeyFrames <= 1 ? 1 : currentFrame / (journeyFrames - 1);
        oProgress = 0.0;
      } else {
        jProgress = 1.0;
        const outroIdx = currentFrame - journeyFrames;
        oProgress = Math.min(1.0, outroIdx / outroTransitionFrames);
      }

      const d = distanceAt(jProgress);
      const head = positionAtDistance(route, d) || (route.points[0] ? { ...route.points[0], index: 0 } : { lat: 36, lng: 128, index: 0 });
      const headProj = project(head);

      // 1. Draw Map Background
      if (bgCanvas) {
        context.drawImage(bgCanvas, 0, 0);
      } else {
        context.fillStyle = '#bfe8f2';
        context.fillRect(0, 0, width, height);
      }

      // 2. Trajectory rendering matching visualizer.py & korea_overview_reel.mp4
      const activeAlpha = 1.0 - easeOutCubic(oProgress);
      const headIdx = head.index;
      if (activeAlpha > 0.01 && projectedPoints.length > 0) {
        // 2a. Historical trail (thin, dimmed pink line: color #e90064, alpha 0.34, linewidth 3.5 * scale)
        context.save();
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.strokeStyle = `rgba(233, 0, 100, ${0.34 * activeAlpha})`;
        context.lineWidth = 3.5 * scale;
        let globalIdx = 0;
        for (const path of route.paths || []) {
          if (globalIdx > headIdx) break;
          const pathStart = globalIdx;
          const pathEnd = globalIdx + path.points.length - 1;
          if (path.points.length >= 2 || pathStart === headIdx) {
            context.beginPath();
            context.moveTo(projectedPoints[pathStart].x, projectedPoints[pathStart].y);
            const drawEnd = Math.min(pathEnd, headIdx);
            for (let i = pathStart + 1; i <= drawEnd; i++) {
              context.lineTo(projectedPoints[i].x, projectedPoints[i].y);
            }
            if (headIdx >= pathStart && headIdx <= pathEnd) {
              context.lineTo(headProj.x, headProj.y);
            }
            context.stroke();
          }
          globalIdx += path.points.length;
        }
        context.restore();

        // 2b. Recent trail (thick bright magenta beam: color #e90064, alpha 1.0, linewidth 6.0 * scale)
        // Starts within ~80km or 16% of total trip
        const recentStartKm = Math.max(0.0, d - Math.max(80.0, totalKm * 0.16));
        const cumDist = route.cumDist || [];
        let recentIdx = 0;
        while (recentIdx < cumDist.length && cumDist[recentIdx] < recentStartKm) {
          recentIdx++;
        }
        recentIdx = Math.min(recentIdx, headIdx);

        context.save();
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.strokeStyle = `rgba(233, 0, 100, ${1.0 * activeAlpha})`;
        context.lineWidth = 6.0 * scale;
        globalIdx = 0;
        for (const path of route.paths || []) {
          if (globalIdx > headIdx) break;
          const pathStart = globalIdx;
          const pathEnd = globalIdx + path.points.length - 1;
          if (pathEnd >= recentIdx) {
            const segStart = Math.max(pathStart, recentIdx);
            const segEnd = Math.min(pathEnd, headIdx);
            context.beginPath();
            context.moveTo(projectedPoints[segStart].x, projectedPoints[segStart].y);
            for (let i = segStart + 1; i <= segEnd; i++) {
              context.lineTo(projectedPoints[i].x, projectedPoints[i].y);
            }
            if (headIdx >= pathStart && headIdx <= pathEnd) {
              context.lineTo(headProj.x, headProj.y);
            }
            context.stroke();
          }
          globalIdx += path.points.length;
        }
        context.restore();

        // 2c. Head marker
        // Outer glow: color #e90064, alpha 0.5, radius 11 * scale (diameter 22 * scale)
        context.save();
        context.fillStyle = `rgba(233, 0, 100, ${0.5 * activeAlpha})`;
        context.beginPath();
        context.arc(headProj.x, headProj.y, 11.0 * scale, 0, Math.PI * 2);
        context.fill();

        // Inner head point: fill #24191d, border #e90064 of width 2.5 * scale, radius 6 * scale (diameter 12 * scale)
        context.fillStyle = `rgba(36, 25, 29, ${activeAlpha})`;
        context.strokeStyle = `rgba(233, 0, 100, ${activeAlpha})`;
        context.lineWidth = 2.5 * scale;
        context.beginPath();
        context.arc(headProj.x, headProj.y, 6.0 * scale, 0, Math.PI * 2);
        context.fill();
        context.stroke();
        context.restore();
      }

      // 2d. Outro overview trail (transitions in during the final 1.5 seconds)
      if (oProgress > 0 && projectedPoints.length > 1) {
        const overviewAlpha = (190.0 / 255.0) * easeInOutCubic(oProgress);
        context.save();
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.strokeStyle = `rgba(233, 0, 100, ${overviewAlpha})`;
        context.lineWidth = 3.0 * scale;
        let pIdx = 0;
        for (const path of route.paths || []) {
          if (path.points.length >= 2) {
            context.beginPath();
            context.moveTo(projectedPoints[pIdx].x, projectedPoints[pIdx].y);
            for (let i = 1; i < path.points.length; i++) {
              context.lineTo(projectedPoints[pIdx + i].x, projectedPoints[pIdx + i].y);
            }
            context.stroke();
          }
          pIdx += path.points.length;
        }
        context.restore();
      }

      // 3. Top Info Card (Matching korea_overview_reel.mp4 / Image 2)
      const cardWidth = Math.min(width * 0.85, 420.0 * scale);
      const cardHeight = height * 0.09;
      const cardX = (width - cardWidth) / 2.0;
      const cardY = height * 0.03;
      const cardRadius = width * 0.035;

      context.save();
      context.shadowColor = 'rgba(36, 25, 29, 0.10)';
      context.shadowBlur = width * 0.025;
      context.shadowOffsetY = height * 0.003;
      roundedRect(context, cardX, cardY, cardWidth, cardHeight, cardRadius);
      context.fillStyle = 'rgba(255, 248, 250, 0.92)'; // #fff8fa with alpha 0.92
      context.fill();
      context.shadowBlur = 0;
      context.shadowOffsetY = 0;

      // Title: "대한민국 여행 동선"
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillStyle = '#24191d';
      context.font = `700 ${Math.round(21 * scale)}px system-ui, -apple-system, "Malgun Gothic", sans-serif`;
      context.fillText(
        (options && options.title) || '대한민국 여행 동선',
        width / 2.0,
        cardY + cardHeight * 0.40,
        cardWidth * 0.90
      );

      // Subtitle: "Month Year  •  Distance km"
      context.fillStyle = '#5c4b52';
      context.font = `400 ${Math.round(14 * scale)}px system-ui, -apple-system, "Malgun Gothic", sans-serif`;
      const currentDate = formatMonthYear(head.date || (route.points[0] && route.points[0].date));
      const distStr = formatDistance(d);
      context.fillText(
        options && options.hideDates ? `${distStr} km` : `${currentDate}  •  ${distStr} km`,
        width / 2.0,
        cardY + cardHeight * 0.74,
        cardWidth * 0.90
      );
      context.restore();

      // 4. Map Attribution
      context.save();
      context.textAlign = 'right';
      context.textBaseline = 'bottom';
      context.fillStyle = 'rgba(48, 67, 78, 0.7)';
      context.font = `400 ${Math.round(11 * scale)}px system-ui, sans-serif`;
      context.fillText('© Esri', width * 0.985, height * 0.988);
      context.restore();

      return head;
    };
  }

  function getSupportedMimeType(recorder) {
    if (!recorder) return '';
    const candidates = [
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    if (typeof recorder.isTypeSupported !== 'function') return '';
    return candidates.find((type) => recorder.isTypeSupported(type)) || '';
  }

  function recordCanvas(canvas, drawFrame, duration, mimeType, onProgress, bitrate) {
    return new Promise((resolve, reject) => {
      const totalFrames = Math.max(1, Math.round(duration * FPS));
      const frameIntervalMs = 1000 / FPS; // 33.333ms

      let stream;
      let track = null;
      try {
        stream = canvas.captureStream(0);
        track = stream.getVideoTracks()[0] || null;
      } catch (_) {
        stream = canvas.captureStream(FPS);
      }
      if (!track || typeof track.requestFrame !== 'function') {
        stream = canvas.captureStream(FPS);
        track = null;
      }

      const recorderOptions = { videoBitsPerSecond: bitrate };
      if (mimeType) recorderOptions.mimeType = mimeType;
      let recorder;
      try {
        recorder = new MediaRecorder(stream, recorderOptions);
      } catch (error) {
        stream.getTracks().forEach((t) => t.stop());
        reject(error);
        return;
      }

      const chunks = [];
      let failed = false;
      const finishWithError = (error) => {
        if (failed) return;
        failed = true;
        try { if (recorder.state !== 'inactive') recorder.stop(); } catch (_) { /* stopped */ }
        stream.getTracks().forEach((t) => t.stop());
        reject(error instanceof Error ? error : new Error('브라우저에서 영상 인코딩에 실패했습니다.'));
      };

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) chunks.push(event.data);
      };
      recorder.onerror = (event) => finishWithError(event.error || new Error('브라우저에서 영상 인코딩에 실패했습니다.'));
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (failed) return;
        try {
          const rawType = recorder.mimeType || mimeType || 'video/webm';
          let blob = new Blob(chunks, { type: rawType.split(';')[0] });
          if (!blob.size) {
            reject(new Error('영상 파일이 비어 있습니다. 다시 시도해 주세요.'));
            return;
          }

          // If WebM and fix-webm-duration is available, fix the EBML duration header!
          const isWebm = blob.type.includes('webm');
          const fixDurationFn = typeof ysFixWebmDuration === 'function'
            ? ysFixWebmDuration
            : (typeof root !== 'undefined' && root && root.ysFixWebmDuration);
          if (isWebm && fixDurationFn) {
            try {
              blob = await fixDurationFn(blob, duration * 1000, { logger: false });
            } catch (fixErr) {
              console.warn('WebM 재생 시간 메타데이터 수정 중 경고:', fixErr);
            }
          }

          resolve({ blob, mimeType: blob.type });
        } catch (err) {
          reject(err);
        }
      };

      try {
        recorder.start(1000);
      } catch (error) {
        finishWithError(error);
        return;
      }

      // Deterministic frame pacing
      const startTime = performance.now();
      let frameIndex = 0;
      let lastProgressUpdate = -Infinity;

      const step = async () => {
        if (failed || recorder.state === 'inactive') return;

        while (frameIndex < totalFrames) {
          if (failed || recorder.state === 'inactive') return;

          const progress = totalFrames <= 1 ? 1 : frameIndex / (totalFrames - 1);
          try {
            drawFrame(progress, frameIndex, totalFrames);
            if (track && typeof track.requestFrame === 'function') {
              track.requestFrame();
            }
          } catch (err) {
            finishWithError(err);
            return;
          }

          const now = performance.now();
          if (onProgress && (now - lastProgressUpdate >= 250 || frameIndex === totalFrames - 1)) {
            onProgress((frameIndex + 1) / totalFrames);
            lastProgressUpdate = now;
          }

          frameIndex++;
          const targetNextTime = startTime + frameIndex * frameIntervalMs;
          const waitMs = targetNextTime - performance.now();

          if (waitMs > 1) {
            await new Promise((r) => setTimeout(r, waitMs));
          } else {
            await new Promise((r) => setTimeout(r, 0));
          }
        }

        // Allow final frame to be cleanly encoded before stopping
        setTimeout(() => {
          if (recorder.state !== 'inactive') {
            recorder.stop();
          }
        }, Math.max(250, frameIntervalMs * 4));
      };

      step().catch(finishWithError);
    });
  }

  async function renderVideo(options) {
    const route = buildRoute(options.days);
    if (!route.points.length) throw new Error('선택한 기간에 영상으로 만들 이동 경로가 없습니다.');
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
      throw new Error('이 브라우저는 캔버스 영상 녹화를 지원하지 않습니다. 최신 Chrome, Edge, Firefox 또는 Safari에서 다시 열어 주세요.');
    }
    const resolution = Number(options.resolution) === 1080 ? 1080 : 720;
    const canvas = document.createElement('canvas');
    canvas.width = resolution;
    canvas.height = Math.round(resolution * 16 / 9);
    const mimeType = getSupportedMimeType(window.MediaRecorder);
    if (!mimeType && typeof window.MediaRecorder.isTypeSupported === 'function') {
      throw new Error('이 브라우저는 MP4 또는 WebM 영상 인코딩을 지원하지 않습니다. 최신 Chrome, Edge, Firefox 또는 Safari를 사용해 주세요.');
    }
    const mapArea = { width: canvas.width, height: canvas.height };
    const view = computeViewBounds(route, options.camera || 'korea', mapArea.width, mapArea.height);
    const tiles = await loadTiles(view, (progress) => {
      if (options.onTilesProgress) options.onTilesProgress(progress);
    });
    const drawFrame = frameRenderer(canvas, route, view, tiles, options);

    try {
      const bitrate = resolution === 1080 ? 8_000_000 : 4_000_000;
      const duration = Number(options.duration) || 20;
      const recording = await recordCanvas(canvas, drawFrame, duration, mimeType, options.onProgress, bitrate);
      const extension = recording.mimeType.includes('mp4') ? 'mp4' : 'webm';
      const startDate = route.points[0].date || 'timeline';
      const endDate = route.points.at(-1).date || startDate;
      return {
        ...recording,
        filename: `timeline-video-${startDate}-${endDate}.${extension}`,
        pointCount: route.sourcePointCount,
        distanceKm: route.distanceKm,
      };
    } finally {
      tiles.tiles.forEach((bitmap) => bitmap.close && bitmap.close());
    }
  }

  return {
    buildJourneyTiming,
    buildRoute,
    computeViewBounds,
    distanceKm,
    easeOutCubic,
    easeInOutCubic,
    formatDistance,
    formatMonthYear,
    frameRenderer,
    getProgressivePaths,
    getSupportedMimeType,
    interpolateLatLon,
    positionAtDistance,
    recordCanvas,
    renderVideo,
  };
});