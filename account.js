'use strict';

const $ = (id) => document.getElementById(id);
const STATUS = { done: 'Ready', failed: 'Failed', working: 'In progress' };

function empty(text) {
  return M.el('p', { class: 'list-empty', text });
}

function renderKey(me) {
  const fk = me.falKey || {};
  const cfg = M.config;
  const price = cfg?.pricing ? M.money(cfg.pricing.maxVideo) : '';
  if (fk.connected) {
    $('keyTitle').textContent = 'AI connected';
    $('keySub').textContent = `fal.ai key ${fk.hint}, saved ${M.formatDate(fk.savedAt)}. A video up to ${cfg?.maxSeconds || 10} seconds costs about ${price}, charged by fal.ai to your balance.`;
    $('keyButton').textContent = 'Replace key';
  } else {
    $('keyTitle').textContent = 'AI not connected';
    $('keySub').textContent = fk.lost
      ? 'Your saved key no longer works. Paste it again to make videos.'
      : `To make videos, paste your fal.ai key. A video up to ${cfg?.maxSeconds || 10} seconds costs about ${price} from your fal.ai balance. This site never receives your money.`;
    $('keyButton').textContent = 'Connect';
  }
  $('keyCard').classList.toggle('connected', Boolean(fk.connected));
  $('keyDelete').hidden = !fk.connected;
}

function renderVideos(videos) {
  const box = $('videos');
  box.textContent = '';
  if (!videos.length) {
    box.append(empty('No videos yet. Make your first one on the AI video tab.'));
    return;
  }
  for (const v of videos) {
    const actions = M.el('div', { class: 'list-actions' });
    if (v.url) {
      actions.append(M.el('a', { class: 'link-button', href: v.url, target: '_blank', rel: 'noopener', text: 'Watch' }));
      actions.append(M.el('a', { class: 'link-button', href: `${v.url}?download=1`, text: 'Download' }));
    } else if (v.status === 'done') {
      actions.append(M.el('span', { class: 'muted', text: 'Deleted from the server' }));
    } else if (v.status === 'failed') {
      actions.append(M.el('a', { class: 'link-button', href: `/help?topic=video&video=${v.id}`, text: 'Report a problem' }));
    }
    box.append(M.el('div', { class: 'list-row' },
      M.el('div', {},
        M.el('p', { class: 'list-title', text: v.character || 'Character' }),
        M.el('p', { class: 'list-sub', text: `${M.formatDate(v.createdAt)}. ${STATUS[v.status] || v.status}${v.status === 'failed' && v.error ? `: ${v.error}` : ''}` })),
      actions));
  }
}

function renderCharacters(list) {
  const box = $('characters');
  box.textContent = '';
  if (!list.length) {
    box.append(empty('No characters of your own yet.'));
    return;
  }
  for (const c of list) {
    const del = M.el('button', { type: 'button', class: 'link-button', text: 'Delete' });
    del.addEventListener('click', async () => {
      if (!window.confirm(`Delete ${c.name}? Their photo will be removed.`)) return;
      try {
        await M.api(`/api/characters/${c.id}`, { method: 'DELETE' });
        load();
      } catch (err) {
        window.alert(err.message);
      }
    });
    box.append(M.el('div', { class: 'my-character' },
      M.el('img', { src: c.image, alt: '', width: '120', height: '120', loading: 'lazy' }),
      M.el('div', {}, M.el('p', { class: 'list-title', text: c.name }), M.el('p', { class: 'list-sub', text: c.description }), del)));
  }
}

async function load() {
  const me = M.me;
  $('guest').hidden = Boolean(me);
  $('member').hidden = !me;
  if (!me) return;
  $('email').textContent = me.email;
  renderKey(me);
  try {
    const h = await M.api('/api/me/history');
    renderVideos(h.videos);
    renderCharacters(h.characters);
  } catch (err) {
    $('videos').textContent = err.message;
  }
}

$('loginButton').addEventListener('click', () => M.openAuth('login'));
$('registerButton').addEventListener('click', () => M.ensureKey());
$('logoutButton').addEventListener('click', async () => {
  await M.logout();
  load();
});
$('keyButton').addEventListener('click', () => M.openConnect());
$('keyDelete').addEventListener('click', async () => {
  if (!window.confirm('Remove your fal.ai key from this site? You won’t be able to make videos until you paste a key again.')) return;
  try {
    await M.api('/api/me/fal-key', { method: 'DELETE' });
    await M.refreshMe();
  } catch (err) {
    window.alert(err.message);
  }
});

$('passwordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('passwordStatus');
  status.textContent = '';
  try {
    await M.postJson('/api/me/password', { current: $('currentPassword').value, next: $('newPassword').value });
    $('currentPassword').value = '';
    $('newPassword').value = '';
    status.textContent = 'Password changed. You’ll need to sign in again on other devices.';
  } catch (err) {
    status.textContent = err.message;
  }
});

M.ready.then(() => {
  load();
  M.onUser(() => load());
  if (window.location.hash === '#key' && M.me && !M.me.falKey?.connected) M.openConnect();
});
