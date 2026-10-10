'use strict';

// The AI video tab: character, video upload, generation, result.
const $ = (id) => document.getElementById(id);

const els = {
  demoBanner: $('demoBanner'),
  mirror: $('mirror'),
  bulbs: $('bulbs'),
  dropzone: $('dropzone'),
  emptyView: $('emptyView'),
  limitsHint: $('limitsHint'),
  fileInput: $('fileInput'),
  preview: $('preview'),
  result: $('result'),
  progressView: $('progressView'),
  progressStage: $('progressStage'),
  progressTime: $('progressTime'),
  previewActions: $('previewActions'),
  fileName: $('fileName'),
  resultActions: $('resultActions'),
  downloadLink: $('downloadLink'),
  againButton: $('againButton'),
  resultNote: $('resultNote'),
  cast: $('cast'),
  form: $('launchForm'),
  consent: $('consent'),
  keyLine: $('keyLine'),
  keyText: $('keyText'),
  keyButton: $('keyButton'),
  createButton: $('createButton'),
  helper: $('helper'),
  alert: $('alert'),
  charDialog: $('charDialog'),
  charForm: $('charForm'),
  charName: $('charName'),
  charDesc: $('charDesc'),
  charExample: $('charExample'),
  charSubmit: $('charSubmit'),
  charStatus: $('charStatus'),
  charAlert: $('charAlert'),
  charClose: $('charClose'),
  vfLabel: $('vfLabel'),
  vfSpec: $('vfSpec'),
  sheetDialog: $('sheetDialog'),
  sheetImage: $('sheetImage'),
  sheetTitle: $('sheetTitle'),
  sheetTagline: $('sheetTagline'),
  sheetGesture: $('sheetGesture'),
  sheetChoose: $('sheetChoose'),
  sheetClose: $('sheetClose'),
};

// What the viewfinder's corner label says in each state.
const VIEW_LABEL = { empty: 'Standby', preview: 'Input', progress: 'AI · rendering', result: 'Output' };

const STAGE_TEXT = {
  uploading: 'Uploading your video',
  preparing: 'Preparing the frames',
  sending: 'Sending the video to the AI',
  queued: 'Waiting in line',
  generating: 'The AI is putting on your costume',
  finishing: 'Putting your sound back',
  done: 'Done',
};

// What share of the bulbs to light at each stage.
const STAGE_RANGE = {
  uploading: [0, 0.14],
  preparing: [0.14, 0.2],
  sending: [0.2, 0.28],
  queued: [0.28, 0.36],
  generating: [0.36, 0.9],
  finishing: [0.9, 0.97],
  done: [1, 1],
};

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|avi|mkv|3gp)$/i;
const SESSION_KEY = 'maskarad-job';
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const EXAMPLES = [
  'a man in his forties with a perfectly groomed red beard, a bright yellow raincoat over a sharp suit, round glasses and a huge walking-stick umbrella',
  'a woman around thirty with a short platinum haircut, a shiny turquoise tracksuit and chunky gold hoop earrings',
  'an elderly man with bushy grey eyebrows, a mustard checked blazer, a red bow tie, white sneakers and a pocket watch on a chain',
];

const state = {
  config: null,
  characters: [],
  characterId: null,
  file: null,
  previewUrl: null,
  busy: false,
  jobId: null,
  pollTimer: null,
  tickTimer: null,
  stage: null,
  stageSince: 0,
  queuePosition: null,
  elapsedBase: 0,
  elapsedAt: 0,
  uploadShare: 0,
  duration: null,
};

const hasKey = () => Boolean(M.me?.falKey?.connected);

/* ---------- Progress bar: segments along the bottom of the viewfinder ---------- */

const bulbs = [];
const SEGMENTS = 32;

function buildBulbs() {
  for (let i = 0; i < SEGMENTS; i += 1) {
    const b = document.createElement('span');
    b.className = 'bulb';
    els.bulbs.appendChild(b);
    bulbs.push(b);
  }
}

function setBulbs(share, { pulse = false } = {}) {
  const lit = Math.round(Math.min(1, Math.max(0, share)) * bulbs.length);
  bulbs.forEach((b, i) => {
    b.classList.toggle('on', i < lit);
    b.classList.toggle('current', pulse && !reduceMotion && i === lit && lit < bulbs.length);
  });
}

