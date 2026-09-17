const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildJourneyTiming,
  buildRoute,
  computeViewBounds,
  easeOutCubic,
  easeInOutCubic,
  formatDistance,
  formatMonthYear,
  frameRenderer,
  getProgressivePaths,
  getSupportedMimeType,
  interpolateLatLon,
  positionAtDistance,
} = require('../static/video-renderer.js');

test('buildRoute keeps separate segment paths and ignores invalid coordinates', () => {
  const route = buildRoute([
    {
      date: '2024-03-01',
      segments: [
        { points: [[37, 127, '08:00'], [37, 127.01, '08:05'], [91, 20, 'bad']] },
        { points: [[35, 129, '10:00']] },
      ],
    },
  ]);

  assert.equal(route.paths.length, 2);
  assert.deepEqual(route.points.map((point) => point.date), [
    '2024-03-01', '2024-03-01', '2024-03-01',
  ]);
  assert.ok(route.distanceKm > 0.8 && route.distanceKm < 1.0);
  assert.equal(route.bounds.minLat, 35);
  assert.equal(route.bounds.maxLat, 37);
  assert.equal(route.cumDist.length, 3);
});

test('buildRoute unwraps a route crossing the antimeridian', () => {
  const route = buildRoute([
    { date: '2024-01-01', segments: [{ points: [[10, 179], [10, -179]] }] },
  ]);

  assert.deepEqual(route.points.map((point) => point.lng), [179, 181]);
  assert.ok(route.distanceKm > 200 && route.distanceKm < 230);
});

test('buildRoute samples long routes while preserving segment endpoints', () => {
  const route = buildRoute([
    { date: '2024-01-01', segments: [{ points: Array.from({ length: 20 }, (_, index) => [35, 127 + index / 1000]) }] },
  ], { maxPoints: 5 });

  assert.equal(route.sourcePointCount, 20);
  assert.ok(route.points.length <= 6);
  assert.equal(route.points[0].lng, 127);
  assert.equal(route.points.at(-1).lng, 127.019);
});

test('interpolateLatLon interpolates great circle coordinates between two points', () => {
  const p1 = { lat: 37.0, lng: 127.0 };
  const p2 = { lat: 38.0, lng: 128.0 };
  const mid = interpolateLatLon(p1, p2, 0.5);
  assert.ok(mid.lat > 37.4 && mid.lat < 37.6);
  assert.ok(mid.lng > 127.4 && mid.lng < 127.6);

  assert.deepEqual(interpolateLatLon(p1, p2, 0), p1);
  assert.deepEqual(interpolateLatLon(p1, p2, 1), p2);
});

test('positionAtDistance returns continuous interpolated points along the route', () => {
  const route = buildRoute([
    {
      date: '2026-05-01',
      segments: [
        { points: [[37.5, 127.0, '09:00'], [37.6, 127.0, '10:00']] },
      ],
    },
  ]);
  const half = positionAtDistance(route, route.distanceKm / 2);
  assert.ok(half.lat > 37.54 && half.lat < 37.56);
  assert.ok(Math.abs(half.lng - 127.0) < 1e-5);
  assert.equal(half.date, '2026-05-01');
});

test('buildJourneyTiming creates smooth, monotonic distance progression', () => {
  const cumDist = [0, 10, 50, 200, 500];
  const distanceAt = buildJourneyTiming(cumDist);
  assert.equal(distanceAt(0), 0);
  assert.ok(distanceAt(0.5) > 0 && distanceAt(0.5) < 500);
  assert.equal(distanceAt(1), 500);

  // Strictly increasing
  let prev = -1;
  for (let step = 0; step <= 10; step++) {
    const cur = distanceAt(step / 10);
    assert.ok(cur >= prev);
    prev = cur;
  }
});

test('ease functions clamp between 0 and 1 with expected curvature', () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.ok(easeOutCubic(0.5) > 0.5); // decelerates

  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(0.5), 0.5);
  assert.equal(easeInOutCubic(1), 1);
});

