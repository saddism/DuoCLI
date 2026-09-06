const test = require('node:test');
const assert = require('node:assert/strict');
const { intercept } = require('./spinner-interceptor.js');

test('preserves clear, cursor movement, newline and terminal mode packets', () => {
  for (const data of ['\r\n', '\x1b[2K\r', '\x1b[?1049h', '\x1b[?2004h', '\x1b[1A\rfooter']) {
    assert.equal(intercept(data), data);
    assert.equal(intercept(data), data);
  }
});
test('packet boundaries cannot change terminal bytes', () => {
  const data = '\x1b[?25l\r处理中文⠋\r⠙\r\n\x1b[1A\r\x1b[2K完成\r\n';
  for (let cut = 1; cut < data.length; cut++) {
    assert.equal([data.slice(0, cut), data.slice(cut)].map(intercept).join(''), data);
  }
});
test('only empty or invalid input is ignored', () => {
  assert.equal(intercept(''), null);
  assert.equal(intercept(null), null);
});