function stageShare(stage, sinceMs) {
  const [from, to] = STAGE_RANGE[stage] || [0, 0];
  if (stage === 'uploading') return from + (to - from) * state.uploadShare;
  if (stage === 'generating' || stage === 'queued') {
    const t = sinceMs / 1000;
    return from + (to - from) * (1 - Math.exp(-t / (stage === 'generating' ? 150 : 60)));
  }
  return from + (to - from) * 0.5;
}

/* ---------- Mirror view ---------- */

function showMirror(mode) {
  els.mirror.dataset.state = mode;
  els.vfLabel.textContent = VIEW_LABEL[mode] || '';
  els.emptyView.hidden = mode !== 'empty';
  els.preview.hidden = !(mode === 'preview' || mode === 'progress');
  els.result.hidden = mode !== 'result';
  els.progressView.hidden = mode !== 'progress';
  els.previewActions.hidden = mode !== 'preview';
  els.resultActions.hidden = mode !== 'result';
  const note = $('glassNote');
  if (note) note.remove();
}

function showGlassNote(text) {
  const old = $('glassNote');
  if (old) old.remove();
  els.dropzone.appendChild(M.el('p', { class: 'glass-note', id: 'glassNote', text }));
}

function formatTime(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderProgress() {
  const stage = state.stage;
  if (!stage) return;
  let text = STAGE_TEXT[stage] || 'Working';
  if (stage === 'uploading') text += `: ${Math.round(state.uploadShare * 100)}%`;
  if (stage === 'queued' && Number.isFinite(state.queuePosition) && state.queuePosition > 0) text += `, ${state.queuePosition} ahead of you`;
  els.progressStage.textContent = text;
  const elapsed = state.elapsedAt ? state.elapsedBase + (Date.now() - state.elapsedAt) / 1000 : 0;
  let hint = elapsed ? `Elapsed ${formatTime(elapsed)}` : '';
  if (stage === 'generating') hint += '. This usually takes a few minutes. You can keep this page open or come back later';
  els.progressTime.textContent = hint;
  setBulbs(stageShare(stage, Date.now() - state.stageSince), { pulse: stage !== 'done' });
}

function setStage(stage, extra = {}) {
  if (stage !== state.stage) {
    state.stage = stage;
    state.stageSince = Date.now();
  }
  if ('queuePosition' in extra) state.queuePosition = extra.queuePosition;
  if (Number.isFinite(extra.elapsedSec)) {
    state.elapsedBase = extra.elapsedSec;
    state.elapsedAt = Date.now();
  }
  renderProgress();
}

/* ---------- Messages ---------- */

/** Helper buttons under an error: top up fal.ai, check the key, report a problem. */
function errorActions(kind, videoId) {
  const actions = [];
  if (kind === 'balance') actions.push(M.external(M.FAL.billing, 'Top up fal.ai', 'link-button'));
  if (kind === 'key' || kind === 'falKey') {
    actions.push(M.el('button', { type: 'button', class: 'link-button', text: 'Connect key', onclick: () => M.openConnect() }));
  }
  if (videoId) actions.push(M.el('a', { class: 'link-button', href: `/help?topic=video&video=${videoId}`, text: 'Report a problem' }));
  return actions;
}

function showAlert(text, { reportVideo = null, kind = null } = {}) {
  els.alert.textContent = text || '';
  if (text) {
    for (const a of errorActions(kind, reportVideo)) els.alert.append(' ', a);
  }
  els.alert.hidden = !text;
}

function clearInvalid() {
  els.consent.closest('.check').classList.remove('invalid');
}

function markInvalid(field) {
  if (field === 'consent') els.consent.closest('.check').classList.add('invalid');
}

function selectedCharacter() {
  return state.characters.find((c) => c.id === state.characterId) || null;
}

function updateHelper() {
  if (state.busy) {
    els.helper.textContent = 'Your video is in progress. If you refresh the page, we’ll pick up where we left off.';
    return;
  }
  const missing = [];
  if (!state.characterId) missing.push('choose a character');
  if (!state.file) missing.push('upload a video');
  if (!els.consent.checked) missing.push('tick the consent box');
  if (missing.length) {
    const t = missing.join(', ');
    els.helper.textContent = `${t.charAt(0).toUpperCase()}${t.slice(1)}.`;
    return;
  }
  if (!M.me) {
    els.helper.textContent = 'Last step: sign in and connect the AI. The windows open when you press the button.';
    return;
  }
  if (!hasKey()) {
    els.helper.textContent = 'Last step: connect the AI. The window opens when you press the button, and your video stays on the page.';
    return;
  }
  const parts = [];
  const cost = M.videoCost(state.duration ?? state.config.maxSeconds);
  if (cost !== null) parts.push(`fal.ai will charge your balance about ${M.money(cost)}.`);
  const c = selectedCharacter();
  if (c && !c.custom && !c.ready && state.config.mode === 'fal') {
    parts.push(`This is the first video with ${c.name}: before it, the AI prepares the character’s HD reference photo for about ${M.money(state.config.pricing.character)} more. It’s done once and then shared with everyone.`);
  }
  els.helper.textContent = parts.join(' ');
}

function renderKeyLine() {
  const me = M.me;
  els.keyLine.hidden = false;
  els.keyLine.classList.toggle('connected', hasKey());
  if (!me) {
    els.keyText.textContent = 'To make videos, sign in and connect the AI (fal.ai).';
    els.keyButton.textContent = 'Get started';
    els.keyButton.onclick = () => M.ensureKey();
  } else if (!hasKey()) {
    els.keyText.textContent = me.falKey?.lost
      ? 'Your saved fal.ai key no longer works. Please paste it again.'
      : 'Connect the AI: paste your fal.ai key. Videos are paid from your own fal.ai balance.';
    els.keyButton.textContent = 'Connect';
    els.keyButton.onclick = () => M.openConnect();
  } else {
    els.keyText.textContent = `AI connected: fal.ai key ${me.falKey.hint}.`;
    els.keyButton.textContent = 'Replace';
    els.keyButton.onclick = () => M.openConnect();
  }
  updateHelper();
}

function setBusy(busy) {
  state.busy = busy;
  els.createButton.disabled = busy;
  els.fileInput.disabled = busy;
  els.cast.querySelectorAll('input').forEach((i) => { i.disabled = busy; });
  els.cast.querySelectorAll('.tag').forEach((t) => t.classList.toggle('disabled', busy));
  els.sheetChoose.disabled = busy;
  updateHelper();
}

/* ---------- Characters ---------- */

function tagFor(c) {
  const input = M.el('input', { type: 'radio', name: 'character', value: c.id });
  const label = M.el('label', { class: 'tag', 'data-id': c.id }, input);
  input.addEventListener('change', () => selectCharacter(c.id));
  input.addEventListener('focus', () => label.classList.add('focused'));
  input.addEventListener('blur', () => label.classList.remove('focused'));

  const media = M.el('span', { class: 'tag-media' });
  if (c.image) media.append(M.el('img', { src: c.image, alt: '', loading: 'lazy', width: '300', height: '400' }));
  if (c.imageAlt) media.append(M.el('img', { class: 'tag-alt', src: c.imageAlt, alt: '', loading: 'lazy', width: '300', height: '400' }));
  label.append(media, M.el('span', { class: 'tag-check', 'aria-hidden': 'true' }, M.icon('check')));

  const info = M.el('span', { class: 'tag-info' });
  if (c.custom) info.append(M.el('span', { class: 'tag-badge', text: 'Mine' }));
  else if (c.preparing && state.config.mode === 'fal') info.append(M.el('span', { class: 'tag-badge', text: 'Preparing…' }));
  info.append(M.el('span', { class: 'tag-name', text: c.name }));
  if (c.tagline) info.append(M.el('span', { class: 'tag-line', text: c.tagline }));
  label.append(info);

  const item = M.el('div', { class: 'cast-item' }, label);
  if (c.sheet) {
    item.append(M.el('button', {
      type: 'button',
      class: 'tag-more',
      title: 'See the full look',
      'aria-label': `See ${c.name}’s full look`,
      onclick: () => openSheet(c),
    }, M.icon('expand')));
  }
  return item;
}

function renderCast() {
  els.cast.textContent = '';
  for (const c of state.characters) els.cast.appendChild(tagFor(c));
  const add = M.el('button', { type: 'button', class: 'tag tag-add', onclick: openCharacterDialog },
    M.el('span', { class: 'tag-add-plus', 'aria-hidden': 'true' }, M.icon('plus')),
    M.el('span', { class: 'tag-add-text' },
      M.el('span', { class: 'tag-name', text: 'Your own character' }),
      M.el('span', { class: 'tag-line', text: 'Describe a look and the AI draws a new face' })));
  els.cast.appendChild(add);
  if (state.characterId) selectCharacter(state.characterId);
}

/* ---------- Character sheet: the full look from every side ---------- */

let sheetCharacter = null;

function openSheet(c) {
  sheetCharacter = c;
  els.sheetImage.src = c.sheet;
  els.sheetImage.alt = `${c.name} from the front, side and back, plus close-ups`;
  els.sheetTitle.textContent = c.name;
  els.sheetTagline.textContent = c.tagline || '';
  els.sheetGesture.textContent = '';
  if (c.gesture) els.sheetGesture.append(M.el('strong', { text: 'Signature gesture' }), c.gesture);
  els.sheetGesture.hidden = !c.gesture;
  els.sheetChoose.textContent = `Play ${c.name}`;
  els.sheetChoose.disabled = state.busy;
  els.sheetDialog.showModal();
}

els.sheetClose.addEventListener('click', () => els.sheetDialog.close());
els.sheetDialog.addEventListener('click', (e) => {
  if (e.target === els.sheetDialog) els.sheetDialog.close();
});
els.sheetChoose.addEventListener('click', () => {
  if (sheetCharacter && !state.busy) selectCharacter(sheetCharacter.id);
  els.sheetDialog.close();
});

async function loadCharacters() {
  const r = await M.api('/api/characters');
  state.characters = [...r.mine, ...r.presets];
  if (state.characterId && !state.characters.some((c) => c.id === state.characterId)) state.characterId = null;
  renderCast();
}

function selectCharacter(id) {
  state.characterId = id;
  els.cast.querySelectorAll('.tag[data-id]').forEach((t) => t.classList.toggle('selected', t.dataset.id === id));
  const input = els.cast.querySelector(`input[value="${CSS.escape(id)}"]`);
  if (input) input.checked = true;
  updateHelper();
}

/* ---------- Custom character ---------- */

async function openCharacterDialog() {
  if (!(await M.ensureKey())) return;
  els.charAlert.hidden = true;
  els.charStatus.textContent = '';
  els.charDialog.showModal();
  els.charName.focus();
}

els.charClose.addEventListener('click', () => els.charDialog.close());
els.charExample.addEventListener('click', () => {
  els.charDesc.value = EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)];
});

