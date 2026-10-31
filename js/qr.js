// QR codes via qrcode-generator (global `qrcode`, loaded in admin/index.html).

const MARGIN = 4; // quiet zone in modules, as the QR spec requires

function matrix(text) {
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr;
}

export function qrSvg(text, title) {
  const qr = matrix(text);
  const count = qr.getModuleCount();
  const size = count + MARGIN * 2;
  let path = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) path += `M${col + MARGIN} ${row + MARGIN}h1v1h-1z`;
    }
  }
  const safeTitle = String(title).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img"><title>${safeTitle}</title><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

export function qrPngBlob(text, pixelsPerModule = 16) {
  const qr = matrix(text);
  const count = qr.getModuleCount();
  const size = (count + MARGIN * 2) * pixelsPerModule;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        ctx.fillRect((col + MARGIN) * pixelsPerModule, (row + MARGIN) * pixelsPerModule, pixelsPerModule, pixelsPerModule);
      }
    }
  }
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
