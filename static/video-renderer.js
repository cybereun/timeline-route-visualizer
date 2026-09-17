(function (root, factory) {
  const renderer = factory();
  if (typeof module === 'object' && module.exports) module.exports = renderer;
  if (root) root.BrowserVideoRenderer = renderer;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile';
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
    lines.slice(0, maxLines).forEach((text, index) => context.fillText(text, x, y + index * lineHeight));
  }

  function formatDistance(kilometers) {
    return (Number(kilometers) || 0).toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }

  function frameRenderer(canvas, route, view, tileSet, options) {
    const context = canvas.getContext('2d', { alpha: false });
    const width = canvas.width;
    const height = canvas.height;
    const scale = tileSet.scale;
    const mapArea = { x: width * 0.075, y: height * 0.235, width: width * 0.85, height: height * 0.59 };
    const viewWidth = view.maxX - view.minX;
    const viewHeight = view.maxY - view.minY;
    const project = (point) => ({
      x: mapArea.x + ((point.lng + 180) / 360 - view.minX) / viewWidth * mapArea.width,
      y: mapArea.y + (mercatorY(point.lat) - view.minY) / viewHeight * mapArea.height,
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
          const tileLeft = (x / scale - view.minX) / viewWidth * mapArea.width + mapArea.x;
          const tileRight = ((x + 1) / scale - view.minX) / viewWidth * mapArea.width + mapArea.x;
          const tileTop = (y / scale - view.minY) / viewHeight * mapArea.height + mapArea.y;
          const tileBottom = ((y + 1) / scale - view.minY) / viewHeight * mapArea.height + mapArea.y;
          context.drawImage(bitmap, tileLeft, tileTop, tileRight - tileLeft, tileBottom - tileTop);
        }
      }
    }

    function drawRoute(progress) {
      const lineWidth = Math.max(3, width * 0.0055);
      context.save();
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.strokeStyle = 'rgba(255, 143, 191, 0.2)';
      context.lineWidth = Math.max(2, lineWidth * 0.8);
      for (const path of route.paths) {
        if (!path.points.length) continue;
        context.beginPath();
        const first = project(path.points[0]);
        context.moveTo(first.x, first.y);
        for (let i = 1; i < path.points.length; i++) {
          const point = project(path.points[i]);
          context.lineTo(point.x, point.y);
        }
        context.stroke();
      }

      let visible = Math.max(1, progress * route.points.length);
      let marker = route.points[0];
      context.strokeStyle = '#ff4d9d';
      context.lineWidth = lineWidth;
      context.shadowColor = 'rgba(255, 40, 132, 0.9)';
      context.shadowBlur = width * 0.025;
      for (const path of route.paths) {
        if (visible <= 0 || !path.points.length) break;
        const count = Math.min(path.points.length, Math.max(1, Math.ceil(visible)));
        context.beginPath();
        let point = project(path.points[0]);
        context.moveTo(point.x, point.y);
        for (let i = 1; i < count; i++) {
          point = project(path.points[i]);
          context.lineTo(point.x, point.y);
        }
        context.stroke();
        marker = path.points[count - 1];
        visible -= count;
      }
      context.shadowBlur = 0;
      const markerPosition = project(marker);
      context.fillStyle = '#fff';
      context.beginPath();
      context.arc(markerPosition.x, markerPosition.y, Math.max(6, width * 0.011), 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = '#ff4d9d';
      context.lineWidth = Math.max(3, width * 0.004);
      context.stroke();
      context.restore();
      return marker;
    }

    return function drawFrame(progress) {
      const gradient = context.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, '#0c1220');
      gradient.addColorStop(0.55, '#111827');
      gradient.addColorStop(1, '#181122');
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);

      context.fillStyle = '#ff72aa';
      context.font = `600 ${Math.round(width * 0.027)}px system-ui, sans-serif`;
      context.fillText('TIMELINE RECAP', width * 0.09, height * 0.075);
      context.fillStyle = '#fff';
      context.font = `700 ${Math.round(width * 0.048)}px system-ui, sans-serif`;
      wrapText(context, options.title, width * 0.09, height * 0.125, width * 0.82, height * 0.055, 2);
      context.fillStyle = '#aeb9ca';
      context.font = `400 ${Math.round(width * 0.022)}px system-ui, sans-serif`;
      context.fillText(`${route.points[0].date}  —  ${route.points.at(-1).date}`, width * 0.09, height * 0.205);

      roundedRect(context, mapArea.x, mapArea.y, mapArea.width, mapArea.height, width * 0.035);
      context.save();
      context.clip();
      context.fillStyle = '#111a27';
      context.fillRect(mapArea.x, mapArea.y, mapArea.width, mapArea.height);
      drawTiles();
      context.fillStyle = 'rgba(9, 16, 28, 0.17)';
      context.fillRect(mapArea.x, mapArea.y, mapArea.width, mapArea.height);
      const marker = drawRoute(progress);
      context.restore();

      const informationY = height * 0.875;
      context.fillStyle = '#98a7bb';
      context.font = `500 ${Math.round(width * 0.024)}px system-ui, sans-serif`;
      context.fillText('누적 이동 거리', width * 0.09, informationY);
      context.fillStyle = '#fff';
      context.font = `700 ${Math.round(width * 0.057)}px system-ui, sans-serif`;
      context.fillText(`${formatDistance(route.distanceKm * progress)} km`, width * 0.09, informationY + height * 0.052);
      context.textAlign = 'right';
      context.fillStyle = '#aeb9ca';
      context.font = `500 ${Math.round(width * 0.023)}px system-ui, sans-serif`;
      context.fillText(marker.date || '', width * 0.91, informationY + height * 0.052);
      context.textAlign = 'left';

      const progressX = width * 0.09;
      const progressY = height * 0.96;
      const progressWidth = width * 0.82;
      context.fillStyle = 'rgba(255,255,255,0.14)';
      roundedRect(context, progressX, progressY, progressWidth, Math.max(3, height * 0.004), height * 0.004);
      context.fill();
      context.fillStyle = '#ff4d9d';
      roundedRect(context, progressX, progressY, Math.max(3, progressWidth * progress), Math.max(3, height * 0.004), height * 0.004);
      context.fill();
      context.fillStyle = '#8290a4';
      context.font = `400 ${Math.round(width * 0.018)}px system-ui, sans-serif`;
      context.fillText('© Esri  ·  Timeline Visualizer', progressX, height * 0.985);
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
    const mapArea = { width: canvas.width * 0.85, height: canvas.height * 0.59 };
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

  return { buildRoute, computeViewBounds, getSupportedMimeType, renderVideo };
});