els.charForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.charAlert.hidden = true;
  els.charSubmit.disabled = true;
  els.charStatus.textContent = 'Drawing your character, usually 10–40 seconds…';
  try {
    const r = await M.postJson('/api/characters', { name: els.charName.value, description: els.charDesc.value });
    await loadCharacters();
    selectCharacter(r.character.id);
    els.charDialog.close();
    els.charName.value = '';
    els.charDesc.value = '';
    els.helper.textContent = `${r.character.name} is ready and selected.`;
  } catch (err) {
    els.charAlert.textContent = err.message;
    if (err.field === 'falKey') {
      els.charAlert.append(' ', M.external(M.FAL.billing, 'fal.ai balance', 'link-button'), ' ',
        M.el('button', { type: 'button', class: 'link-button', text: 'Key', onclick: () => { els.charDialog.close(); M.openConnect(); } }));
    }
    els.charAlert.hidden = false;
  } finally {
    els.charSubmit.disabled = false;
    els.charStatus.textContent = '';
  }
});

/* ---------- File ---------- */

function acceptFile(file) {
  showAlert('');
  if (!file) return;
  const looksLikeVideo = (file.type && file.type.startsWith('video/')) || VIDEO_EXT.test(file.name);
  if (!looksLikeVideo) {
    showAlert('This isn’t a video. Use mp4, mov or webm.');
    return;
  }
  const maxMb = state.config?.maxUploadMb || 100;
  if (file.size > maxMb * 1024 * 1024) {
    showAlert(`The video is larger than ${maxMb} MB. Trim or compress it and try again.`);
    return;
  }
  state.file = file;
  state.duration = null;
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(file);
  els.preview.src = state.previewUrl;
  els.fileName.textContent = file.name;
  showMirror('preview');
  els.preview.play().catch(() => {});
  updateHelper();
}

