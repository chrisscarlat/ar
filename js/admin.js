// Admin: sign in, create/edit/deactivate/delete artworks, download QR codes.

import { prepareMarker, checkVideo } from './admin-media.js';
import { qrSvg, qrPngBlob } from './qr.js';

const config = window.AR_CONFIG || {};
const $ = (id) => document.getElementById(id);

const els = {
  bootStatus: $('boot-status'),
  who: $('who'),
  signOut: $('sign-out'),
  login: $('login'),
  loginForm: $('login-form'),
  loginStatus: $('login-status'),
  workspace: $('workspace'),
  editorTitle: $('editor-title'),
  form: $('artwork-form'),
  title: $('title'),
  marker: $('marker'),
  markerProgressWrap: $('marker-progress-wrap'),
  markerProgress: $('marker-progress'),
  markerStatus: $('marker-status'),
  markerPreview: $('marker-preview'),
  video: $('video'),
  videoStatus: $('video-status'),
  loop: $('loop'),
  active: $('active'),
  warnings: $('warnings'),
  warningsList: $('warnings-list'),
  save: $('save'),
  cancelEdit: $('cancel-edit'),
  saveProgressWrap: $('save-progress-wrap'),
  saveStatus: $('save-status'),
  listStatus: $('list-status'),
  list: $('artwork-list')
};

let sb = null;
let editing = null;        // row being edited, or null when creating
let marker = null;         // result of prepareMarker for the chosen file
let markerJob = 0;         // ignores results of a marker that was replaced mid-compile
let markerBusy = false;
let videoFile = null;
let videoWarnings = [];
let saving = false;

// ------------------------------------------------------------------ Helpers

function setStatus(el, text, kind) {
  el.textContent = text || '';
  el.classList.toggle('form-status--error', kind === 'error');
  el.classList.toggle('form-status--ok', kind === 'ok');
}

