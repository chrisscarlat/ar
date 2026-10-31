// Scan page: loads one artwork, preloads its video, and starts AR on "Start".
// Classic script (not a module) so it runs everywhere and can fall back to a
// plain video player when AR is not possible.
(function () {
  'use strict';

  // One Euro filter settings for MindAR. Lower = steadier but slower to follow
  // movement. These favour low jitter for a painting hanging still on a wall.
  var FILTER_MIN_CF = 0.0001;
  var FILTER_BETA = 0.001;

  // Signed URLs must outlive a long visit: a looping video may re-request ranges.
  var SIGNED_URL_TTL = 6 * 60 * 60;

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  var config = window.AR_CONFIG || {};
  var baseUrl = String(config.supabaseUrl || '').replace(/\/+$/, '');
  var apiKey = String(config.supabaseAnonKey || '');

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    intro: $('intro'),
    title: $('title'),
    start: $('start'),
    status: $('status'),
    ar: $('ar'),
    arContainer: $('ar-container'),
    hint: $('ar-hint'),
    help: $('help'),
    retry: $('retry'),
    watchInstead: $('watch-instead'),
    fallback: $('fallback'),
    fallbackReason: $('fallback-reason'),
    fallbackPlayer: $('fallback-player'),
    error: $('error'),
    errorText: $('error-text'),
    errorReload: $('error-reload')
  };

  var artwork = null;
  var video = null;
  var arModulePromise = null;
  var targetVisible = false;

  // ---------------------------------------------------------------- Helpers

  function show(section) {
    [els.intro, els.ar, els.help, els.fallback, els.error].forEach(function (el) {
      el.hidden = el !== section;
    });
  }

  function focusHeading(section) {
    var heading = section.querySelector('h1, h2');
    if (!heading) return;
    heading.setAttribute('tabindex', '-1');
    heading.focus();
  }

  function showError(title, text) {
    $('error-title').textContent = title;
    els.errorText.textContent = text;
    show(els.error);
    focusHeading(els.error);
  }

  function apiHeaders(extra) {
    var headers = { apikey: apiKey };
    // Legacy anon keys are JWTs and also go in Authorization.
    // New publishable keys (sb_publishable_...) only go in apikey.
    if (apiKey.indexOf('eyJ') === 0) headers.Authorization = 'Bearer ' + apiKey;
    return Object.assign(headers, extra || {});
  }

  function encodePath(path) {
    return path.split('/').map(encodeURIComponent).join('/');
  }

  function fetchArtwork(id) {
    var url = baseUrl + '/rest/v1/artworks' +
      '?id=eq.' + encodeURIComponent(id) +
      '&active=is.true' +
      '&select=id,title,target_path,video_path,marker_width,marker_height,loop';
    return fetch(url, { headers: apiHeaders({ Accept: 'application/json' }) })
      .then(function (res) {
        if (!res.ok) throw new Error('Artwork request failed: ' + res.status);
        return res.json();
      })
      .then(function (rows) { return rows[0] || null; });
  }

  function signUrl(bucket, path) {
    return fetch(baseUrl + '/storage/v1/object/sign/' + bucket + '/' + encodePath(path), {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn: SIGNED_URL_TTL })
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Signing ' + bucket + ' failed: ' + res.status);
        return res.json();
      })
      .then(function (data) { return baseUrl + '/storage/v1' + data.signedURL; });
  }

  function supportsWebGL() {
    try {
      var canvas = document.createElement('canvas');
      return !!(window.WebGLRenderingContext &&
        (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')));
    } catch (e) {
      return false;
    }
  }

  function hasCameraApi() {
    return !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  // Lower camera resolution on weaker devices: tracking cost grows with pixels.
  function cameraSize() {
    var lowEnd = (navigator.deviceMemory && navigator.deviceMemory <= 2) ||
      (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);
    return lowEnd
      ? { width: { ideal: 640 }, height: { ideal: 480 } }
      : { width: { ideal: 1280 }, height: { ideal: 720 } };
  }

  // Load the AR module. Browsers without native import maps (iOS < 16.4)
  // reject bare specifiers, so retry through es-module-shims' importShim.
  function loadArModule() {
    var url = new URL('../js/scan-ar.js', location.href).href;
    return import(url).catch(function (nativeError) {
      return waitForImportShim(5000).then(function (importShim) {
        if (!importShim) throw nativeError;
        return importShim(url);
      });
    });
  }

  function waitForImportShim(timeout) {
    return new Promise(function (resolve) {
      var waited = 0;
      (function check() {
        if (typeof window.importShim === 'function') return resolve(window.importShim);
        if (waited >= timeout) return resolve(null);
        waited += 100;
        setTimeout(check, 100);
      })();
    });
  }

  function createVideo(src, loop) {
    var el = document.createElement('video');
    el.crossOrigin = 'anonymous';
    el.muted = true;
    el.defaultMuted = true;
    el.loop = !!loop;
    el.preload = 'auto';
    el.playsInline = true;
    el.setAttribute('muted', '');
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
    el.src = src;
    el.load();
    return el;
  }

  function playOverlay() {
    if (!artwork.loop && video.ended) video.currentTime = 0;
    var promise = video.play();
    if (promise && promise.catch) promise.catch(function () {});
  }

  // ---------------------------------------------------------------- Fallback

  function showFallback(reason) {
    if (video) {
      video.pause();
      video.muted = false;
      video.controls = true;
      video.setAttribute('aria-label', artwork.title);
      els.fallbackPlayer.appendChild(video);
    }
    els.fallbackReason.textContent = reason;
    show(els.fallback);
    focusHeading(els.fallback);
  }

  // ---------------------------------------------------------------- AR

  function startAr() {
    show(els.ar);
    els.hint.textContent = 'Starting camera…';

    arModulePromise
      .then(function (mod) {
        return mod.startAR({
          container: els.arContainer,
          targetUrl: artwork.targetUrl,
          video: video,
          aspect: artwork.marker_height / artwork.marker_width,
          cameraSize: cameraSize(),
          filterMinCF: FILTER_MIN_CF,
          filterBeta: FILTER_BETA,
          onFound: function () {
            targetVisible = true;
            els.hint.hidden = true;
            playOverlay();
          },
          onLost: function () {
            targetVisible = false;
            video.pause();
            els.hint.hidden = false;
            els.hint.textContent = 'Point your camera at the whole painting';
          }
        });
      })
      .then(function () {
        els.hint.textContent = 'Point your camera at the whole painting';
      })
      .catch(function (err) {
        console.error(err);
        els.arContainer.textContent = '';
        var cameraError = err && err.cameraError;
        var name = cameraError && cameraError.name;
        if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
          show(els.help);
          focusHeading(els.help);
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
          showFallback('No camera was found on this device, so here is the video on its own.');
        } else if (name === 'NotReadableError' || name === 'TrackStartError') {
          showFallback('The camera is being used by another app. Close it and reload this page, or watch the video here.');
        } else {
          showFallback('AR could not start on this device, so here is the video on its own.');
        }
      });
  }

  function onStart() {
    els.start.disabled = true;

    // iOS only allows video playback started from a user gesture. Play and pause
    // right away inside this click so later play() calls (on target found) work.
    var unlock = video.play();
    if (unlock && unlock.then) {
      unlock.then(function () { if (!targetVisible) video.pause(); }).catch(function () {});
    }

    if (!arModulePromise) {
      showFallback(hasCameraApi()
        ? 'Your browser cannot show AR here, so here is the video on its own.'
        : 'This browser has no camera access, so here is the video on its own.');
      return;
    }
    startAr();
  }

  // ---------------------------------------------------------------- Init

  function init() {
    els.errorReload.addEventListener('click', function () { location.reload(); });
    els.retry.addEventListener('click', function () { location.reload(); });
    els.watchInstead.addEventListener('click', function () {
      showFallback('Here is the video without the camera.');
    });
    document.addEventListener('visibilitychange', function () {
      if (!video || !els.fallback.hidden) return;
      if (document.hidden) video.pause();
      else if (targetVisible) playOverlay();
    });

    if (!baseUrl || baseUrl.indexOf('YOUR-PROJECT') !== -1) {
      showError('Not set up yet', 'This site has no Supabase project configured. Edit js/config.js.');
      return;
    }

    var id = new URLSearchParams(location.search).get('id');
    if (!id || !UUID_RE.test(id)) {
      showError('No artwork selected', 'Scan the QR code next to an artwork to open it here.');
      return;
    }

    // Start downloading the AR libraries now, while the visitor reads the intro.
    if (supportsWebGL() && hasCameraApi()) {
      arModulePromise = loadArModule();
      arModulePromise.catch(function (err) { console.error('AR libraries failed to load', err); });
    }

    fetchArtwork(id)
      .then(function (row) {
        if (!row) {
          showError('Artwork not available', 'This artwork does not exist or is not shown right now.');
          return;
        }
        artwork = row;
        document.title = row.title + ' · AR Viewer';
        els.title.textContent = row.title;

        return Promise.all([
          signUrl('targets', row.target_path),
          signUrl('videos', row.video_path)
        ]).then(function (urls) {
          artwork.targetUrl = urls[0];
          video = createVideo(urls[1], row.loop);
          els.status.textContent = '';
          els.start.disabled = false;
          if (!arModulePromise) els.start.textContent = 'Play video';
          els.start.addEventListener('click', onStart);
        });
      })
      .catch(function (err) {
        console.error(err);
        showError('Could not load the artwork', 'Check your internet connection and try again.');
      });
  }

  init();
})();