els.preview.addEventListener('error', () => {
  if (els.mirror.dataset.state === 'preview') showGlassNote('This browser can’t preview this format, but you can still send the video.');
});

els.preview.addEventListener('loadedmetadata', () => {
  const max = state.config?.maxSeconds || 10;
  if (Number.isFinite(els.preview.duration)) state.duration = Math.min(els.preview.duration, max);
  if (els.preview.duration > max + 0.05) els.fileName.textContent = `${state.file?.name || 'Video'}: we’ll use the first ${max} s`;
  updateHelper();
});

els.fileInput.addEventListener('change', () => {
  acceptFile(els.fileInput.files[0]);
  els.fileInput.value = '';
});

['dragenter', 'dragover'].forEach((type) => {
  els.mirror.addEventListener(type, (e) => {
    if (state.busy) return;
    e.preventDefault();
    els.mirror.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((type) => {
  els.mirror.addEventListener(type, () => els.mirror.classList.remove('dragover'));
});
els.mirror.addEventListener('drop', (e) => {
  if (state.busy) return;
  e.preventDefault();
  acceptFile(e.dataTransfer?.files?.[0]);
});

/* ---------- Launch ---------- */

function upload(file, headers) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/jobs');
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      state.uploadShare = e.loaded / e.total;
      renderProgress();
    };
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data?.id) resolve(data);
      else {
        const err = new Error(data?.error || 'Couldn’t upload the video. Please try again.');
        err.field = data?.field;
        err.status = xhr.status;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error('The upload was interrupted. Check your connection and try again.'));
    xhr.send(file);
  });
}