function scanUrl(id) {
  return new URL(`../scan/?id=${encodeURIComponent(id)}`, location.href).href;
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function slug(text) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'artwork';
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function renderWarnings() {
  const all = [...(marker ? marker.warnings : []), ...videoWarnings];
  els.warningsList.replaceChildren(...all.map((text) => el('li', { text })));
  els.warnings.hidden = all.length === 0;
}

function updateSaveButton() {
  els.save.disabled = saving || markerBusy;
}

// ------------------------------------------------------------------ Auth

async function showSignedIn(session) {
  const { data: isAdmin, error } = await sb.rpc('is_admin');
  if (error || !isAdmin) {
    await sb.auth.signOut();
    showSignedOut(error
      ? 'Could not check admin rights. Has supabase/schema.sql been run?'
      : 'This account is not an admin. Ask the site owner to add it to the admins table.');
    return;
  }
  els.bootStatus.hidden = true;
  els.login.hidden = true;
  els.workspace.hidden = false;
  els.signOut.hidden = false;
  els.who.textContent = session.user.email || '';
  loadArtworks();
}

function showSignedOut(message) {
  els.bootStatus.hidden = true;
  els.workspace.hidden = true;
  els.signOut.hidden = true;
  els.who.textContent = '';
  els.login.hidden = false;
  setStatus(els.loginStatus, message, message ? 'error' : null);
}

async function onLogin(event) {
  event.preventDefault();
  setStatus(els.loginStatus, 'Signing in…');
  const { data, error } = await sb.auth.signInWithPassword({
    email: $('login-email').value.trim(),
    password: $('login-password').value
  });
  if (error) {
    setStatus(els.loginStatus, error.message, 'error');
    return;
  }
  $('login-password').value = '';
  setStatus(els.loginStatus, '');
  showSignedIn(data.session);
}

// ------------------------------------------------------------------ Form

async function onMarkerChange() {
  const file = els.marker.files[0];
  const job = ++markerJob;
  marker = null;
  els.markerPreview.hidden = true;
  renderWarnings();
  if (!file) {
    markerBusy = false;
    els.markerProgressWrap.hidden = true;
    setStatus(els.markerStatus, '');
    updateSaveButton();
    return;
  }

  markerBusy = true;
  updateSaveButton();
  els.markerProgress.value = 0;
  els.markerProgressWrap.hidden = false;
  setStatus(els.markerStatus, 'Compiling marker for tracking. This can take up to a minute…');

  try {
    const result = await prepareMarker(file, (percent) => {
      if (job === markerJob) els.markerProgress.value = percent;
    });
    if (job !== markerJob) return;
    marker = result;
    els.markerProgress.value = 100;
    els.markerPreview.src = result.previewUrl;
    els.markerPreview.hidden = false;
    setStatus(els.markerStatus, `Marker ready (${result.width}×${result.height} px).`, 'ok');
  } catch (err) {
    if (job !== markerJob) return;
    console.error(err);
    els.marker.value = '';
    setStatus(els.markerStatus, err.message || 'The marker could not be compiled.', 'error');
  } finally {
    if (job === markerJob) {
      markerBusy = false;
      els.markerProgressWrap.hidden = true;
      renderWarnings();
      updateSaveButton();
    }
  }
}

async function onVideoChange() {
  const file = els.video.files[0];
  videoFile = null;
  videoWarnings = [];
  renderWarnings();
  if (!file) {
    setStatus(els.videoStatus, '');
    return;
  }
  setStatus(els.videoStatus, 'Checking video…');
  try {
    const info = await checkVideo(file);
    if (els.video.files[0] !== file) return;
    videoFile = file;
    videoWarnings = info.warnings;
    setStatus(els.videoStatus,
      `${info.width}×${info.height}, ${Math.round(info.duration)} s, ${(file.size / 1048576).toFixed(1)} MB.`, 'ok');
  } catch (err) {
    els.video.value = '';
    setStatus(els.videoStatus, err.message, 'error');
  }
  renderWarnings();
}

function resetForm() {
  editing = null;
  marker = null;
  markerJob++;
  markerBusy = false;
  videoFile = null;
  videoWarnings = [];
  els.form.reset();
  els.loop.checked = true;
  els.active.checked = true;
  els.markerPreview.hidden = true;
  els.markerProgressWrap.hidden = true;
  els.editorTitle.textContent = 'New artwork';
  els.save.textContent = 'Save artwork';
  els.cancelEdit.hidden = true;
  setStatus(els.markerStatus, '');
  setStatus(els.videoStatus, '');
  renderWarnings();
  updateSaveButton();
}

function startEdit(row) {
  resetForm();
  editing = row;
  els.title.value = row.title;
  els.loop.checked = row.loop;
  els.active.checked = row.active;
  els.editorTitle.textContent = `Edit “${row.title}”`;
  els.save.textContent = 'Save changes';
  els.cancelEdit.hidden = false;
  setStatus(els.markerStatus, 'Leave empty to keep the current marker.');
  setStatus(els.videoStatus, 'Leave empty to keep the current video.');
  setStatus(els.saveStatus, '');
  els.editorTitle.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  els.title.focus({ preventScroll: true });
}

async function upload(bucket, path, body, contentType) {
  const { error } = await sb.storage.from(bucket).upload(path, body, {
    contentType,
    cacheControl: '31536000',
    upsert: false
  });
  if (error) throw new Error(`Upload to ${bucket} failed: ${error.message}`);
}

async function removeFiles(files) {
  const byBucket = {};
  for (const [bucket, path] of files) (byBucket[bucket] = byBucket[bucket] || []).push(path);
  await Promise.all(Object.entries(byBucket).map(([bucket, paths]) => sb.storage.from(bucket).remove(paths)));
}

async function onSave(event) {
  event.preventDefault();
  if (saving || markerBusy) return;

  const title = els.title.value.trim();
  const problems = [];
  if (!title) problems.push('a title');
  if (!editing && !marker) problems.push('a marker image');
  if (!editing && !videoFile) problems.push('a video');
  if (problems.length) {
    setStatus(els.saveStatus, `Please add ${problems.join(', ')}.`, 'error');
    if (!title) els.title.focus();
    else if (!editing && !marker) els.marker.focus();
    else els.video.focus();
    return;
  }

  saving = true;
  updateSaveButton();
  els.saveProgressWrap.hidden = false;

  const id = editing ? editing.id : uuid();
  // Versioned names: replaced files get new URLs, so long cache times are safe.
  const stamp = Date.now().toString(36);
  const uploads = [];
  const row = { title, loop: els.loop.checked, active: els.active.checked };
  const replaced = [];

  if (marker) {
    row.marker_path = `${id}/marker-${stamp}.jpg`;
    row.target_path = `${id}/target-${stamp}.mind`;
    row.marker_width = marker.width;
    row.marker_height = marker.height;
    uploads.push(['markers', row.marker_path, marker.jpeg, 'image/jpeg', 'marker image']);
    uploads.push(['targets', row.target_path, marker.mind, 'application/octet-stream', 'tracking data']);
    if (editing) replaced.push(['markers', editing.marker_path], ['targets', editing.target_path]);
  }
  if (videoFile) {
    row.video_path = `${id}/video-${stamp}.mp4`;
    uploads.push(['videos', row.video_path, videoFile, 'video/mp4', 'video']);
    if (editing) replaced.push(['videos', editing.video_path]);
  }

  const done = [];
  try {
    for (const [i, [bucket, path, body, type, label]] of uploads.entries()) {
      setStatus(els.saveStatus, `Uploading ${label} (${i + 1} of ${uploads.length})…`);
      await upload(bucket, path, body, type);
      done.push([bucket, path]);
    }
    setStatus(els.saveStatus, 'Saving…');
    const { error } = editing
      ? await sb.from('artworks').update(row).eq('id', id)
      : await sb.from('artworks').insert({ id, ...row });
    if (error) throw new Error(error.message);

    if (replaced.length) await removeFiles(replaced).catch((err) => console.warn('Old files not removed', err));
    const wasEditing = !!editing;
    resetForm();
    setStatus(els.saveStatus, wasEditing ? 'Changes saved.' : 'Artwork created. Download its QR code below.', 'ok');
    await loadArtworks();
  } catch (err) {
    console.error(err);
    if (done.length) await removeFiles(done).catch(() => {});
    setStatus(els.saveStatus, `Not saved: ${err.message}`, 'error');
  } finally {
    saving = false;
    els.saveProgressWrap.hidden = true;
    updateSaveButton();
  }
}

// ------------------------------------------------------------------ List

async function loadArtworks() {
  setStatus(els.listStatus, 'Loading artworks…');
  const { data, error } = await sb.from('artworks').select('*').order('created_at', { ascending: false });
  if (error) {
    setStatus(els.listStatus, `Could not load artworks: ${error.message}`, 'error');
    return;
  }
  let thumbs = {};
  if (data.length) {
    const { data: signed } = await sb.storage.from('markers').createSignedUrls(data.map((r) => r.marker_path), 3600);
    for (const item of signed || []) if (item.signedUrl) thumbs[item.path] = item.signedUrl;
  }

  setStatus(els.listStatus, data.length ? `${data.length} artwork${data.length === 1 ? '' : 's'}.` : 'No artworks yet. Create one above.');
  els.list.replaceChildren(...data.map((row) => renderArtwork(row, thumbs[row.marker_path])));
}

function renderArtwork(row, thumbUrl) {
  const url = scanUrl(row.id);
  const name = slug(row.title);

  const qrBox = el('div', { class: 'qr-box' });
  const qr = el('details', { class: 'artwork__qr' }, [el('summary', { text: 'QR code' }), qrBox]);
  qr.addEventListener('toggle', () => {
    if (!qr.open || qrBox.childElementCount) return;
    const svg = qrSvg(url, `QR code for ${row.title}`);
    const holder = el('div');
    holder.innerHTML = svg; // generated locally; the title is escaped in qrSvg
    qrBox.append(
      holder,
      el('p', { class: 'qr-box__link' }, [el('a', { href: url, target: '_blank', rel: 'noopener', text: url })]),
      el('div', { class: 'artwork__actions' }, [
        el('button', {
          class: 'button button--small', type: 'button', text: 'Download PNG',
          onclick: async () => download(await qrPngBlob(url), `qr-${name}.png`)
        }),
        el('button', {
          class: 'button button--secondary button--small', type: 'button', text: 'Download SVG',
          onclick: () => download(new Blob([svg], { type: 'image/svg+xml' }), `qr-${name}.svg`)
        })
      ])
    );
  });

  const created = new Date(row.created_at).toLocaleDateString();
  return el('li', { class: 'artwork' }, [
    thumbUrl
      ? el('img', { class: 'artwork__thumb', src: thumbUrl, alt: '', loading: 'lazy' })
      : el('div', { class: 'artwork__thumb', 'aria-hidden': 'true' }),
    el('div', {}, [
      el('h3', { class: 'artwork__title', text: row.title }),
      el('p', { class: 'artwork__meta' }, [
        el('span', { class: `badge ${row.active ? 'badge--on' : 'badge--off'}`, text: row.active ? 'Active' : 'Inactive' }),
        ` · ${row.loop ? 'Loops' : 'Plays once'} · Added ${created}`
      ]),
      el('div', { class: 'artwork__actions' }, [
        el('button', {
          class: 'button button--secondary button--small', type: 'button', text: 'Edit',
          'aria-label': `Edit ${row.title}`, onclick: () => startEdit(row)
        }),
        el('button', {
          class: 'button button--secondary button--small', type: 'button',
          text: row.active ? 'Deactivate' : 'Activate',
          'aria-label': `${row.active ? 'Deactivate' : 'Activate'} ${row.title}`,
          onclick: () => setActive(row, !row.active)
        }),
        el('button', {
          class: 'button button--danger button--small', type: 'button', text: 'Delete',
          'aria-label': `Delete ${row.title}`, onclick: () => deleteArtwork(row)
        })
      ]),
      qr
    ])
  ]);
}

async function setActive(row, active) {
  setStatus(els.listStatus, active ? 'Activating…' : 'Deactivating…');
  const { error } = await sb.from('artworks').update({ active }).eq('id', row.id);
  if (error) {
    setStatus(els.listStatus, `Could not update: ${error.message}`, 'error');
    return;
  }
  await loadArtworks();
}

async function deleteArtwork(row) {
  if (!confirm(`Delete “${row.title}”? Its files are removed and its QR code stops working. This cannot be undone.`)) return;
  setStatus(els.listStatus, 'Deleting…');
  const { error } = await sb.from('artworks').delete().eq('id', row.id);
  if (error) {
    setStatus(els.listStatus, `Could not delete: ${error.message}`, 'error');
    return;
  }
  await removeFiles([
    ['markers', row.marker_path],
    ['targets', row.target_path],
    ['videos', row.video_path]
  ]).catch((err) => console.warn('Files not removed', err));
  if (editing && editing.id === row.id) resetForm();
  await loadArtworks();
}

// ------------------------------------------------------------------ Init

async function init() {
  if (!config.supabaseUrl || config.supabaseUrl.includes('YOUR-PROJECT')) {
    els.bootStatus.textContent = 'Supabase is not configured yet. Edit js/config.js (see README).';
    return;
  }
  if (!window.supabase) {
    els.bootStatus.textContent = 'Could not load Supabase. Check your connection and reload.';
    return;
  }
  sb = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);

  els.loginForm.addEventListener('submit', onLogin);
  els.signOut.addEventListener('click', async () => {
    await sb.auth.signOut();
    resetForm();
    showSignedOut('');
  });
  els.marker.addEventListener('change', onMarkerChange);
  els.video.addEventListener('change', onVideoChange);
  els.form.addEventListener('submit', onSave);
  els.cancelEdit.addEventListener('click', () => {
    resetForm();
    setStatus(els.saveStatus, '');
  });

  const { data } = await sb.auth.getSession();
  if (data.session) showSignedIn(data.session);
  else showSignedOut('');
}

init();
