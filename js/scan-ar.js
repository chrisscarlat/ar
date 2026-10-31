// AR part of the scan page: MindAR image tracking + plain three.js.
// Loaded on demand by scan.js, so the page still works (video fallback)
// when these libraries cannot run.

import * as THREE from 'three';
import { MindARThree } from 'mindar-image-three';

// Wrap getUserMedia while MindAR starts the camera: MindAR asks for no specific
// resolution, and swallows the error. We ask for a modest size (cheaper to track
// on old phones) and keep the error so the page can explain what went wrong.
async function withCameraSize(size, start) {
  const media = navigator.mediaDevices;
  const original = media.getUserMedia;
  let cameraError = null;

  media.getUserMedia = function (constraints) {
    const sized = Object.assign({}, constraints, {
      video: Object.assign({}, constraints.video, size)
    });
    return original.call(media, sized).catch(function (err) {
      if (err && err.name === 'OverconstrainedError') {
        return original.call(media, constraints);
      }
      throw err;
    }).catch(function (err) {
      cameraError = err;
      throw err;
    });
  };

  try {
    await start();
  } catch (err) {
    const error = new Error('AR could not start');
    error.cameraError = cameraError;
    error.cause = err;
    throw error;
  } finally {
    media.getUserMedia = original;
  }
}

/**
 * Start tracking one target and show `video` on a plane covering it.
 * `aspect` is marker height / width. Returns { stop }.
 */
export async function startAR(options) {
  const mindar = new MindARThree({
    container: options.container,
    imageTargetSrc: options.targetUrl,
    maxTrack: 1,
    uiLoading: 'no',
    uiScanning: 'no',
    uiError: 'no',
    filterMinCF: options.filterMinCF,
    filterBeta: options.filterBeta
  });

  const renderer = mindar.renderer;
  const scene = mindar.scene;
  const camera = mindar.camera;

  // Full device pixel ratio (3x on some phones) costs a lot of fill rate on old GPUs.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.setAttribute('aria-hidden', 'true');

  const texture = new THREE.VideoTexture(options.video);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  // Anchor space: the target is 1 unit wide, centered at the origin.
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(1, options.aspect),
    new THREE.MeshBasicMaterial({ map: texture, toneMapped: false })
  );
  // Hidden until the video has a frame, so the painting is never covered by black.
  plane.visible = options.video.readyState >= 2;
  options.video.addEventListener('loadeddata', function () { plane.visible = true; });
  options.video.addEventListener('playing', function () { plane.visible = true; });

  const anchor = mindar.addAnchor(0);
  anchor.group.add(plane);
  anchor.onTargetFound = options.onFound;
  anchor.onTargetLost = options.onLost;

  await withCameraSize(options.cameraSize, function () { return mindar.start(); });

  const cameraVideo = options.container.querySelector('video');
  if (cameraVideo) cameraVideo.setAttribute('aria-hidden', 'true');

  // Only draw while the target is visible (plus one frame to clear it):
  // the camera feed is a <video> behind the canvas and needs no WebGL work.
  let drawn = false;
  renderer.setAnimationLoop(function () {
    if (anchor.visible) {
      renderer.render(scene, camera);
      drawn = true;
    } else if (drawn) {
      renderer.render(scene, camera);
      drawn = false;
    }
  });

  return {
    stop: function () {
      renderer.setAnimationLoop(null);
      mindar.stop();
    }
  };
}
