'use strict';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search);
const videoId = /^[0-9a-f-]{36}$/.test(params.get('video') || '') ? params.get('video') : null;

if (params.get('topic')) $('topic').value = params.get('topic');
if (videoId) {
  $('videoNote').textContent = `We’ll attach video number ${videoId.slice(0, 8)} so we can find it faster.`;
  $('videoNote').hidden = false;
  const faq = document.getElementById('faq-video');
  if (faq) faq.open = true;
}

function syncUser() {
  $('emailField').hidden = Boolean(M.me);
}

$('supportForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('supportStatus');
  status.textContent = '';
  try {
    await M.postJson('/api/support', {
      topic: $('topic').value,
      email: $('supportEmail').value,
      message: $('message').value,
      videoId,
    });
    $('message').value = '';
    status.textContent = 'Message sent. We’ll reply by email, usually within a day.';
  } catch (err) {
    status.textContent = err.message;
  }
});

M.ready.then(() => {
  const cfg = M.config;
  if (cfg) {
    document.querySelectorAll('[data-keep-hours]').forEach((n) => { n.textContent = cfg.keepHours; });
    document.querySelectorAll('[data-max-chars]').forEach((n) => { n.textContent = cfg.limits.maxCustomCharacters; });
    document.querySelectorAll('[data-max-seconds]').forEach((n) => { n.textContent = cfg.maxSeconds; });
    document.querySelectorAll('[data-video-price]').forEach((n) => { n.textContent = M.money(cfg.pricing.maxVideo); });
    document.querySelectorAll('[data-char-price]').forEach((n) => { n.textContent = M.money(cfg.pricing.character); });
    if (cfg.owner?.email) {
      const mail = $('ownerMail');
      mail.textContent = 'Or email us: ';
      mail.append(M.el('a', { href: `mailto:${cfg.owner.email}`, text: cfg.owner.email }));
      mail.hidden = false;
    }
  }
  syncUser();
  M.onUser(syncUser);
});
