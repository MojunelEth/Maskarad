// The full path in demo mode: accounts, fal.ai key, videos, custom characters, access rights, support messages.
// Run: node scripts/smoke-test.js (needs ffmpeg; no keys or internet needed)
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checker, makeTestVideo, probe, startSite, Client, sleep } from './test-utils.js';

const result = checker();
const { check } = result;
const KEY = 'demo-key-1234-abcd';

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'maskarad-smoke-'));
  const videoFile = await makeTestVideo(path.join(tmp, 'input.mp4'));
  const video = await fs.readFile(videoFile);
  const dbPath = path.join(tmp, 'test.db');
  const site = await startSite({
    PROVIDER: 'mock', FAL_KEY: '',
    DATA_DIR: path.join(tmp, 'data'), DB_PATH: dbPath, PHOTOS_DIR: path.join(tmp, 'photos'),
    MAX_SECONDS: '10', ADMIN_TOKEN: '',
  });
  const anna = new Client(site.base);
  const boris = new Client(site.base);

  try {
    const cfg = (await anna.get('/api/config')).body;
    check('settings are served', cfg.mode === 'mock' && cfg.characters.length === 7 && cfg.pricing?.maxVideo === 1.2 && cfg.pricing.character === 0.08 && cfg.resolution === '720p',
      JSON.stringify(cfg.pricing));
    const lavinia = cfg.characters.find((c) => c.id === 'lavinia');
    check('every ready-made character has a card picture', cfg.characters.every((c) => c.ready && /^\/characters\/[a-z0-9-]+\.jpg$/.test(c.image || '')));
    check('characters with a full sheet also get a hover picture and the "full look" window',
      cfg.characters.filter((c) => c.sheet).map((c) => c.id).join() === 'lavinia,barry,nigel,glenda,horace,winston,mervyn' && cfg.characters.filter((c) => c.sheet).every((c) => /-alt\.jpg$/.test(c.imageAlt || '')));
    const card = await anna.get(lavinia.image);
    const sheet = await anna.get(lavinia.sheet);
    check('the character pictures are served', card.status === 200 && card.headers.get('content-type') === 'image/jpeg' && sheet.status === 200);
    const font = await anna.get('/fonts/inter-400.woff');
    const home = await anna.get('/');
    const csp = home.headers.get('content-security-policy') || '';
    check('fonts come from the site itself', font.status === 200 && font.headers.get('content-type') === 'font/woff' && /font-src 'self'/.test(csp) && !/googleapis|gstatic/.test(csp + String(home.body)));
    check('settings have no site payments', !('payments' in cfg));
    for (const page of ['/', '/guide', '/account', '/help', '/terms', '/privacy']) {
      const r = await anna.get(page);
      check(`page ${page} opens in English`, r.status === 200 && String(r.body).includes('Masquerade') && String(r.body).includes('lang="en"'));
    }
    const old = await fetch(`${site.base}/refunds`, { redirect: 'manual' });
    check('the old refunds page redirects to the rules', old.status === 302 && old.headers.get('location') === '/terms');
    check('no access outside public', (await anna.get('/..%2Fserver.js')).status >= 400);

    // Sign-up and sign-in
    let r = await anna.post('/api/auth/register', { email: 'not-an-email', password: 'password123', agree: true });
    check('invalid email is rejected', r.status === 400 && r.body.field === 'email');
    r = await anna.post('/api/auth/register', { email: 'anna@example.com', password: '123', agree: true });
    check('short password is rejected', r.status === 400 && r.body.field === 'password');
    r = await anna.post('/api/auth/register', { email: 'anna@example.com', password: 'password123' });
    check('sign-up without accepting the rules is rejected', r.status === 400 && r.body.field === 'agree');
    r = await anna.register('Anna@Example.com');
    check('sign-up works and signs the user in', r.status === 201 && Boolean(anna.cookie) && r.body.user.email === 'anna@example.com');
    check('the AI is not connected right after sign-up', r.body.user.falKey?.connected === false);
    r = await new Client(site.base).register('anna@example.com');
    check('a second sign-up with the same email is rejected', r.status === 409);
    r = await new Client(site.base).post('/api/auth/login', { email: 'anna@example.com', password: 'wrong-pass' });
    check('wrong password is rejected', r.status === 401);
    const cookieHeader = (await new Client(site.base).register('test-cookie@example.com')).headers.get('set-cookie') || '';
    check('session cookie is HttpOnly and SameSite', /HttpOnly/.test(cookieHeader) && /SameSite=Lax/.test(cookieHeader));

    r = await anna.call('POST', '/api/check', { json: { characterId: 'lavinia', consent: true, size: 1000 }, headers: { Origin: 'https://evil.example' } });
    check('a request from another site is rejected', r.status === 403);
    r = await new Client(site.base).post('/api/check', { characterId: 'lavinia', consent: true, size: 1000 });
    check('no video without signing in', r.status === 401 && r.body.field === 'auth');
    r = await anna.post('/api/check', { characterId: 'lavinia', consent: true, size: 1000 });
    check('no video without a fal.ai key', r.status === 402 && r.body.field === 'falKey');

    // fal.ai key
    r = await anna.connectKey('abc');
    check('garbage instead of a key is rejected', r.status === 400 && r.body.field === 'falKey');
    r = await anna.connectKey(`  Key ${KEY}  `);
    check('the key is saved (extra "Key" and spaces are stripped)', r.status === 200 && r.body.user.falKey.connected === true && r.body.user.falKey.hint === '…abcd');
    const me = await anna.get('/api/me');
    check('the full key is never sent back', !JSON.stringify(me.body).includes(KEY) && me.body.user.falKey.hint === '…abcd');
    await sleep(300);
    const dbBytes = Buffer.concat(await Promise.all([dbPath, `${dbPath}-wal`].map((f) => fs.readFile(f).catch(() => Buffer.alloc(0)))));
    check('the key is stored only encrypted in the database', !dbBytes.includes(Buffer.from(KEY)));

    r = await anna.post('/api/check', { characterId: 'lavinia', consent: false, size: 1000 });
    check('no consent is rejected', r.status === 400 && r.body.field === 'consent');
    r = await anna.post('/api/check', { characterId: 'nobody', consent: true, size: 1000 });
    check('unknown character is rejected', r.status === 400);
    r = await anna.post('/api/check', { characterId: 'lavinia', consent: true, size: 500 * 1024 * 1024 });
    check('too large a file is rejected', r.status === 413);

    // Videos
    r = await new Client(site.base).createJob(video, 'lavinia');
    check('upload without signing in is rejected', r.status === 401);
    r = await anna.createJob(video, 'lavinia');
    check('the video is accepted', r.status === 202, r.status === 202 ? '' : JSON.stringify(r.body));
    const busy = await anna.post('/api/check', { characterId: 'lavinia', consent: true, size: 1000 });
    check('a second video cannot start while the first is in progress', busy.status === 409);
    const first = await anna.waitJob(r.body.id);
    check('the video is done', first.view?.stage === 'done', `stages: ${first.stages.join(' → ')}${first.view?.error ? `; ${first.view.error}` : ''}`);
    check('a long video is trimmed', first.view?.trimmed === true);
    const fileUrl = first.view?.videoUrl;
    r = await anna.get(`${fileUrl}?download=1`);
    check('download returns the file', r.status === 200 && /attachment/.test(r.headers.get('content-disposition') || ''));
    const out = path.join(tmp, 'result.mp4');
    await fs.writeFile(out, r.body);
    const info = await probe(out);
    const v = info.streams.find((s) => s.codec_type === 'video');
    check('the video has sound, is 720×1280 and at most 10 s', Boolean(info.streams.find((s) => s.codec_type === 'audio')) && v.width === 720 && v.height === 1280 && Number(info.format.duration) <= 10.2);
    const comment = info.format.tags?.comment || '';
    check('no watermark brand: the file is only marked as AI-made in its metadata', /AI-generated/.test(comment) && !/Masquerade/i.test(comment), comment);
    r = await anna.call('GET', fileUrl, { headers: { Range: 'bytes=0-99' } });
    check('seeking (Range) works', r.status === 206 && r.body.length === 100);
    const jobView = await anna.get(`/api/jobs/${first.view.id}`);
    check('the job view has no key', !JSON.stringify(jobView.body).includes(KEY));

    // A 3:4 video keeps its whole picture: nothing is cropped off the sides
    const video34 = await fs.readFile(await makeTestVideo(path.join(tmp, 'input34.mp4'), { w: 480, h: 640, seconds: 3 }));
    const job34 = await anna.makeVideo(video34, 'lavinia');
    r = await anna.get(job34.view?.videoUrl || '/none');
    const out34 = path.join(tmp, 'result34.mp4');
    await fs.writeFile(out34, r.body);
    const v34 = (await probe(out34)).streams.find((s) => s.codec_type === 'video');
    check('a 3:4 video comes back 3:4, with the whole picture', job34.view?.stage === 'done' && v34?.width === 720 && v34?.height === 960, `${v34?.width}×${v34?.height}`);

    await boris.register('boris@example.com');
    check('someone else\'s video cannot be opened', (await boris.get(fileUrl)).status === 404 && (await boris.get(`/api/jobs/${first.view.id}`)).status === 404);

    // Custom character
    r = await anna.post('/api/characters', { name: 'Ребёнок', description: 'маленький ребёнок лет восьми в школьной форме' });
    check('a child description is rejected (Russian)', r.status === 400);
    r = await anna.post('/api/characters', { name: 'Kid', description: 'a 12-year-old boy in a school uniform with a backpack' });
    check('a child description is rejected (English)', r.status === 400 && /fictional adult/.test(r.body.error || ''), r.body?.error);
    const desc = { name: 'Captain', description: 'a man in his forties with a red beard, a yellow raincoat and round glasses' };
    r = await boris.post('/api/characters', desc);
    check('no custom character without a key', r.status === 402 && r.body.field === 'falKey');
    r = await anna.post('/api/characters', desc);
    const mine = r.body?.character;
    check('the custom character is drawn', r.status === 201 && /^u-/.test(mine?.id || ''), r.body?.error || '');
    const list = (await anna.get('/api/characters')).body;
    check('the custom character is in the owner\'s list', list.mine.length === 1 && list.mine[0].id === mine.id);
    check('others cannot see the custom character', (await boris.get('/api/characters')).body.mine.length === 0);
    check('the character picture is for the owner only', (await anna.get(mine.image)).status === 200 && (await boris.get(mine.image)).status === 404);
    await boris.connectKey('boris-key-9999');
    r = await boris.post('/api/check', { characterId: mine.id, consent: true, size: 1000 });
    check('no video with someone else\'s character', r.status === 400);
    const second = await anna.makeVideo(video, mine.id);
    check('a video with the custom character is done', second.view?.stage === 'done', second.view?.error || '');

    const hist = (await anna.get('/api/me/history')).body;
    check('the account shows video history and characters', hist.videos.length === 3 && hist.videos.every((x) => x.url) && hist.characters.length === 1 && !('payments' in hist));
    r = await anna.call('DELETE', `/api/characters/${mine.id}`);
    check('the character can be deleted', r.status === 200 && (await anna.get('/api/characters')).body.mine.length === 0);

    // The key can be removed
    r = await anna.call('DELETE', '/api/me/fal-key');
    check('the key is removed', r.status === 200 && r.body.user.falKey.connected === false);
    r = await anna.post('/api/check', { characterId: 'lavinia', consent: true, size: 1000 });
    check('no video after removing the key', r.status === 402 && r.body.field === 'falKey');

    // Password and sign-out
    r = await anna.post('/api/me/password', { current: 'wrong', next: 'newpassword1' });
    check('password change without the right current password is rejected', r.status === 400);
    r = await anna.post('/api/me/password', { current: 'password123', next: 'newpassword1' });
    check('password changed, session kept', r.status === 200 && (await anna.get('/api/me')).body.user?.email === 'anna@example.com');
    r = await new Client(site.base).post('/api/auth/login', { email: 'anna@example.com', password: 'newpassword1' });
    check('sign-in with the new password', r.status === 200);
    await anna.post('/api/auth/logout', {});
    check('sign-out works', (await anna.get('/api/me')).body.user === null);

    // Help
    r = await anna.post('/api/support', { topic: 'falkey', message: 'I can\'t paste my key, please help' });
    check('a message without signing in needs an email', r.status === 400 && r.body.field === 'email');
    r = await anna.post('/api/support', { topic: 'video', message: 'My video failed, please help', email: 'anna@example.com', videoId: first.view.id });
    check('the message is accepted', r.status === 201);
    check('the key never reaches the server log', !site.logs().includes(KEY));
  } finally {
    await site.stop();
    if (result.failures) console.log(`\nSite log:\n${site.logs()}`);
  }
  console.log(result.failures ? `\nFailed checks: ${result.failures}` : '\nAll checks passed');
  process.exit(result.failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
