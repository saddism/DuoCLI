(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DuoAndroidNavKeys = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ANDROID_NAV_KEYS = {
    back: { type: 'back', keyCode: 4, label: '返回' },
    home: { type: 'key', keyCode: 3, label: '主屏' },
    recents: { type: 'key', keyCode: 187, label: '菜单' },
  };

  function buildAndroidNavKeyInputs(name) {
    const spec = ANDROID_NAV_KEYS[name];
    if (!spec) return [];
    if (spec.type === 'back') {
      return [
        { type: 'back', keyAction: 'down' },
        { type: 'back', keyAction: 'up' },
      ];
    }
    return [
      { type: 'key', keyCode: spec.keyCode, keyAction: 'down' },
      { type: 'key', keyCode: spec.keyCode, keyAction: 'up' },
    ];
  }

  function resolveAndroidNavKeyCode(name) {
    const spec = ANDROID_NAV_KEYS[name];
    return spec ? spec.keyCode : null;
  }

  return { ANDROID_NAV_KEYS, buildAndroidNavKeyInputs, resolveAndroidNavKeyCode };
});
