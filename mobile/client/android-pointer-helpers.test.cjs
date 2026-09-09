const assert = require('node:assert/strict');
const test = require('node:test');
const {
  containCssSize,
  displayedContentBox,
  mapClientPointToDevice,
} = require('./android-pointer-helpers.js');

test('containCssSize fills the taller side of a landscape desktop module', () => {
  const size = containCssSize(1440, 800, 1080, 2400);
  assert.equal(size.width, 360);
  assert.equal(size.height, 800);
});

test('canvas hit-testing uses the stretched CSS box, not image letterboxing', () => {
  const rect = { left: 0, top: 0, width: 1440, height: 800 };
  const letterboxed = displayedContentBox(rect, 1080, 2400, false);
  assert.equal(Math.round(letterboxed.width), 360);
  const point = mapClientPointToDevice({
    clientX: 200,
    clientY: 400,
    rect,
    contentWidth: 1080,
    contentHeight: 2400,
    fillsCssBox: true,
    deviceWidth: 1080,
    deviceHeight: 2400,
  });
  assert.ok(point, 'clicks on the stretched canvas must not be discarded as letterbox');
  assert.equal(point.x, Math.round(200 / 1440 * 1079));
  assert.equal(mapClientPointToDevice({
    clientX: 200,
    clientY: 400,
    rect,
    contentWidth: 1080,
    contentHeight: 2400,
    fillsCssBox: false,
    deviceWidth: 1080,
    deviceHeight: 2400,
  }), null);
});

test('a contained phone surface maps the visual center to device center', () => {
  const size = containCssSize(1440, 800, 1080, 2400);
  const left = (1440 - size.width) / 2;
  const point = mapClientPointToDevice({
    clientX: left + size.width / 2,
    clientY: size.height / 2,
    rect: { left, top: 0, width: size.width, height: size.height },
    contentWidth: 1080,
    contentHeight: 2400,
    fillsCssBox: true,
    deviceWidth: 1080,
    deviceHeight: 2400,
  });
  assert.ok(point);
  assert.equal(point.x, 540);
  assert.equal(point.y, 1200);
});
