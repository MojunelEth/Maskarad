// Shared test helpers: starting the site, a client with cookies, a test video.
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const run = promisify(execFile);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function checker() {
  const state = { failures: 0 };
  state.check = (name, ok, detail = '') => {
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) state.failures += 1;
  };
  return state;
}

export async function makeTestVideo(file, { w = 1080, h = 1920, seconds = 12, audio = true } = {}) {
  const args = ['-hide_banner', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=30:duration=${seconds}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac', '-shortest');
  args.push(file);
  await run('ffmpeg', args);
  return file;
}

export async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  return JSON.parse(stdout);
}

export async function startSite(env) {
  const port = env.PORT ? Number(env.PORT) : 4300 + Math.floor(Math.random() * 1500);
  const base = `http://127.0.0.1:${port}`;
  let logs = '';
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), POLL_SECONDS: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => { logs += d; });
  proc.stderr.on('data', (d) => { logs += d; });
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      /* still starting */
    }
    await sleep(200);
  }
  return {
    base,
    logs: () => logs,
    stop: async () => {
      proc.kill('SIGTERM');
      await sleep(600);
    },
  };
}

/** A client that remembers the session cookie, like a browser. */
export class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
  }

  async call(method, p, { json, body, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    let payload = body;
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(json);
    }
    const res = await fetch(`${this.base}${p}`, { method, headers: h, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) {
      const pair = set.split(';')[0];
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json().catch(() => null) : Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: data, headers: res.headers };
  }

  get(p, opts) { return this.call('GET', p, opts); }

  post(p, json, opts = {}) { return this.call('POST', p, { ...opts, json }); }

  async register(email, password = 'password123') {
    return this.post('/api/auth/register', { email, password, agree: true });
  }

  async connectKey(key) {
    return this.post('/api/me/fal-key', { key });
  }

  async createJob(video, characterId, extraHeaders = {}) {
    return this.call('POST', '/api/jobs', {
      body: video,
      headers: { 'Content-Type': 'video/mp4', 'X-Character': encodeURIComponent(characterId), 'X-Consent': 'yes', ...extraHeaders },
    });
  }

  async waitJob(id, timeoutMs = 120000) {
    const seen = [];
    let view = null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(500);
      const r = await this.get(`/api/jobs/${id}`);
      view = r.body;
      const label = `${view?.stage}${view?.queuePosition ? `(${view.queuePosition})` : ''}`;
      if (seen[seen.length - 1] !== label) seen.push(label);
      if (['done', 'error'].includes(view?.stage)) break;
    }
    return { view, stages: seen };
  }

  async makeVideo(video, characterId) {
    const r = await this.createJob(video, characterId);
    if (r.status !== 202) return { status: r.status, view: r.body, stages: [] };
    const out = await this.waitJob(r.body.id);
    return { status: r.status, ...out };
  }
}
