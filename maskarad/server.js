import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config, validateConfig, MODELS, IMAGE_PRICE, estimateVideoCost } from './src/config.js';
import { log } from './src/log.js';
import { checkFfmpeg } from './src/media.js';
import { createStore } from './src/store.js';
import { createCharacterStore } from './src/characters.js';
import { createProvider } from './src/providers.js';
import { createJobManager } from './src/jobs.js';
import { createKeyBox, normalizeFalKey, keyHint } from './src/secrets.js';
import * as fal from './src/fal.js';
import * as auth from './src/auth.js';
import { HttpError, SECURITY_HEADERS, sendJson, sendError, sendFile, serveStatic, readJson, saveBody, clientIp } from './src/http.js';

validateConfig();

const store = createStore(config);
const keyBox = createKeyBox(config);
const characters = createCharacterStore(config, store);
let jobs;
const provider = createProvider(config, { publishFile: (file) => jobs.publishFile(file) });
jobs = createJobManager({ config, provider, store });

const MAX_BYTES = config.maxUploadMb * 1024 * 1024;
const SESSION_MS = config.sessionDays * 24 * 60 * 60 * 1000;
const PAGES = { '/guide': 'guide.html', '/account': 'account.html', '/help': 'help.html', '/admin': 'admin.html' };
const LEGAL_PAGES = { '/terms': 'terms.html', '/privacy': 'privacy.html' };
const authAttempts = auth.createAttemptLimiter({ max: 20, windowMs: 15 * 60 * 1000 });
const keyAttempts = auth.createAttemptLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
const supportAttempts = auth.createAttemptLimiter({ max: 6, windowMs: 60 * 60 * 1000 });
const NEED_KEY = 'Connect the AI first: paste your fal.ai key. Videos are paid from your own fal.ai balance.';

function sameSecret(given, expected) {
  const a = createHash('sha256').update(String(given || '')).digest();
  const b = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

function decodeHeader(value) {
  if (typeof value !== 'string') return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function forwardedProto(req) {
  return config.trustProxy && req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']).split(',')[0].trim() : null;
}

function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  return `${forwardedProto(req) || 'http'}://${req.headers.host}`;
}

const secureCookies = (req) => config.publicUrl.startsWith('https://') || forwardedProto(req) === 'https';

function currentUser(req) {
  if (req.user !== undefined) return req.user;
  const token = auth.readSessionToken(req);
  const session = token ? store.getSession(auth.hashToken(token)) : null;
  req.user = session ? store.getUser(session.user_id) : null;
  return req.user;
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) sendError(res, 401, 'Please sign in to continue.', { field: 'auth' });
  return user;
}

/** The user's fal.ai key in plain text (in server memory only), or null. */
function falKeyOf(user) {
  return user?.fal_key ? keyBox.open(user.fal_key) : null;
}

function userView(user) {
  const connected = Boolean(falKeyOf(user));
  return {
    email: user.email,
    createdAt: user.created_at,
    falKey: {
      connected,
      hint: connected ? user.fal_key_hint : null,
      savedAt: connected ? user.fal_key_at : null,
      // A key was saved but can no longer be decrypted: it has to be pasted again
      lost: Boolean(user.fal_key) && !connected,
    },
  };
}

async function startSession(req, res, user) {
  const token = auth.newToken();
  store.createSession(auth.hashToken(token), user.id, SESSION_MS);
  store.touchLogin(user.id);
  res.setHeader('Set-Cookie', auth.sessionCookie(token, { secure: secureCookies(req), maxAgeSec: Math.round(SESSION_MS / 1000) }));
}

/** Requests that change data are accepted only from our own site (protection against request forgery). */
function foreignOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