els.consent.addEventListener('change', () => {
  clearInvalid();
  updateHelper();
});

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  // While the sign-in or connection window is open, a second click doesn't start a second video
  if (state.busy || state.submitting) return;
  state.submitting = true;
  try {
    await submitVideo();
  } finally {
    state.submitting = false;
  }
});

async function submitVideo() {
  showAlert('');
  clearInvalid();

  if (!state.characterId || !state.file || !els.consent.checked) {
    if (!els.consent.checked) markInvalid('consent');
    updateHelper();
    return;
  }
  if (!(await M.ensureKey())) {
    updateHelper();
    return;
  }

  setBusy(true);
  try {
    await M.postJson('/api/check', { characterId: state.characterId, consent: true, size: state.file.size });
    state.uploadShare = 0;
    state.elapsedBase = 0;
    state.elapsedAt = Date.now();
    showMirror('progress');
    setStage('uploading');
    const job = await upload(state.file, {
      'Content-Type': state.file.type || 'application/octet-stream',
      'X-Character': encodeURIComponent(state.characterId),
      'X-Consent': 'yes',
    });
    remember(job.id);
    applyJob(job);
    poll(job.id);
  } catch (err) {
    setBusy(false);
    showMirror(state.file ? 'preview' : 'empty');
    els.preview.play().catch(() => {});
    setBulbs(1);
    showAlert(err.message, { kind: err.field });
    markInvalid(err.field);
    if (err.field === 'falKey' || err.field === 'auth') M.refreshMe();
    if (err.field === 'falKey') M.openConnect({ message: err.message });
  }
}

/* ---------- Waiting for the result ---------- */

function remember(id) {
  state.jobId = id;
  try {
    sessionStorage.setItem(SESSION_KEY, id);
  } catch {
    /* private mode */
  }
}

