'use strict';

const $ = (id) => document.getElementById(id);
const KEY = 'maskarad-admin';
let token = '';
try {
  token = sessionStorage.getItem(KEY) || '';
} catch {
  /* ignore */
}

const TOPICS = { falkey: 'fal.ai key', payment: 'Payment', video: 'Video', account: 'Account', character: 'Character', other: 'Other' };
const date = (ms) => (ms ? new Date(ms).toLocaleString('en-US') : '—');

async function call(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || 'Server error');
  return data;
}

const post = (path, body) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function stat(value, label) {
  const d = node('div', 'stat');
  d.append(node('span', 'stat-value', value), node('span', 'stat-label', label));
  return d;
}

async function loadStats() {
  const s = await call('/api/admin/stats');
  const count = (rows, status) => rows.find((r) => r.status === status)?.n || 0;
  const box = $('stats');
  box.textContent = '';
  box.append(
    stat(String(s.users), `accounts in total, new in the last day: ${s.usersToday}`),
    stat(String(s.usersWithKey), 'connected a fal.ai key'),
    stat(String(count(s.rendersToday, 'done')), 'videos done in the last day'),
    stat(String(count(s.rendersTotal, 'done')), 'videos done in total'),
    stat(String(count(s.rendersTotal, 'failed')), 'failed videos in total'),
    stat(String(s.openSupport), 'open support messages'),
  );
}

async function loadSupport() {
  const { requests } = await call('/api/admin/support');
  const box = $('support');
  box.textContent = '';
  if (!requests.length) {
    box.append(node('p', 'list-empty', 'No messages.'));
    return;
  }
  for (const r of requests) {
    const row = node('div', `list-row support-row${r.status === 'open' ? '' : ' closed'}`);
    const main = node('div');
    main.append(
      node('p', 'list-title', `${TOPICS[r.topic] || 'Other'}: ${r.email || 'no email'}`),
      node('p', 'support-text', r.message),
      node('p', 'list-sub', `${date(r.created_at)}${r.video_id ? `. Video ${r.video_id.slice(0, 8)}` : ''}${r.status === 'open' ? '' : '. Closed'}`),
    );
    row.append(main);
    const actions = node('div', 'list-actions');
    if (r.email) {
      const a = node('a', 'link-button', 'Reply');
      a.href = `mailto:${r.email}?subject=${encodeURIComponent('Masquerade: reply to your message')}`;
      actions.append(a);
    }
    if (r.status === 'open') {
      const close = node('button', 'link-button', 'Close');
      close.type = 'button';
      close.addEventListener('click', async () => {
        await post(`/api/admin/support/${r.id}/close`, {});
        loadSupport();
        loadStats();
      });
      actions.append(close);
    }
    row.append(actions);
    box.append(row);
  }
}

let currentEmail = null;

async function loadUser(email) {
  const status = $('userStatus');
  status.textContent = '';
  try {
    const d = await call(`/api/admin/user?email=${encodeURIComponent(email)}`);
    currentEmail = d.user.email;
    const key = d.user.falKey?.connected ? `fal.ai key connected (${d.user.falKey.hint})` : 'no fal.ai key connected';
    $('userInfo').textContent = `${d.user.email}: ${key}, signed up ${date(d.user.createdAt)}, last sign-in ${date(d.user.lastLoginAt)}.`;
    const hist = $('userHistory');
    hist.textContent = '';
    for (const v of d.videos.slice(0, 10)) {
      const row = node('div', 'list-row');
      const main = node('div');
      main.append(node('p', 'list-title', `Video: ${v.character || '—'}`), node('p', 'list-sub', `${date(v.createdAt)}. ${v.status === 'done' ? 'done' : v.status === 'failed' ? `failed: ${v.error || ''}` : 'in progress'}. Number ${v.id.slice(0, 8)}`));
      row.append(main);
      hist.append(row);
    }
    $('userCard').hidden = false;
  } catch (err) {
    $('userCard').hidden = true;
    currentEmail = null;
    window.alert(err.message);
  }
}

async function enter() {
  await loadStats();
  await loadSupport();
  $('panel').hidden = false;
  $('loginForm').hidden = true;
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  token = $('token').value.trim();
  try {
    await enter();
    $('adminAlert').hidden = true;
    try {
      sessionStorage.setItem(KEY, token);
    } catch {
      /* ignore */
    }
  } catch (err) {
    $('adminAlert').textContent = err.message;
    $('adminAlert').hidden = false;
  }
});

$('userForm').addEventListener('submit', (e) => {
  e.preventDefault();
  loadUser($('userEmail').value.trim());
});

$('resetPassword').addEventListener('click', async () => {
  if (!currentEmail || !window.confirm(`Issue a temporary password for ${currentEmail}? The old one will stop working.`)) return;
  try {
    const r = await post('/api/admin/password', { email: currentEmail });
    $('userStatus').textContent = `Temporary password: ${r.password}. Send it to the user and ask them to change it on the Account tab.`;
  } catch (err) {
    $('userStatus').textContent = err.message;
  }
});

if (token) enter().catch(() => { $('loginForm').hidden = false; });
