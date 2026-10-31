// Marker and video checks for the admin, plus in-browser .mind compilation.

const MINDAR_IMAGE_URL = 'https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image.prod.js';
const FFLATE_URL = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js';

// Larger markers do not track better, compile slower and make bigger .mind files
// (which the scan page must download before tracking starts).
const MAX_MARKER_SIDE = 800;
const MIN_MARKER_SIDE = 480;
// Standard deviation of grey levels (0-255). Below this the image is flat.
const LOW_CONTRAST = 40;
// Feature points MindAR finds at full size. Rough heuristic, not a hard rule.
const FEW_FEATURES = 100;

const MAX_VIDEO_BYTES = 10 * 1024 * 1024;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This file could not be read as an image.'));
    };
    img.src = url;
  });
}

function scaledCanvas(img, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d');
  // White behind transparent PNG areas, which is also what the compiler would see.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function greyStdDev(canvas) {
  const small = document.createElement('canvas');
  const scale = Math.min(1, 256 / Math.max(canvas.width, canvas.height));
  small.width = Math.max(1, Math.round(canvas.width * scale));
  small.height = Math.max(1, Math.round(canvas.height * scale));
  const ctx = small.getContext('2d');
  ctx.drawImage(canvas, 0, 0, small.width, small.height);
  const { data } = ctx.getImageData(0, 0, small.width, small.height);
  const count = data.length / 4;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < data.length; i += 4) {
    const grey = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += grey;
    sumSq += grey * grey;
  }
  const mean = sum / count;
  return Math.sqrt(Math.max(0, sumSq / count - mean * mean));
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image.'))), type, quality);
  });
}

let compilerModule = null;

async function compileMind(canvas, onProgress) {
  if (!compilerModule) compilerModule = Promise.all([import(MINDAR_IMAGE_URL), import(FFLATE_URL)]);
  const [{ Compiler }, { gzipSync }] = await compilerModule;
  const compiler = new Compiler();
  const dataList = await compiler.compileImageTargets([canvas], (percent) => onProgress(Math.min(100, percent)));
  const buffer = await compiler.exportData();
  // matchingData[0] is the full-size scale.
  const full = dataList[0].matchingData[0];
  // Storage serves files uncompressed; gzip shrinks .mind data about 3x.
  // The scan page detects the gzip header and inflates it.
  return {
    blob: new Blob([gzipSync(new Uint8Array(buffer), { level: 9 })], { type: 'application/octet-stream' }),
    features: full.maximaPoints.length + full.minimaPoints.length
  };
}

/**
 * Resize, check and compile a marker image.
 * Resolves to { width, height, previewUrl, jpeg, mind, warnings }.
 */
export async function prepareMarker(file, onProgress) {
  if (!['image/jpeg', 'image/png'].includes(file.type)) {
    throw new Error('Please choose a JPG or PNG image.');
  }
  const img = await loadImage(file);
  const canvas = scaledCanvas(img, MAX_MARKER_SIDE);
  const warnings = [];

  if (Math.min(img.naturalWidth, img.naturalHeight) < MIN_MARKER_SIDE) {
    warnings.push(`The image is small (${img.naturalWidth}×${img.naturalHeight} px). Use at least ${MIN_MARKER_SIDE} px on the short side for reliable tracking.`);
  }
  const contrast = greyStdDev(canvas);
  if (contrast < LOW_CONTRAST) {
    warnings.push(`Low contrast (score ${Math.round(contrast)}, aim for ${LOW_CONTRAST}+). Tracking may be slow to start or jumpy. Use a photo with strong light and dark areas.`);
  }

  const mind = await compileMind(canvas, onProgress);
  if (mind.features < FEW_FEATURES) {
    warnings.push(`Few trackable details found (${mind.features}, aim for ${FEW_FEATURES}+). Plain areas, soft gradients and repeating patterns track poorly.`);
  }

  const jpeg = await canvasToBlob(canvas, 'image/jpeg', 0.9);
  return {
    width: canvas.width,
    height: canvas.height,
    previewUrl: URL.createObjectURL(jpeg),
    jpeg,
    mind: mind.blob,
    warnings
  };
}

/** Read video metadata and warn about size. Resolves to { width, height, duration, warnings }. */
export function checkVideo(file) {
  if (file.type !== 'video/mp4') {
    return Promise.reject(new Error('Please choose an MP4 video (H.264).'));
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      const duration = video.duration;
      URL.revokeObjectURL(url);
      const warnings = [];
      if (file.size > MAX_VIDEO_BYTES) {
        warnings.push(`The video is ${(file.size / 1048576).toFixed(1)} MB. Keep it under 10 MB so it starts quickly on mobile data.`);
      }
      if (Math.max(width, height) > 1280 || Math.min(width, height) > 720) {
        warnings.push(`The video is ${width}×${height}. Above 720p is wasted on a phone and may stutter on older devices.`);
      }
      resolve({ width, height, duration, warnings });
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This browser cannot play the video. Re-encode it as MP4 with H.264.'));
    };
    video.src = url;
  });
}
