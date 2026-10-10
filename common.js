'use strict';

// Shared by all tabs: server requests, the account, and the sign-in and AI connection (fal.ai key) windows.
window.M = (() => {
  const state = { me: null, config: null, listeners: [] };
  const FAL = {
    home: 'https://fal.ai/dashboard',
    billing: 'https://fal.ai/dashboard/billing',
    keys: 'https://fal.ai/dashboard/keys',
  };

  async function api(path, options = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...options });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* empty response */
    }
    if (!res.ok) {
      const err = new Error(data?.error || 'The server didn’t respond. Check your connection and try again.');
      err.status = res.status;
      err.field = data?.field;
      throw err;
    }
    return data;
  }

  const postJson = (path, body) => api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

  const money = (n) => `$${Number(n).toFixed(2)}`;
  const formatDate = (ms) => new Date(ms).toLocaleString('en-US', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c);
    return node;
  }

  const external = (href, text, cls = 'button button-ghost button-small') => el('a', { class: cls, href, target: '_blank', rel: 'noopener', text });

  // Small line icons. The markup is fixed here and never contains user data.
  const ICONS = {
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', name === 'check' ? '3' : '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name] || '';
    return svg;
  }

  /** Approximate fal.ai price of a video this long. */
  function videoCost(seconds) {
    const p = state.config?.pricing;
    if (!p) return null;
    const s = Math.min(Math.max(Number(seconds) || 0, 0), state.config.maxSeconds);
    if (p.per16Frames) return Math.ceil((s * p.fps) / 16) * p.per16Frames;
    return s <= 5 ? 0.2 : 0.4;
  }

  /* ---------- Header ---------- */

  function markTab() {
    const page = document.body.dataset.page;
    document.querySelectorAll('.tabs a[data-tab]').forEach((a) => {
      if (a.dataset.tab === page) a.setAttribute('aria-current', 'page');
    });
  }

  function renderBadge() {
    const badge = document.querySelector('[data-key-badge]');
    if (badge) {
      const show = Boolean(state.me && !state.me.falKey?.connected);
      badge.hidden = !show;
      if (show) badge.title = 'Connect the AI: paste your fal.ai key';
    }
    renderHeaderStatus();
  }

  /** The right side of the header: sign in, connect the AI, or a green "AI connected" light. */
  function renderHeaderStatus() {
    const slot = document.querySelector('[data-header-status]');
    if (!slot) return;
    slot.textContent = '';
    const me = state.me;
    const dot = () => el('span', { class: 'status-dot', 'aria-hidden': 'true' });
    if (!me) {
      slot.append(el('button', { type: 'button', class: 'button button-ghost button-small', text: 'Sign in', onclick: () => openAuth('login') }));
    } else if (!me.falKey?.connected) {
      slot.append(el('button', { type: 'button', class: 'status-pill warn', onclick: () => openConnect() }, dot(), 'Connect AI'));
    } else {
      slot.append(el('a', { class: 'status-pill', href: '/account', title: `fal.ai key ${me.falKey.hint}` }, dot(), 'AI connected'));
    }
  }

  async function loadConfig() {
    if (!state.config) state.config = await api('/api/config');
    return state.config;
  }

  function setMe(user) {
    state.me = user;
    renderBadge();
    state.listeners.forEach((f) => f(state.me));
  }

  async function refreshMe() {
    try {
      const r = await api('/api/me');
      setMe(r.user);
    } catch {
      setMe(null);
    }
    return state.me;
  }

  const onUser = (f) => state.listeners.push(f);

  async function logout() {
    await postJson('/api/auth/logout');
    setMe(null);
  }

  /* ---------- Sign-in and sign-up window ---------- */

  let authDialog = null;
  let authResolve = null;

  function buildAuthDialog() {
    const err = el('p', { class: 'alert', role: 'alert', hidden: true });
    const email = el('input', { type: 'email', id: 'authEmail', autocomplete: 'email', required: true });
    const password = el('input', { type: 'password', id: 'authPassword', autocomplete: 'current-password', required: true, minlength: '8' });
    const agree = el('input', { type: 'checkbox', id: 'authAgree' });
    const agreeRow = el('label', { class: 'check' }, agree, el('span', {},
      'I am 18 or older and accept the ', el('a', { href: '/terms', target: '_blank', text: 'rules' }),
      ' and the ', el('a', { href: '/privacy', target: '_blank', text: 'privacy policy' })));
    const submit = el('button', { type: 'submit', class: 'button button-bulb button-wide' });
    const switchBtn = el('button', { type: 'button', class: 'link-button' });
    const forgot = el('p', { class: 'dialog-note' }, 'Forgot your password? ', el('a', { href: '/help?topic=account', text: 'Write to us in Help' }), ' and we’ll send you a temporary one.');
    const title = el('h2', { id: 'authTitle' });
    const lead = el('p', { class: 'dialog-note dialog-lead' });

    const form = el('form', { class: 'dialog-inner', novalidate: true },
      el('p', { class: 'step', text: 'Account' }),
      title,
      lead,
      el('div', { class: 'field' }, el('label', { for: 'authEmail', text: 'Email' }), email),
      el('div', { class: 'field' }, el('label', { for: 'authPassword', text: 'Password' }), password),
      agreeRow,
      submit,
      err,
      el('p', { class: 'dialog-switch' }, switchBtn),
      forgot,
      el('button', { type: 'button', class: 'link-button dialog-close', text: 'Close', onclick: () => closeAuth(null) }));

    let mode = 'login';
    function setMode(m) {
      mode = m;
      const reg = m === 'register';
      title.textContent = reg ? 'Create an account' : 'Sign in';
      lead.textContent = reg ? 'Step 1 of 2. Next you’ll connect the AI (fal.ai), and then you can make videos.' : '';
      lead.hidden = !reg;
      submit.textContent = reg ? 'Create account' : 'Sign in';
      switchBtn.textContent = reg ? 'Already have an account? Sign in' : 'No account yet? Sign up';
      password.setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
      agreeRow.hidden = !reg;
      forgot.hidden = reg;
      err.hidden = true;
    }
    switchBtn.addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      submit.disabled = true;
      try {
        const r = await postJson(mode === 'register' ? '/api/auth/register' : '/api/auth/login', {
          email: email.value, password: password.value, agree: agree.checked,
        });
        password.value = '';
        setMe(r.user);
        closeAuth(state.me);
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      } finally {
        submit.disabled = false;
      }
    });

    const dialog = el('dialog', { class: 'dialog', 'aria-labelledby': 'authTitle' }, form);
    dialog.addEventListener('cancel', () => closeAuth(null));
    document.body.appendChild(dialog);
    return { dialog, setMode, email };
  }

  function openAuth(mode = 'login') {
    if (!authDialog) authDialog = buildAuthDialog();
    authDialog.setMode(mode);
    authDialog.dialog.showModal();
    authDialog.email.focus();
    return new Promise((resolve) => { authResolve = resolve; });
  }

  function closeAuth(user) {
    if (authDialog?.dialog.open) authDialog.dialog.close();
    if (authResolve) authResolve(user);
    authResolve = null;
  }

  /* ---------- "Connect the AI" window: the fal.ai key ---------- */

  let connectDialog = null;
  let connectResolve = null;

  function buildConnectDialog() {
    const cfg = state.config;
    const price = cfg?.pricing;
    const perVideo = price ? money(price.maxVideo) : '';
    const videosFor10 = price?.maxVideo ? Math.floor(10 / price.maxVideo) : null;
    const err = el('p', { class: 'alert', role: 'alert', hidden: true });
    const input = el('input', { type: 'password', id: 'falKeyInput', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste your whole fal.ai key' });
    const submit = el('button', { type: 'submit', class: 'button button-bulb button-wide', text: 'Save key' });
    const status = el('p', { class: 'dialog-note', 'aria-live': 'polite' });
    const current = el('p', { class: 'connect-current', hidden: true });

    const step = (n, title, text, action) => el('li', { class: 'connect-step' },
      el('span', { class: 'connect-num', 'aria-hidden': 'true', text: String(n) }),
      el('div', { class: 'connect-body' }, el('p', { class: 'connect-title', text: title }), text ? el('p', { class: 'connect-text', text }) : null),
      action ? el('div', { class: 'connect-actions' }, action) : null);

    const keyStep = el('li', { class: 'connect-step connect-step-key' },
      el('span', { class: 'connect-num', 'aria-hidden': 'true', text: '4' }),
      el('div', { class: 'connect-body' },
        el('label', { class: 'connect-title', for: 'falKeyInput', text: 'Paste the key here' }),
        el('div', { class: 'field connect-field' }, input),
        err));

    const form = el('form', { class: 'dialog-inner', novalidate: true },
      el('p', { class: 'step', text: 'fal.ai key' }),
      el('h2', { id: 'connectTitle', text: 'Connect the AI' }),
      el('p', { class: 'dialog-note dialog-lead', text: `Videos are made by AI on fal.ai, and you pay fal.ai directly: about ${perVideo} per video up to ${cfg?.maxSeconds || 10} seconds and ${price ? money(price.character) : ''} per custom character. This site never receives your money.` }),
      current,
      el('ol', { class: 'connect-steps' },
        step(1, 'Sign up on fal.ai', 'It’s free. fal.ai opens in a new tab, so keep this one open.', external(FAL.home, 'Open fal.ai')),
        step(2, 'Add credit', videosFor10 ? `$10 is enough to start: that’s about ${videosFor10} videos.` : null, external(FAL.billing, 'Add credit')),
        step(3, 'Create a key', 'Create Key → any name → scope API. Copy the key right away: fal.ai shows it only once.', external(FAL.keys, 'Create key')),
        keyStep),
      submit,
      status,
      el('p', { class: 'dialog-note', text: 'Your key is stored encrypted and used only for your own videos and characters. You can remove it on the Account tab, or revoke it completely on fal.ai under Keys.' }),
      cfg?.mode === 'mock' ? el('p', { class: 'dialog-note', text: 'Demo mode: the key isn’t checked, any text longer than 8 characters works.' }) : null,
      el('button', { type: 'button', class: 'link-button dialog-close', text: 'Later', onclick: () => closeConnect(false) }));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      submit.disabled = true;
      status.textContent = 'Checking the key with fal.ai…';
      try {
        const r = await postJson('/api/me/fal-key', { key: input.value });
        input.value = '';
        setMe(r.user);
        closeConnect(true);
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        err.scrollIntoView({ block: 'nearest' });
        if (ex.status === 401) closeConnect(false);
      } finally {
        submit.disabled = false;
        status.textContent = '';
      }
    });

    const dialog = el('dialog', { class: 'dialog dialog-wide', 'aria-labelledby': 'connectTitle' }, form);
    dialog.addEventListener('cancel', () => closeConnect(false));
    document.body.appendChild(dialog);
    return { dialog, input, err, current };
  }

  async function openConnect({ message = '' } = {}) {
    await loadConfig().catch(() => {});
    if (!state.me) {
      const user = await openAuth('register');
      if (!user) return false;
    }
    if (!connectDialog) connectDialog = buildConnectDialog();
    const fk = state.me.falKey || {};
    connectDialog.current.hidden = !(fk.connected || fk.lost || message);
    connectDialog.current.textContent = message
      || (fk.connected ? `Key ${fk.hint} is connected now. A new key will replace it.` : 'Your saved key no longer works. Please paste it again.');
    connectDialog.err.hidden = true;
    connectDialog.dialog.showModal();
    connectDialog.dialog.scrollTop = 0;
    // On phones, don't pop up the keyboard right away: first the person needs to visit fal.ai
    if (!window.matchMedia('(pointer: coarse)').matches) connectDialog.input.focus({ preventScroll: true });
    return new Promise((resolve) => { connectResolve = resolve; });
  }

  function closeConnect(ok) {
    if (connectDialog?.dialog.open) connectDialog.dialog.close();
    if (connectResolve) connectResolve(ok);
    connectResolve = null;
  }

  /** Everything needed before a video: an account and a fal.ai key. Newcomers see sign-up, then the connection window. */
  async function ensureKey() {
    if (!state.me) {
      const user = await openAuth('register');
      if (!user) return false;
    }
    if (state.me.falKey?.connected) return true;
    return openConnect();
  }

  /* ---------- Start ---------- */

  const ready = (async () => {
    markTab();
    try {
      await loadConfig();
    } catch {
      /* the page shows its own error */
    }
    await refreshMe();
  })();

  return {
    api, postJson, el, icon, money, formatDate, external, videoCost, loadConfig, refreshMe, onUser, logout,
    openAuth, openConnect, ensureKey, ready, FAL,
    get me() { return state.me; },
    get config() { return state.config; },
  };
})();
