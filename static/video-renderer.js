(function (root, factory) {
  const renderer = factory();
  if (typeof module === 'object' && module.exports) module.exports = renderer;
  if (root) root.BrowserVideoRenderer = renderer;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile';
  const MAX_ROUTE_POINTS = 12000;
  const MAX_TILES = 180;
  const FPS = 30;

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
    for (const path of paths) {
      for (let i = 1; i < path.points.length; i++) totalDistanceKm += distanceKm(path.points[i - 1], path.points[i]);
    }
    return { paths, points, bounds, distanceKm: totalDistanceKm, sourcePointCount: pointCount(days) };
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

  function wrapText(context, value, x, y, maxWidth, lineHeight, maxLines) {
    const words = String(value || '').trim().split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    const ellipsize = (text) => {
      let clipped = text;
      while (clipped && context.measureText(`${clipped}…`).width > maxWidth) clipped = clipped.slice(0, -1);
      return `${clipped}…`;
    };

    for (let index = 0; index < words.length; index++) {
      const candidate = line ? `${line} ${words[index]}` : words[index];
      if (!line || context.measureText(candidate).width <= maxWidth) {
        line = candidate;
      } else if (lines.length < maxLines - 1) {
        lines.push(line);
        line = words[index];
      } else {
        lines.push(ellipsize(`${line} ${words.slice(index).join(' ')}`));
        line = '';
        break;
      }
    }
    if (line) lines.push(context.measureText(line).width > maxWidth ? ellipsize(line) : line);
    const visibleLines = lines.slice(0, maxLines);
    visibleLines.forEach((text, index) => context.fillText(text, x, y + index * lineHeight));
    return visibleLines.length;
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
    const totalPoints = route.points.length;
    if (!totalPoints) return [];
    const safeProgress = Math.max(0, Math.min(1, Number(progress) || 0));
    let remaining = Math.max(1, Math.ceil(safeProgress * totalPoints));
    const visiblePaths = [];

    for (const path of route.paths) {
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
    const scale = tileSet.scale;
    const viewWidth = view.maxX - view.minX;
    const viewHeight = view.maxY - view.minY;
    const project = (point) => ({
      x: ((point.lng + 180) / 360 - view.minX) / viewWidth * width,
      y: (mercatorY(point.lat) - view.minY) / viewHeight * height,
    });

    function drawTiles() {
      const firstX = tileSet.firstX;
      const lastX = tileSet.lastX;
      const firstY = tileSet.firstY;
      const lastY = tileSet.lastY;
      for (let x = firstX; x <= lastX; x++) {
        for (let y = firstY; y <= lastY; y++) {
          const bitmap = tileSet.tiles.get(`${x},${y}`);
          if (!bitmap) continue;
          const tileLeft = (x / scale - view.minX) / viewWidth * width;
          const tileRight = ((x + 1) / scale - view.minX) / viewWidth * width;
          const tileTop = (y / scale - view.minY) / viewHeight * height;
          const tileBottom = ((y + 1) / scale - view.minY) / viewHeight * height;
          context.drawImage(bitmap, tileLeft, tileTop, tileRight - tileLeft, tileBottom - tileTop);
        }
      }
    }

    function drawRoute(progress) {
      const lineWidth = Math.max(3, width * 0.0055);
      const visiblePaths = getProgressivePaths(route, progress);
      let marker = route.points[0];
      context.save();
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.strokeStyle = '#e90064';
      context.lineWidth = lineWidth;
      context.shadowColor = 'rgba(233, 0, 100, 0.45)';
      context.shadowBlur = width * 0.012;
      for (const path of visiblePaths) {
        if (path.points.length < 2) {
          marker = path.points.at(-1) || marker;
          continue;
        }
        context.beginPath();
        let point = project(path.points[0]);
        context.moveTo(point.x, point.y);
        for (let i = 1; i < path.points.length; i++) {
          point = project(path.points[i]);
          context.lineTo(point.x, point.y);
        }
        context.stroke();
        marker = path.points.at(-1);
      }
      context.shadowBlur = 0;
      const markerPosition = project(marker);

      // Outer translucent pink glow (matching Image 2)
      context.fillStyle = 'rgba(233, 0, 100, 0.45)';
      context.beginPath();
      context.arc(markerPosition.x, markerPosition.y, Math.max(7, width * 0.020), 0, Math.PI * 2);
      context.fill();

      // Middle solid pink circle
      context.fillStyle = '#e90064';
      context.beginPath();
      context.arc(markerPosition.x, markerPosition.y, Math.max(4.5, width * 0.011), 0, Math.PI * 2);
      context.fill();

      // Inner black dot (matching Image 2)
      context.fillStyle = '#24191d';
      context.beginPath();
      context.arc(markerPosition.x, markerPosition.y, Math.max(2.2, width * 0.0055), 0, Math.PI * 2);
      context.fill();

      context.restore();
      return marker;
    }

    return function drawFrame(progress) {
      const safeProgress = Math.max(0, Math.min(1, Number(progress) || 0));
      context.fillStyle = '#bfe8f2';
      context.fillRect(0, 0, width, height);
      drawTiles();
      const marker = drawRoute(safeProgress);
      const infoCard = {
        x: width * 0.18,
        y: height * 0.02,
        width: width * 0.64,
        height: height * 0.11,
      };
      context.save();
      context.shadowColor = 'rgba(35, 56, 72, 0.15)';
      context.shadowBlur = width * 0.025;
      context.shadowOffsetY = height * 0.003;
      roundedRect(context, infoCard.x, infoCard.y, infoCard.width, infoCard.height, width * 0.035);
      context.fillStyle = 'rgba(255, 255, 255, 0.94)';
      context.fill();
      context.shadowBlur = 0;
      context.shadowOffsetY = 0;
      context.textAlign = 'center';
      context.fillStyle = '#24191d';
      context.font = `700 ${Math.round(width * 0.038)}px system-ui, -apple-system, sans-serif`;
      const titleLineCount = wrapText(
        context,
        options.title || '대한민국 여행 동선',
        width / 2,
        infoCard.y + infoCard.height * 0.38,
        infoCard.width * 0.9,
        height * 0.028,
        2
      );
      context.fillStyle = '#5c4b52';
      context.font = `400 ${Math.round(width * 0.024)}px system-ui, -apple-system, sans-serif`;
      const currentDate = formatMonthYear(marker.date || route.points[0].date);
      const distance = formatDistance(route.distanceKm * safeProgress);
      const detailsY = infoCard.y + infoCard.height * (titleLineCount > 1 ? 0.84 : 0.74);
      context.fillText(`${currentDate}  •  ${distance} km`, width / 2, detailsY, infoCard.width * 0.9);
      context.restore();

      context.textAlign = 'right';
      context.fillStyle = 'rgba(48, 67, 78, 0.7)';
      context.font = `400 ${Math.round(width * 0.017)}px system-ui, sans-serif`;
      context.fillText('© Esri', width * 0.985, height * 0.988);
      context.textAlign = 'left';
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
      const stream = canvas.captureStream(FPS);
      const recorderOptions = { videoBitsPerSecond: bitrate };
      if (mimeType) recorderOptions.mimeType = mimeType;
      let recorder;
      try {
        recorder = new MediaRecorder(stream, recorderOptions);
      } catch (error) {
        stream.getTracks().forEach((track) => track.stop());
        reject(error);
        return;
      }

      const chunks = [];
      let failed = false;
      const finishWithError = (error) => {
        if (failed) return;
        failed = true;
        try { if (recorder.state !== 'inactive') recorder.stop(); } catch (_) { /* already stopped */ }
        stream.getTracks().forEach((track) => track.stop());
        reject(error instanceof Error ? error : new Error('브라우저에서 영상 인코딩에 실패했습니다.'));
      };

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) chunks.push(event.data);
      };
      recorder.onerror = (event) => finishWithError(event.error || new Error('브라우저에서 영상 인코딩에 실패했습니다.'));
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        if (failed) return;
        const type = recorder.mimeType || mimeType || 'video/webm';
        const blob = new Blob(chunks, { type: type.split(';')[0] });
        if (!blob.size) reject(new Error('영상 파일이 비어 있습니다. 다시 시도해 주세요.'));
        else resolve({ blob, mimeType: blob.type });
      };

      try {
        recorder.start(1000);
      } catch (error) {
        finishWithError(error);
        return;
      }

      const startedAt = performance.now();
      let lastProgressUpdate = -Infinity;
      const render = (now) => {
        if (failed || recorder.state === 'inactive') return;
        const progress = Math.min(1, Math.max(0, (now - startedAt) / (duration * 1000)));
        try {
          drawFrame(progress);
          if (onProgress && (now - lastProgressUpdate >= 250 || progress >= 1)) {
            onProgress(progress);
            lastProgressUpdate = now;
          }
        } catch (error) {
          finishWithError(error);
          return;
        }
        if (progress >= 1) {
          window.setTimeout(() => {
            if (recorder.state !== 'inactive') recorder.stop();
          }, 150);
        } else window.requestAnimationFrame(render);
      };
      window.requestAnimationFrame(render);
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
      const recording = await recordCanvas(canvas, drawFrame, Number(options.duration) || 20, mimeType, options.onProgress, bitrate);
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
    buildRoute,
    computeViewBounds,
    formatDistance,
    formatMonthYear,
    getProgressivePaths,
    getSupportedMimeType,
    renderVideo,
  };
});
