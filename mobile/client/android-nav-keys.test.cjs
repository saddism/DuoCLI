const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ANDROID_NAV_KEYS,
  buildAndroidNavKeyInputs,
  resolveAndroidNavKeyCode,
} = require('./android-nav-keys.js');

test('maps Android nav names to the common system keycodes', () => {
  assert.equal(resolveAndroidNavKeyCode('back'), 4);
  assert.equal(resolveAndroidNavKeyCode('home'), 3);
  assert.equal(resolveAndroidNavKeyCode('recents'), 187);
  assert.equal(resolveAndroidNavKeyCode('unknown'), null);
  assert.equal(ANDROID_NAV_KEYS.recents.label, '菜单');
});

test('builds a down/up pair for each nav key', () => {
  assert.deepEqual(buildAndroidNavKeyInputs('back'), [
    { type: 'back', keyAction: 'down' },
    { type: 'back', keyAction: 'up' },
  ]);
  assert.deepEqual(buildAndroidNavKeyInputs('home'), [
    { type: 'key', keyCode: 3, keyAction: 'down' },
    { type: 'key', keyCode: 3, keyAction: 'up' },
  ]);
  assert.deepEqual(buildAndroidNavKeyInputs('recents'), [
    { type: 'key', keyCode: 187, keyAction: 'down' },
    { type: 'key', keyCode: 187, keyAction: 'up' },
  ]);
  assert.deepEqual(buildAndroidNavKeyInputs(''), []);
});