/** Shared checks for both the pre-check and the upload itself. */
async function validate(user, { characterId, consent, size }) {
  if (!(consent === true || consent === 'yes')) {
    return { status: 400, message: 'Please confirm that the video shows only you or people who agreed to it.', field: 'consent' };
  }
  const key = falKeyOf(user);
  if (!key) return { status: 402, message: NEED_KEY, field: 'falKey' };
  const character = await characters.resolve(characterId, user, key);
  if (!character) return { status: 400, message: 'Choose a character.', field: 'character' };
  if (Number.isFinite(size) && size > MAX_BYTES) {
    return { status: 413, message: `The video is larger than ${config.maxUploadMb} MB. Trim or compress it and try again.`, field: 'video' };
  }
  if (jobs.activeFor(user.id)) {
    return { status: 409, message: 'One of your videos is already being made. Wait for it to finish, then start the next one.' };
  }
  if (config.maxActiveJobs > 0 && jobs.activeCount() >= config.maxActiveJobs) {
    return { status: 503, message: 'The site is processing too many videos right now. Please try again in a couple of minutes.' };
  }
  return { ok: true, character, key };
}

async function handleCreateJob(req, res) {
  const lengthHeader = req.headers['content-length'];
  const size = lengthHeader === undefined ? NaN : Number(lengthHeader);
  const reject = (status, message, extra) => {
    sendError(res, status, message, extra);
    // Drain the body so the browser gets to see the response. Huge uploads are simply cut off.
    if (Number.isFinite(size) && size > MAX_BYTES * 2) req.destroy();
    else req.resume();
  };
  const user = currentUser(req);
  if (!user) return reject(401, 'Please sign in to continue.', { field: 'auth' });

  const characterId = decodeHeader(req.headers['x-character']);
  const result = await validate(user, { characterId, consent: decodeHeader(req.headers['x-consent']), size });
  if (!result.ok) return reject(result.status, result.message, { field: result.field });
  const type = String(req.headers['content-type'] || '');
  if (!/^video\//.test(type) && type !== 'application/octet-stream') return reject(415, 'Please upload a video file: mp4, mov or webm.', { field: 'video' });

  const job = await jobs.createJob({ userId: user.id, characterId, characterName: result.character.name, falKey: result.key });
  const uploadPath = path.join(job.dir, 'upload.bin');
  try {
    await saveBody(req, uploadPath, MAX_BYTES);
  } catch (e) {
    await jobs.discard(job);
    if (e.code === 'TOO_LARGE') return reject(413, `The video is larger than ${config.maxUploadMb} MB. Trim or compress it and try again.`, { field: 'video' });
    log.warn(`Upload interrupted: ${e.message}`);
    if (!res.headersSent) reject(400, 'The upload was interrupted. Please try again.');
    return;
  }
  sendJson(res, 202, jobs.view(job));
  jobs.run(job, uploadPath, result.character.refPath);
}

function renderView(r) {
  const fileAvailable = r.status === 'done' && jobs.fileExists(r.result_path);
  return {
    id: r.id,
    character: r.character_name,
    status: r.status,
    error: r.error,
    createdAt: r.created_at,
    url: fileAvailable ? `/api/videos/${r.id}/file` : null,
  };
}

function isAdmin(req) {
  if (!config.adminToken) return false;
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') && sameSecret(h.slice(7), config.adminToken);
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function renderLegal(req, res, file) {
  let html;
  try {
    html = await fsp.readFile(path.join(config.root, 'legal', file), 'utf8');
  } catch {
    return sendError(res, 404, 'Page not found');
  }
  const values = {
    OWNER_NAME: config.ownerName || 'the site administrator',
    CONTACT: config.ownerEmail ? `email ${config.ownerEmail} or the Help tab` : 'the Help tab',
    SITE_URL: baseUrl(req),
    KEEP_HOURS: String(Math.max(1, Math.round(config.keepResultsMinutes / 60))),
    MAX_SECONDS: String(config.maxSeconds),
    VIDEO_PRICE: `$${estimateVideoCost(config.maxSeconds).toFixed(2)}`,
    IMAGE_PRICE: `$${IMAGE_PRICE.toFixed(2)}`,
  };
  html = html.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => (key in values ? escapeHtml(values[key]) : m));
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}

async function body(req) {
  try {
    return await readJson(req);
  } catch (e) {
    throw new HttpError(e.status || 400, 'Invalid request');
  }
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const ip = clientIp(req, config.trustProxy);
  const method = req.method;

  if (p === '/healthz') return sendJson(res, 200, { ok: true });

  if (p.startsWith('/api/') && !['GET', 'HEAD'].includes(method) && foreignOrigin(req)) {
    return sendError(res, 403, 'This request came from another website');
  }

  if (p === '/api/config' && method === 'GET') {
    return sendJson(res, 200, {
      mode: config.provider,
      characters: characters.publicList(),
      resolution: config.resolution,
      maxSeconds: config.maxSeconds,
      maxUploadMb: config.maxUploadMb,
      keepHours: Math.max(1, Math.round(config.keepResultsMinutes / 60)),
      pricing: {
        // Approximate fal.ai prices: fal.ai charges the user's own balance
        maxVideo: estimateVideoCost(config.maxSeconds),
        per16Frames: MODELS[config.model].pricePer16Frames?.[config.resolution] || null,
        fps: config.inputFps,
        character: IMAGE_PRICE,
      },
      limits: { maxCustomCharacters: config.maxCustomCharacters, characterGenerationsPerDay: config.characterGenerationsPerDay },
      owner: { email: config.ownerEmail || null },
    });
  }

  // ---------- Account ----------

  if (p === '/api/me' && method === 'GET') {
    const user = currentUser(req);
    return sendJson(res, 200, { user: user ? userView(user) : null });
  }

  if (p === '/api/auth/register' && method === 'POST') {
    if (!authAttempts(ip)) return sendError(res, 429, 'Too many attempts. Please wait 15 minutes.');
    const b = await body(req);
    const email = auth.normalizeEmail(b.email);
    if (!email) return sendError(res, 400, 'Please check your email address.', { field: 'email' });
    const problem = auth.passwordProblem(b.password);
    if (problem) return sendError(res, 400, problem, { field: 'password' });
    if (b.agree !== true) return sendError(res, 400, 'Please confirm that you are 18 or older and accept the rules.', { field: 'agree' });
    if (store.getUserByEmail(email)) return sendError(res, 409, 'An account with this email already exists. Sign in, or ask for a new password in Help.', { field: 'email' });
    const user = store.createUser(email, await auth.hashPassword(b.password));
    await startSession(req, res, user);
    log.info(`New account: ${email}`);
    return sendJson(res, 201, { user: userView(user) });
  }

  if (p === '/api/auth/login' && method === 'POST') {
    if (!authAttempts(ip)) return sendError(res, 429, 'Too many attempts. Please wait 15 minutes.');
    const b = await body(req);
    const email = auth.normalizeEmail(b.email);
    const user = email ? store.getUserByEmail(email) : null;
    const ok = user ? await auth.verifyPassword(String(b.password || ''), user.password) : await auth.verifyPassword('x', 'scrypt$16384$8$1$AAAA$AAAA');
    if (!user || !ok) return sendError(res, 401, 'Wrong email or password.', { field: 'password' });
    await startSession(req, res, user);
    return sendJson(res, 200, { user: userView(store.getUser(user.id)) });
  }

  if (p === '/api/auth/logout' && method === 'POST') {
    const token = auth.readSessionToken(req);
    if (token) store.deleteSession(auth.hashToken(token));
    res.setHeader('Set-Cookie', auth.clearSessionCookie({ secure: secureCookies(req) }));
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/me/password' && method === 'POST') {
    const user = requireUser(req, res);
    if (!user) return;
    if (!authAttempts(ip)) return sendError(res, 429, 'Too many attempts. Please wait 15 minutes.');
    const b = await body(req);
    if (!(await auth.verifyPassword(String(b.current || ''), user.password))) return sendError(res, 400, 'Your current password is incorrect.', { field: 'current' });
    const problem = auth.passwordProblem(b.next);
    if (problem) return sendError(res, 400, problem, { field: 'next' });
    store.setPassword(user.id, await auth.hashPassword(b.next));
    store.deleteUserSessions(user.id);
    await startSession(req, res, user);
    return sendJson(res, 200, { ok: true });
  }

  // fal.ai key: stored encrypted, only the last 4 characters are ever sent out
  if (p === '/api/me/fal-key' && method === 'POST') {
    const user = requireUser(req, res);
    if (!user) return;
    if (!keyAttempts(user.id)) return sendError(res, 429, 'Too many attempts. Please wait 15 minutes.', { field: 'falKey' });
    const b = await body(req);
    const key = normalizeFalKey(b.key);
    if (!key) return sendError(res, 400, 'This doesn’t look like a fal.ai key. Copy the whole key right after you create it.', { field: 'falKey' });
    if (config.provider === 'fal') {
      let valid;
      try {
        valid = await fal.checkKey(key);
      } catch (e) {
        log.warn(`fal.ai key check failed: ${e.message}`);
        return sendError(res, 502, 'Couldn’t reach fal.ai to check the key. Please try again in a minute.', { field: 'falKey' });
      }
      if (!valid) return sendError(res, 400, 'fal.ai rejected this key. Create a new key on fal.ai and paste the whole key.', { field: 'falKey' });
    }
    store.setFalKey(user.id, keyBox.seal(key), keyHint(key));
    log.info(`User ${user.email} connected a fal.ai key`);
    return sendJson(res, 200, { user: userView(store.getUser(user.id)) });
  }

  if (p === '/api/me/fal-key' && method === 'DELETE') {
    const user = requireUser(req, res);
    if (!user) return;
    store.setFalKey(user.id, null, null);
    return sendJson(res, 200, { user: userView(store.getUser(user.id)) });
  }

  if (p === '/api/me/history' && method === 'GET') {
    const user = requireUser(req, res);
    if (!user) return;
    return sendJson(res, 200, {
      videos: store.rendersOf(user.id).map(renderView),
      characters: characters.customsOf(user),
    });
  }

  // ---------- Characters ----------

  if (p === '/api/characters' && method === 'GET') {
    return sendJson(res, 200, { presets: characters.publicList(), mine: characters.customsOf(currentUser(req)) });
  }

  if (p === '/api/characters' && method === 'POST') {
    const user = requireUser(req, res);
    if (!user) return;
    const b = await body(req);
    try {
      const character = await characters.createCustom({ user, name: b.name, description: b.description, key: falKeyOf(user) });
      return sendJson(res, 201, { character });
    } catch (e) {
      if (e instanceof characters.CharacterError) return sendError(res, e.status, e.message, { field: e.field });
      throw e;
    }
  }

  const charMatch = p.match(/^\/api\/characters\/(u-[0-9a-f-]{36})(\/image)?$/);
  if (charMatch) {
    const user = requireUser(req, res);
    if (!user) return;
    if (charMatch[2] && method === 'GET') {
      const c = characters.ownedCustom(charMatch[1], user);
      if (!c) return sendError(res, 404, 'Character not found');
      return sendFile(req, res, c.image_path, { cacheControl: 'private, max-age=86400' });
    }
    if (!charMatch[2] && method === 'DELETE') {
      if (!(await characters.deleteCustom(charMatch[1], user))) return sendError(res, 404, 'Character not found');
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---------- Videos ----------

  if (p === '/api/check' && method === 'POST') {
    const user = requireUser(req, res);
    if (!user) return;
    const b = await body(req);
    const result = await validate(user, { ...b, size: Number(b.size) });
    if (!result.ok) return sendError(res, result.status, result.message, { field: result.field });
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/jobs' && method === 'POST') return handleCreateJob(req, res);

  const jobMatch = p.match(/^\/api\/jobs\/([0-9a-f-]{36})$/);
  if (jobMatch && method === 'GET') {
    const user = requireUser(req, res);
    if (!user) return;
    const job = jobs.get(jobMatch[1]);
    if (job && job.userId === user.id) return sendJson(res, 200, jobs.view(job));
    const r = store.getRender(jobMatch[1]);
    if (!r || r.user_id !== user.id) return sendError(res, 404, 'This job was not found. Please upload the video again.');
    const v = renderView(r);
    return sendJson(res, 200, {
      id: r.id, stage: r.status === 'done' ? 'done' : r.status === 'failed' ? 'error' : 'generating',
      characterId: r.character_id, error: r.error, videoUrl: v.url, keepMinutes: config.keepResultsMinutes,
    });
  }

  const fileMatch = p.match(/^\/api\/videos\/([0-9a-f-]{36})\/file$/);
  if (fileMatch && (method === 'GET' || method === 'HEAD')) {
    const user = requireUser(req, res);
    if (!user) return;
    const r = store.getRender(fileMatch[1]);
    if (!r || r.user_id !== user.id || r.status !== 'done' || !jobs.fileExists(r.result_path)) {
      return sendError(res, 404, 'This video has already been deleted from the server or was not found.');
    }
    const download = url.searchParams.get('download') === '1';
    return sendFile(req, res, r.result_path, {
      cacheControl: 'private, max-age=600',
      downloadName: download ? `masquerade-${r.id.slice(0, 8)}.mp4` : null,
    });
  }

  // ---------- Help ----------

  if (p === '/api/support' && method === 'POST') {
    if (!supportAttempts(ip)) return sendError(res, 429, 'Too many messages. Please try again in an hour or email us.');
    const user = currentUser(req);
    const b = await body(req);
    const message = String(b.message || '').trim();
    if (message.length < 10) return sendError(res, 400, 'Please describe the problem in a bit more detail.', { field: 'message' });
    if (message.length > 4000) return sendError(res, 400, 'The message is too long.', { field: 'message' });
    const email = user ? user.email : auth.normalizeEmail(b.email);
    if (!email) return sendError(res, 400, 'Please enter your email so we can reply.', { field: 'email' });
    const topics = ['video', 'falkey', 'account', 'character', 'other'];
    const videoId = /^[0-9a-f-]{36}$/.test(b.videoId || '') ? b.videoId : null;
    store.createSupport({ userId: user?.id || null, email, topic: topics.includes(b.topic) ? b.topic : 'other', message, videoId });
    log.info(`New support message from ${email}`);
    return sendJson(res, 201, { ok: true });
  }

  // ---------- Admin ----------

  if (p.startsWith('/api/admin/')) {
    if (!config.adminToken) return sendError(res, 404, 'The admin panel is off: set ADMIN_TOKEN');
    if (!isAdmin(req)) return sendError(res, 401, 'Wrong admin token');
    if (p === '/api/admin/stats' && method === 'GET') {
      return sendJson(res, 200, { ...store.stats(), mode: config.provider, activeJobs: jobs.activeCount() });
    }
    if (p === '/api/admin/user' && method === 'GET') {
      const user = store.getUserByEmail(auth.normalizeEmail(url.searchParams.get('email')) || '');
      if (!user) return sendError(res, 404, 'User not found');
      const view = userView(user);
      return sendJson(res, 200, {
        user: { email: user.email, createdAt: user.created_at, lastLoginAt: user.last_login_at, falKey: view.falKey },
        videos: store.rendersOf(user.id, 50).map(renderView),
      });
    }
    if (p === '/api/admin/password' && method === 'POST') {
      const b = await body(req);
      const user = store.getUserByEmail(auth.normalizeEmail(b.email) || '');
      if (!user) return sendError(res, 404, 'User not found');
      const temp = auth.tempPassword();
      store.setPassword(user.id, await auth.hashPassword(temp));
      store.deleteUserSessions(user.id);
      log.info(`Admin: temporary password issued for ${user.email}`);
      return sendJson(res, 200, { email: user.email, password: temp });
    }
    if (p === '/api/admin/support' && method === 'GET') return sendJson(res, 200, { requests: store.supportList() });
    const closeMatch = p.match(/^\/api\/admin\/support\/([0-9a-f-]{36})\/close$/);
    if (closeMatch && method === 'POST') {
      store.closeSupport(closeMatch[1]);
      return sendJson(res, 200, { ok: true });
    }
    return sendError(res, 404, 'No such action');
  }

  // ---------- Pages and files ----------

  const photo = p.match(/^\/characters\/([a-z0-9-]{1,40})\.png$/);
  if (photo && (method === 'GET' || method === 'HEAD') && characters.get(photo[1]) && fs.existsSync(characters.photoPath(photo[1]))) {
    return sendFile(req, res, characters.photoPath(photo[1]), { cacheControl: 'public, max-age=3600' });
  }

  if (p.startsWith('/media/') && method === 'GET') {
    const file = jobs.resolvePublished(p.slice('/media/'.length));
    if (!file) return sendError(res, 404, 'File not found');
    return sendFile(req, res, file, { cacheControl: 'no-store' });
  }

  // Characters drawn by users are visible only to their owner (via /api/characters/u-…/image),
  // even if PHOTOS_DIR was set inside public by mistake
  if (path.posix.normalize(decodeHeader(p)).toLowerCase().startsWith('/characters/custom')) return sendError(res, 404, 'Not found');

  // Old addresses from the previous version of the site
  if (p === '/refunds' || p === '/paid.html') {
    res.writeHead(302, { Location: p === '/refunds' ? '/terms' : '/account' });
    return res.end();
  }

  if (LEGAL_PAGES[p] && method === 'GET') return renderLegal(req, res, LEGAL_PAGES[p]);
  if (PAGES[p] && (method === 'GET' || method === 'HEAD')) return serveStatic(req, res, config.publicDir, `/${PAGES[p]}`);
  if (method === 'GET' || method === 'HEAD') return serveStatic(req, res, config.publicDir, p);
  return sendError(res, 405, 'Method not allowed');
}

async function main() {
  try {
    await checkFfmpeg();
  } catch (e) {
    log.error('ffmpeg not found. Install it (the Docker image already has it):', e.message);
    process.exit(1);
  }
  await fsp.mkdir(config.dataDir, { recursive: true });
  await jobs.init();
  store.purgeSessions();

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      if (e instanceof HttpError) {
        if (!res.headersSent) sendError(res, e.status, e.message, { field: e.field });
        return;
      }
      log.error('Request handling error:', e);
      if (!res.headersSent) sendError(res, 500, 'Internal server error');
      else res.destroy();
    });
  });
  server.requestTimeout = 20 * 60 * 1000;

  server.listen(config.port, () => {
    const model = MODELS[config.model];
    log.info(`Masquerade is running: http://localhost:${config.port}`);
    if (config.provider === 'mock') {
      log.info('Mode: DEMO (PROVIDER=mock). The AI is not called; the character picture is placed over the video.');
    } else {
      log.info(`Mode: fal.ai paid with users' keys, model ${model.endpoint}, ${config.resolution}, ${config.inputFps} fps, up to ${config.maxSeconds} s (about $${estimateVideoCost(config.maxSeconds).toFixed(2)} per video)`);
      if (config.falKey) log.info('FAL_KEY is set: ready-made character photos are drawn at the site owner\'s expense');
    }
    log.info(`Database: ${config.dbPath}`);
    if (!config.adminToken) log.warn('ADMIN_TOKEN is not set: the /admin panel is off');
    characters.warmUp().catch((e) => log.error('Preparing characters:', e.message));
  });

  const stop = () => {
    log.info('Shutting down…');
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main();
