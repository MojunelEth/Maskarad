// Accounts over time: admin panel, server restarts, migration from an older database, site rules.
// Run: node scripts/accounts-test.js (needs ffmpeg; no keys or internet needed)
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checker, makeTestVideo, startSite, Client } from './test-utils.js';
import { hashPassword } from '../src/auth.js';

const t = checker();
const { check } = t;
const ADMIN = 'admin-secret-token';
const KEY = 'demo-key-for-accounts-7777';

/** The database as the previous version of the site left it (with balances and payments). */
async function makeOldDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
      credits INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_login_at INTEGER);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE payments (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, credits INTEGER NOT NULL, amount REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD', provider TEXT NOT NULL, provider_ref TEXT, pack TEXT, note TEXT, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, paid_at INTEGER);
    CREATE TABLE renders (id TEXT PRIMARY KEY, user_id TEXT, character_id TEXT, character_name TEXT, status TEXT NOT NULL,
      error TEXT, result_path TEXT, charged INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, finished_at INTEGER);
    CREATE TABLE custom_characters (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
      image_path TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE character_generations (user_id TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE support_requests (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, topic TEXT, message TEXT NOT NULL,
      video_id TEXT, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL);
  `);
  db.prepare('INSERT INTO users (id, email, password, credits, created_at) VALUES (?, ?, ?, 3, ?)')
    .run('11111111-1111-1111-1111-111111111111', 'old@example.com', await hashPassword('oldpassword1'), Date.now());
  db.prepare("INSERT INTO payments (id, user_id, credits, amount, provider, status, created_at) VALUES ('p1', '11111111-1111-1111-1111-111111111111', 3, 7.99, 'stripe', 'paid', ?)").run(Date.now());
  db.close();
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'maskarad-accounts-'));
  const video = await fs.readFile(await makeTestVideo(path.join(tmp, 'input.mp4'), { seconds: 3 }));
  const dbPath = path.join(tmp, 'site.db');
  await makeOldDatabase(dbPath);
  const env = {
    PROVIDER: 'mock', FAL_KEY: '', ADMIN_TOKEN: ADMIN, PORT: String(4400 + Math.floor(Math.random() * 500)),
    DATA_DIR: path.join(tmp, 'data'), DB_PATH: dbPath, PHOTOS_DIR: path.join(tmp, 'photos'),
    OWNER_NAME: 'Ivan Testov', OWNER_EMAIL: 'owner@example.com',
  };
  let site = await startSite(env);
  const old = new Client(site.base);
  const user = new Client(site.base);
  const admin = (p, opts = {}) => new Client(site.base).call(opts.method || 'GET', p, { ...opts, headers: { Authorization: `Bearer ${ADMIN}`, ...(opts.headers || {}) } });
  let videoUrl = null;

  try {
    // Migration from the old database
    let r = await old.post('/api/auth/login', { email: 'old@example.com', password: 'oldpassword1' });
    check('an account from the old version signs in', r.status === 200 && r.body.user.falKey.connected === false, r.body?.error);
    r = await old.connectKey(KEY);
    check('and connects a fal.ai key', r.status === 200 && r.body.user.falKey.connected === true);

    // A regular user makes a video
    await user.register('user@example.com');
    await user.connectKey(KEY);
    const job = await user.makeVideo(video, 'lavinia');
    videoUrl = job.view?.videoUrl;
    check('the video is done', job.view?.stage === 'done', job.view?.error || '');
    await user.post('/api/support', { topic: 'falkey', message: 'I don\'t understand how much fal.ai charged' });

    // Admin panel
    check('nothing works without the admin token', (await new Client(site.base).get('/api/admin/stats')).status === 401);
    r = await admin('/api/admin/stats');
    const done = r.body.rendersTotal?.find((x) => x.status === 'done')?.n;
    check('admin overview', r.status === 200 && r.body.users === 2 && r.body.usersWithKey === 2 && done === 1 && r.body.openSupport === 1, JSON.stringify(r.body));
    r = await admin('/api/admin/user?email=user@example.com');
    check('the admin sees whether a key is connected, but not the key itself', r.status === 200 && r.body.user.falKey.connected && r.body.user.falKey.hint === '…7777' && !JSON.stringify(r.body).includes(KEY));
    check('and the user\'s videos', r.body.videos?.length === 1);
    r = await admin('/api/admin/support');
    const req = r.body.requests?.[0];
    check('the support message is visible in the admin panel', req?.email === 'user@example.com' && req.topic === 'falkey');
    r = await admin(`/api/admin/support/${req.id}/close`, { method: 'POST', json: {} });
    check('the support message can be closed', r.status === 200 && (await admin('/api/admin/stats')).body.openSupport === 0);
    check('the admin panel no longer has credits or payments', (await admin('/api/admin/credits', { method: 'POST', json: { email: 'user@example.com', credits: 3 } })).status === 404);
    r = await admin('/api/admin/password', { method: 'POST', json: { email: 'old@example.com' } });
    check('a temporary password is issued and old sessions are reset', r.status === 200 && (await old.get('/api/me')).body.user === null);
    const login = await new Client(site.base).post('/api/auth/login', { email: 'old@example.com', password: r.body.password });
    check('sign-in with the temporary password, the key is still there', login.status === 200 && login.body.user.falKey.connected === true);

    // Rules
    const terms = String((await user.get('/terms')).body);
    check('the rules are in English and know the owner, prices and fal.ai', terms.includes('Rules of the service') && terms.includes('Ivan Testov') && terms.includes('owner@example.com') && terms.includes('$1.20') && terms.includes('fal.ai') && !terms.includes('{{'));
    check('the rules mention no site payments', !/Stripe|NOWPayments|package/i.test(terms));
  } finally {
    await site.stop();
  }

  // Restart: sign-in, key and finished video are all still there
  site = await startSite(env);
  user.base = site.base;
  try {
    const me = (await user.get('/api/me')).body.user;
    check('after a restart, the sign-in and the key are still there', me?.email === 'user@example.com' && me.falKey.connected === true);
    check('the finished video is available after a restart', (await user.get(videoUrl)).status === 200);
  } finally {
    await site.stop();
  }

  // The encryption secret is gone (say, the disk was swapped): users are asked to paste the key again, and the site doesn't crash
  await fs.rm(path.join(tmp, 'key-secret'));
  site = await startSite({ ...env, OWNER_NAME: '', OWNER_EMAIL: '' });
  user.base = site.base;
  try {
    const me = (await user.get('/api/me')).body.user;
    check('without the secret, the key counts as lost', me?.falKey.connected === false && me.falKey.lost === true);
    const r = await user.post('/api/check', { characterId: 'lavinia', consent: true, size: 1000 });
    check('and a video asks to paste the key again', r.status === 402 && r.body.field === 'falKey');
    check('after pasting it again, everything works', (await user.connectKey(KEY)).body.user?.falKey.connected === true);
    const terms = String((await user.get('/terms')).body);
    check('the rules still work without owner details', terms.includes('the site administrator') && terms.includes('the Help tab') && !terms.includes('{{'));
  } finally {
    await site.stop();
    if (t.failures) console.log(`\nSite log:\n${site.logs()}`);
  }

  console.log(t.failures ? `\nFailed checks: ${t.failures}` : '\nAll checks passed');
  process.exit(t.failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