function forget() {
  state.jobId = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

function stopTimers() {
  clearTimeout(state.pollTimer);
  clearInterval(state.tickTimer);
  state.pollTimer = null;
  state.tickTimer = null;
}

function applyJob(job) {
  if (job.stage === 'done') return showResult(job);
  if (job.stage === 'error') return showFailure(job.error, job.id, job.errorKind);
  if (els.mirror.dataset.state !== 'progress') showMirror('progress');
  setStage(job.stage, { queuePosition: job.queuePosition, elapsedSec: job.elapsedSec });
  if (!state.tickTimer) state.tickTimer = setInterval(renderProgress, 1000);
  return null;
}

function poll(id) {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(async () => {
    try {
      const job = await M.api(`/api/jobs/${id}`);
      applyJob(job);
      if (!['done', 'error'].includes(job.stage)) poll(id);
    } catch (err) {
      if (err.status === 404 || err.status === 401) {
        forget();
        showFailure(err.message);
      } else {
        poll(id);
      }
    }
  }, 3000);
}

function showResult(job) {
  stopTimers();
  forget();
  setBusy(false);
  state.stage = 'done';
  els.result.src = job.videoUrl;
  els.downloadLink.href = `${job.videoUrl}?download=1`;
  showMirror('result');
  setBulbs(1);
  const hours = Math.max(1, Math.round((job.keepMinutes || 60) / 60));
  const notes = [];
  if (job.trimmed) notes.push(`We used the first ${job.maxSeconds} seconds of your video.`);
  notes.push(`The video stays in your account for about ${hours} h, so download it.`);
  els.resultNote.textContent = notes.join(' ');
  els.result.play().catch(() => {});
  // A ready-made character's photo may have just been drawn: refresh the gallery
  loadCharacters().catch(() => {});
}

function showFailure(message, videoId = null, kind = null) {
  stopTimers();
  forget();
  setBusy(false);
  state.stage = null;
  showMirror(state.file ? 'preview' : 'empty');
  setBulbs(1);
  showAlert(message || 'Something went wrong. Please try again.', { reportVideo: videoId, kind });
  if (kind === 'key') M.refreshMe();
}

els.againButton.addEventListener('click', () => {
  els.result.pause();
  els.result.removeAttribute('src');
  els.result.load();
  state.file = null;
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  els.preview.removeAttribute('src');
  showMirror('empty');
  showAlert('');
  updateHelper();
});

/* ---------- Start ---------- */

async function init() {
  buildBulbs();
  await M.ready;
  state.config = M.config;
  if (!state.config) {
    showAlert('Couldn’t load the site settings. Please refresh the page.');
    return;
  }
  const cfg = state.config;
  if (window.matchMedia('(pointer: coarse)').matches) els.emptyView.querySelector('.glass-title').textContent = 'Add a video';
  els.demoBanner.hidden = cfg.mode !== 'mock';
  els.limitsHint.textContent = `Up to ${cfg.maxSeconds} seconds and ${cfg.maxUploadMb} MB. If it’s longer, we’ll use the beginning.`;
  els.vfSpec.textContent = [cfg.resolution, cfg.pricing?.fps ? `${cfg.pricing.fps} fps` : null].filter(Boolean).join(' · ');
  document.querySelectorAll('[data-video-price]').forEach((n) => { n.textContent = M.money(cfg.pricing.maxVideo); });
  document.querySelectorAll('[data-char-price]').forEach((n) => { n.textContent = M.money(cfg.pricing.character); });
  document.querySelectorAll('[data-max-seconds]').forEach((n) => { n.textContent = cfg.maxSeconds; });

  M.onUser(() => {
    renderKeyLine();
    loadCharacters().catch(() => {});
  });
  renderKeyLine();
  await loadCharacters().catch(() => showAlert('Couldn’t load the characters. Please refresh the page.'));
  if (window.location.hash === '#new-character') openCharacterDialog();

  // While ready-made characters' photos are being drawn, keep refreshing the gallery
  if (cfg.mode === 'fal' && cfg.characters.some((c) => c.preparing)) {
    const refresh = setInterval(async () => {
      if (state.busy) return;
      await loadCharacters().catch(() => {});
      if (!state.characters.some((c) => c.preparing)) clearInterval(refresh);
    }, 15000);
  }

  let saved = null;
  try {
    saved = sessionStorage.getItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
  if (saved && M.me) {
    state.jobId = saved;
    try {
      const job = await M.api(`/api/jobs/${saved}`);
      if (job.characterId) selectCharacter(job.characterId);
      if (!['done', 'error'].includes(job.stage)) {
        setBusy(true);
        showMirror('progress');
        poll(saved);
      }
      applyJob(job);
    } catch {
      forget();
    }
  }
}

init();
