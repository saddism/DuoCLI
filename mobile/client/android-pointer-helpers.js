(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DuoAndroidPointerHelpers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function surfaceContentSize(surface) {
    if (!surface) return { width: 0, height: 0 };
    if (typeof HTMLVideoElement !== 'undefined' && surface instanceof HTMLVideoElement) {
      return { width: surface.videoWidth || 0, height: surface.videoHeight || 0 };
    }
    if (typeof HTMLImageElement !== 'undefined' && surface instanceof HTMLImageElement) {
      return { width: surface.naturalWidth || 0, height: surface.naturalHeight || 0 };
    }
    return {
      width: surface.width || surface.naturalWidth || 0,
      height: surface.height || surface.naturalHeight || 0,
    };
  }

  function containCssSize(availWidth, availHeight, contentWidth, contentHeight) {
    const availW = Number(availWidth) || 0;
    const availH = Number(availHeight) || 0;
    const contentW = Number(contentWidth) || 0;
    const contentH = Number(contentHeight) || 0;
    if (!availW || !availH || !contentW || !contentH) return { width: 0, height: 0, scale: 0 };
    const scale = Math.min(availW / contentW, availH / contentH);
    return {
      width: Math.max(1, Math.floor(contentW * scale)),
      height: Math.max(1, Math.floor(contentH * scale)),
      scale,
    };
  }

  function displayedContentBox(rect, contentWidth, contentHeight, fillsCssBox) {
    const box = rect || { left: 0, top: 0, width: 0, height: 0 };
    if (!box.width || !box.height || !contentWidth || !contentHeight) {
      return { left: box.left || 0, top: box.top || 0, width: 0, height: 0 };
    }
    // Canvas always stretches its bitmap to the CSS box. Images may letterbox
    // via object-fit:contain, so hit-testing has to reconstruct that inset.
    if (fillsCssBox) {
      return { left: box.left, top: box.top, width: box.width, height: box.height };
    }
    const scale = Math.min(box.width / contentWidth, box.height / contentHeight);
    const width = contentWidth * scale;
    const height = contentHeight * scale;
    return {
      left: box.left + (box.width - width) / 2,
      top: box.top + (box.height - height) / 2,
      width,
      height,
    };
  }

  function mapClientPointToDevice(options) {
    const rect = options.rect || { left: 0, top: 0, width: 0, height: 0 };
    const contentWidth = Number(options.contentWidth) || 0;
    const contentHeight = Number(options.contentHeight) || 0;
    const displayed = displayedContentBox(rect, contentWidth, contentHeight, Boolean(options.fillsCssBox));
    if (!displayed.width || !displayed.height) return null;
    const clientX = Number(options.clientX);
    const clientY = Number(options.clientY);
    if (clientX < displayed.left || clientX > displayed.left + displayed.width
      || clientY < displayed.top || clientY > displayed.top + displayed.height) return null;
    const latest = Number(options.latestGeometry) || 0;
    const presented = Number(options.presentedGeometry) || 0;
    if (latest && presented && presented !== latest) return null;
    const relativeX = (clientX - displayed.left) / displayed.width;
    const relativeY = (clientY - displayed.top) / displayed.height;
    const deviceWidth = Number(options.deviceWidth) || contentWidth;
    const deviceHeight = Number(options.deviceHeight) || contentHeight;
    const x = Math.max(0, Math.min(deviceWidth - 1, Math.round(relativeX * (deviceWidth - 1))));
    const y = Math.max(0, Math.min(deviceHeight - 1, Math.round(relativeY * (deviceHeight - 1))));
    const physicalWidth = Number(options.physicalWidth) || 0;
    const physicalHeight = Number(options.physicalHeight) || 0;
    const hasPhysical = physicalWidth > 1 && physicalHeight > 1;
    return {
      x,
      y,
      deviceX: hasPhysical ? Math.max(0, Math.min(physicalWidth - 1, Math.round(relativeX * (physicalWidth - 1)))) : x,
      deviceY: hasPhysical ? Math.max(0, Math.min(physicalHeight - 1, Math.round(relativeY * (physicalHeight - 1)))) : y,
    };
  }

  return { surfaceContentSize, containCssSize, displayedContentBox, mapClientPointToDevice };
});