test('getProgressivePaths contains only route points reached at the current progress', () => {
  const route = buildRoute([
    {
      date: '2026-02-01',
      segments: [
        { points: [[37, 127], [37, 127.01], [37.01, 127.02]] },
        { points: [[36, 128]] },
      ],
    },
  ]);
  const longitudes = (paths) => paths.map((path) => path.points.map((point) => point.lng));

  const halfway = typeof getProgressivePaths === 'function'
    ? getProgressivePaths(route, 0.5)
    : [];
  const complete = typeof getProgressivePaths === 'function'
    ? getProgressivePaths(route, 1)
    : [];

  assert.deepEqual(longitudes(halfway), [[127, 127.01]]);
  assert.deepEqual(longitudes(complete), [[127, 127.01, 127.02], [128]]);
});

test('formatMonthYear shows the current route month like the reference video', () => {
  const actual = typeof formatMonthYear === 'function' ? formatMonthYear('2026-02-01') : null;
  assert.equal(actual, 'February 2026');
});

test('formatDistance displays kilometers with 1 decimal place and thousands separators', () => {
  const actual = typeof formatDistance === 'function' ? formatDistance(1505.7) : null;
  assert.equal(actual, '1,505.7');
});

test('computeViewBounds handles a stationary route and a non-Korean Korea preset', () => {
  const route = buildRoute([
    { date: '2024-01-01', segments: [{ points: [[40, -74]] }] },
  ]);
  const bounds = computeViewBounds(route, 'korea', 600, 800);

  const routeX = (-74 + 180) / 360;
  const routeY = 0.5 - Math.log((1 + Math.sin(40 * Math.PI / 180)) / (1 - Math.sin(40 * Math.PI / 180))) / (4 * Math.PI);
  assert.ok(bounds.maxX > bounds.minX);
  assert.ok(bounds.maxY > bounds.minY);
  assert.ok(bounds.minX < routeX && bounds.maxX > routeX);
  assert.ok(bounds.minY < routeY && bounds.maxY > routeY);
});

test('getSupportedMimeType chooses MP4 when available and WebM otherwise', () => {
  const recorder = {
    isTypeSupported(type) {
      return type.startsWith('video/mp4');
    },
  };
  assert.match(getSupportedMimeType(recorder), /^video\/mp4/);

  const webmRecorder = { isTypeSupported: (type) => type.startsWith('video/webm') };
  assert.match(getSupportedMimeType(webmRecorder), /^video\/webm/);
});

test('frameRenderer produces consistent frames without errors on mock canvas context', () => {
  const route = buildRoute([
    {
      date: '2026-06-01',
      segments: [
        { points: [[37.5, 127.0], [36.5, 127.5], [35.2, 129.0]] },
      ],
    },
  ]);
  const view = computeViewBounds(route, 'korea', 720, 1280);
  const calls = [];
  const mockContext = {
    save() {},
    restore() {},
    beginPath() {},
    moveTo(...args) { calls.push(['moveTo', ...args]); },
    lineTo(...args) { calls.push(['lineTo', ...args]); },
    stroke() {},
    fill() {},
    arc(...args) { calls.push(['arc', ...args]); },
    fillRect() {},
    fillText(...args) { calls.push(['fillText', ...args]); },
    measureText(text) { return { width: text.length * 8 }; },
    quadraticCurveTo() {},
    closePath() {},
    drawImage() {},
  };
  const mockCanvas = {
    width: 720,
    height: 1280,
    getContext() { return mockContext; },
  };

  const drawFrame = frameRenderer(mockCanvas, route, view, { tiles: new Map(), scale: 8, firstX: 0, lastX: 0, firstY: 0, lastY: 0 }, {
    duration: 20,
    title: '대한민국 여행 동선',
  });

  // Test journey frame (50% progress)
  const head50 = drawFrame(0.5, 300, 600);
  assert.ok(head50);
  assert.equal(head50.date, '2026-06-01');

  // Test outro frame (100% progress)
  const headOutro = drawFrame(1.0, 580, 600);
  assert.ok(headOutro);
});
