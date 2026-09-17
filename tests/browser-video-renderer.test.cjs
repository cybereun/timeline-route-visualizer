const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRoute,
  computeViewBounds,
  formatDistance,
  formatMonthYear,
  getProgressivePaths,
  getSupportedMimeType,
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
