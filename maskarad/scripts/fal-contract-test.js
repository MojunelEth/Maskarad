// Tests the fal.ai integration without internet or money: a fake fal answers like the real one
// (queue + file storage) and accepts only its own keys. Every user pays with their own key.
// Run: node scripts/fal-contract-test.js
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { checker, makeTestVideo, probe, run, startSite, Client, ROOT, sleep } from './test-utils.js';

const t = checker();
const { check } = t;
const KEY_A = 'aaaaaaaa-1111:secret-of-anna-a1a1';
const KEY_B = 'bbbbbbbb-2222:secret-of-boris-b2b2';
const BROKE = 'cccccccc-3333:secret-without-money';
const OWNER = 'dddddddd-4444:owner-key-d4d4';
const KNOWN = new Set([KEY_A, KEY_B, BROKE, OWNER]);

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function startFakeFal(photoPng) {
  const files = new Map();
  const requests = new Map();
  const log = [];
  const control = { failNext: false, failSheets: false };
  const server = http.createServer(async (req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(req.url, base);
    const body = await readBody(req);
    const auth = req.headers.authorization || null;
    const key = auth?.startsWith('Key ') ? auth.slice(4) : null;
    const entry = { method: req.method, path: url.pathname, key, type: req.headers['content-type'] || null };
    log.push(entry);
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const authed = KNOWN.has(key);

    if (req.method === 'POST' && url.pathname === '/storage/upload/initiate') {
      if (!authed) return json(401, { detail: 'Invalid API key' });
      const { content_type: ct, file_name: name } = JSON.parse(body.toString());
      const id = randomUUID();
      files.set(id, { type: ct, name, data: null, key });
      entry.fileName = name;
      return json(200, { upload_url: `${base}/upload/${id}`, file_url: `${base}/files/${id}` });
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/upload/')) {
      const f = files.get(url.pathname.split('/')[2]);
      if (!f) return json(404, {});
      f.data = body;
      return json(200, {});
    }
    if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
      const f = files.get(url.pathname.split('/')[2]);
      if (!f?.data) return json(404, {});
      res.writeHead(200, { 'Content-Type': f.type });
      return res.end(f.data);
    }
    const m = url.pathname.match(/^\/(.+)\/requests\/([0-9a-f-]+)\/(status|response)$/);
    if (req.method === 'GET' && m) {
      if (!authed) return json(401, { detail: 'Invalid API key' });
      const r = requests.get(m[2]);
      if (!r) return json(404, { detail: 'no such request' });
      if (r.key !== key) return json(403, { detail: 'not your request' });
      if (r.fail) {
        if (m[3] === 'status') return json(200, { status: 'COMPLETED', request_id: r.id, error: 'Input video was flagged by the safety checker', error_type: 'content_policy_violation' });
        return json(422, { detail: [{ msg: 'flagged' }] });
      }
      if (m[3] === 'status') {
        r.polls += 1;
        if (r.polls === 1) return json(200, { status: 'IN_QUEUE', queue_position: 2, request_id: r.id });
        if (r.polls === 2) return json(200, { status: 'IN_PROGRESS', request_id: r.id });
        return json(200, { status: 'COMPLETED', request_id: r.id });
      }
      return json(200, r.output);
    }
    if (req.method === 'POST') {
      if (!authed) return json(401, { detail: 'Invalid API key' });
      if (key === BROKE) return json(402, { detail: 'User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing.' });
      const endpoint = url.pathname.slice(1);
      const input = JSON.parse(body.toString());
      entry.input = input;
      const id = randomUUID();
      let output;
      if (endpoint === 'fal-ai/nano-banana-2' || endpoint === 'fal-ai/nano-banana-2/edit') {
        if (control.failSheets && endpoint.endsWith('/edit')) return json(500, { detail: 'Internal server error' });
        const png = await fs.readFile(photoPng);
        const fid = randomUUID();
        files.set(fid, { type: 'image/png', name: 'out.png', data: png });
        output = { images: [{ url: `${base}/files/${fid}`, content_type: 'image/png' }], description: '' };
      } else if (endpoint === 'fal-ai/wan/v2.2-14b/animate/replace') {
        output = { video: { url: `${base}/files/${input.video_url.split('/files/')[1]}`, content_type: 'video/mp4' }, prompt: '', seed: 1 };
      } else {
        return json(404, { detail: `unknown endpoint ${endpoint}` });
      }
      const fail = control.failNext && !endpoint.startsWith('fal-ai/nano-banana-2');
      if (fail) control.failNext = false;
      requests.set(id, { id, polls: 0, output, fail, key });
      return json(200, {
        request_id: id,
        status_url: `${base}/${endpoint}/requests/${id}/status`,
        response_url: `${base}/${endpoint}/requests/${id}/response`,
        queue_position: 0,
      });
    }
    json(404, { detail: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, files, log, control })));
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'maskarad-fal-'));
  const video = await fs.readFile(await makeTestVideo(path.join(tmp, 'input.mp4'), { w: 1920, h: 1080, seconds: 4 }));
  const video34 = await fs.readFile(await makeTestVideo(path.join(tmp, 'input34.mp4'), { w: 480, h: 640, seconds: 3 }));
  // What the fake image model "draws": a plain 9:16 picture
  const photoPng = path.join(tmp, 'photo.png');
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x9a9aa0:s=576x1024', '-frames:v', '1', photoPng]);
  const fake = await startFakeFal(photoPng);
  const falBase = `http://127.0.0.1:${fake.server.address().port}`;
  const common = {
    FAL_QUEUE_URL: falBase, FAL_REST_URL: falBase, MODEL: 'wan', RESOLUTION: '720p', INPUT_FPS: '24',
    DATA_DIR: path.join(tmp, 'data'), DB_PATH: path.join(tmp, 'test.db'),
  };
  // Normal mode: the site has no key of its own, everyone pays with theirs
  const site = await startSite({ ...common, PROVIDER: '', FAL_KEY: '', PHOTOS_DIR: path.join(tmp, 'photos') });
  const anna = new Client(site.base);
  const boris = new Client(site.base);
  const vera = new Client(site.base);
  const calls = (p) => fake.log.filter((l) => l.path === p);

  try {
    let cfg = (await anna.get('/api/config')).body;
    check('the site runs the real AI without a key of its own', cfg.mode === 'fal' && cfg.characters.every((c) => !c.ready));
    await sleep(500);
    check('without an owner key, nothing is drawn at startup', calls('/fal-ai/nano-banana-2').length === 0 && calls('/fal-ai/nano-banana-2/edit').length === 0);

    await anna.register('anna@example.com');
    let r = await anna.connectKey('zzzzzzzz-0000:not-a-real-key');
    check('an unknown fal.ai key is rejected', r.status === 400 && r.body.field === 'falKey', r.body?.error);
    r = await anna.connectKey(KEY_A);
    const keyCheck = calls('/storage/upload/initiate').filter((l) => l.key === KEY_A);
    check('the key is checked on fal.ai and saved', r.status === 200 && r.body.user.falKey.connected && keyCheck.length === 1);
    check('checking the key uploads and runs nothing', fake.log.filter((l) => l.method === 'PUT' || l.path.startsWith('/fal-ai/')).length === 0);

    const job = await anna.makeVideo(video, 'barry');
    check('the video via fal is done', job.view?.stage === 'done', `stages: ${job.stages.join(' → ')}${job.view?.error ? `; ${job.view.error}` : ''}`);
    check('the queue position was shown', job.stages.some((s) => s.startsWith('queued(2)')));
    const image = calls('/fal-ai/nano-banana-2/edit');
    check('the ready-made character\'s HD photo is prepared once, with the key of whoever picked it', image.length === 1 && image[0].key === KEY_A && calls('/fal-ai/nano-banana-2').length === 0);
    const sheetUpload = calls('/storage/upload/initiate').find((l) => l.fileName === 'barry-sheet.jpg');
    const imgIn = image[0]?.input || {};
    check('it is made from the character sheet', Boolean(sheetUpload) && sheetUpload.key === KEY_A && imgIn.image_urls?.length === 1 && /\/files\//.test(imgIn.image_urls[0]) && /propeller/.test(imgIn.prompt || ''));
    check('the image model keeps the character and never draws real people', /character sheet/.test(imgIn.system_prompt || '') && /Never depict real people/.test(imgIn.system_prompt || '') && imgIn.safety_tolerance === '2' && imgIn.aspect_ratio === '9:16');
    const wanA = calls('/fal-ai/wan/v2.2-14b/animate/replace');
    check('the video runs on the user\'s key', wanA.length === 1 && wanA[0].key === KEY_A);
    const inp = wanA[0]?.input || {};
    check('the model gets links to the video and the reference', /\/files\//.test(inp.video_url || '') && /\/files\//.test(inp.image_url || ''));
    check('model parameters and safety checks', inp.resolution === '720p' && inp.enable_safety_checker === true && inp.enable_output_safety_checker === true);
    check('the model runs at full quality: 30 steps, no turbo', inp.num_inference_steps === 30 && inp.use_turbo === false && inp.video_quality === 'maximum');
    const statusCalls = fake.log.filter((l) => /\/requests\//.test(l.path));
    check('status and result are fetched with the same key', statusCalls.length > 0 && statusCalls.every((l) => l.key === KEY_A));
    check('presigned PUT has no key and a content type', fake.log.filter((l) => l.method === 'PUT').every((l) => !l.key && l.type));

    const refUpload = [...fake.files.values()].find((f) => f.name === 'reference.png');
    const refFile = path.join(tmp, 'ref.png');
    await fs.writeFile(refFile, refUpload?.data || Buffer.alloc(0));
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', refFile]).catch(() => ({ stdout: '' }));
    check('the reference fits the video\'s aspect ratio', stdout.trim() === '1280,720', stdout.trim());

    const res = await anna.get(job.view.videoUrl);
    const out = path.join(tmp, 'result.mp4');
    await fs.writeFile(out, res.body);
    const streams = (await probe(out)).streams;
    const v = streams.find((s) => s.codec_type === 'video');
    check('the finished video is 1280×720, 24 fps, with sound', v?.width === 1280 && v?.height === 720 && v?.r_frame_rate === '24/1' && streams.some((s) => s.codec_type === 'audio'));

    cfg = (await anna.get('/api/config')).body;
    const barry = cfg.characters.find((c) => c.id === 'barry');
    check('the prepared photo is now shared with everyone, the card stays the same', barry?.ready === true && barry.image === '/characters/barry.jpg');
    const img = await boris.get('/characters/barry.png');
    check('the site serves the HD reference photo', img.status === 200 && img.headers.get('content-type') === 'image/png');

    // A second user with their own key
    await boris.register('boris@example.com');
    await boris.connectKey(KEY_B);
    const job2 = await boris.makeVideo(video, 'barry');
    const wanAll = calls('/fal-ai/wan/v2.2-14b/animate/replace');
    check('the second user pays with their own key', job2.view?.stage === 'done' && wanAll.length === 2 && wanAll[1].key === KEY_B, job2.view?.error || '');
    check('the HD photo is not prepared again', calls('/fal-ai/nano-banana-2/edit').length === 1);

    r = await boris.post('/api/characters', { name: 'Aunt Rose', description: 'a woman around sixty in a pink coat with a huge hat and a cane' });
    const last = calls('/fal-ai/nano-banana-2').at(-1);
    check('a custom character is drawn with its owner\'s key', r.status === 201 && last?.key === KEY_B && /pink coat/.test(last.input.prompt) && !Number.isInteger(last.input.seed), r.body?.error || '');
    check('a custom character is drawn from text only, as a fictional adult', !last?.input?.image_urls && /fictional adult/.test(last?.input?.prompt || '') && /Never depict real people/.test(last?.input?.system_prompt || ''));
    const job3 = await boris.makeVideo(video, r.body.character.id);
    check('a video with a custom character via fal is done', job3.view?.stage === 'done', job3.view?.error || '');

    // A 3:4 video: the AI gets the whole picture inside a 9:16 frame, and the margins are cut off afterwards
    const job34 = await anna.makeVideo(video34, 'barry');
    const sent34 = [...fake.files.values()].filter((f) => f.name === 'input.mp4' && f.data).at(-1);
    const sent34File = path.join(tmp, 'sent34.mp4');
    await fs.writeFile(sent34File, sent34?.data || Buffer.alloc(0));
    const sentInfo = (await probe(sent34File).catch(() => ({ streams: [] }))).streams.find((x) => x.codec_type === 'video');
    const res34 = await anna.get(job34.view?.videoUrl || '/none');
    const res34File = path.join(tmp, 'res34.mp4');
    await fs.writeFile(res34File, res34.body);
    const resInfo = (await probe(res34File).catch(() => ({ streams: [] }))).streams.find((x) => x.codec_type === 'video');
    check('a 3:4 video goes to the AI as 9:16 without cropping and comes back 3:4', job34.view?.stage === 'done' && sentInfo?.width === 720 && sentInfo?.height === 1280 && resInfo?.width === 720 && resInfo?.height === 960,
      `sent ${sentInfo?.width}×${sentInfo?.height}, got ${resInfo?.width}×${resInfo?.height}`);

    // If preparing the HD photo fails for a reason other than the key or the balance, the video still goes ahead
    fake.control.failSheets = true;
    const job3b = await anna.makeVideo(video, 'lavinia');
    fake.control.failSheets = false;
    const lavinia = (await anna.get('/api/config')).body.characters.find((c) => c.id === 'lavinia');
    check('a failed HD photo falls back to the card picture', job3b.view?.stage === 'done' && lavinia?.ready === false && /using the card picture/.test(site.logs()), job3b.view?.error || '');

    fake.control.failNext = true;
    const job4 = await anna.makeVideo(video, 'barry');
    check('an AI refusal is explained to the user', job4.view?.stage === 'error' && /safety check/.test(job4.view?.error || '') && job4.view?.errorKind === 'safety', job4.view?.error);

    // fal.ai credit has run out
    await vera.register('vera@example.com');
    r = await vera.connectKey(BROKE);
    check('a key without credit still checks out as valid', r.status === 200);
    const job5 = await vera.makeVideo(video, 'barry');
    check('without fal.ai credit, the user is told right away', job5.view?.stage === 'error' && /balance has run out/.test(job5.view?.error || '') && job5.view?.errorKind === 'balance', job5.view?.error);
    r = await vera.post('/api/characters', { name: 'Peter', description: 'a man in his fifties with a thick mustache and blue overalls' });
    check('and when drawing a character too', r.status === 402 && r.body.field === 'falKey' && /balance has run out/.test(r.body.error || ''), r.body?.error);

    const logs = site.logs();
    check('users\' keys never reach the log', ![KEY_A, KEY_B, BROKE].some((k) => logs.includes(k) || logs.includes(k.split(':')[1])));
  } finally {
    await site.stop();
    if (t.failures) console.log(`\nSite log:\n${site.logs()}`);
  }

  // If the owner set their own FAL_KEY, the ready-made characters' photos are prepared at startup at the owner's expense
  const before = calls('/fal-ai/nano-banana-2/edit').length;
  const owned = await startSite({ ...common, PROVIDER: '', FAL_KEY: OWNER, PHOTOS_DIR: path.join(tmp, 'photos-owner'), DB_PATH: path.join(tmp, 'owner.db') });
  try {
    let cfg;
    for (let i = 0; i < 120; i += 1) {
      cfg = (await new Client(owned.base).get('/api/config')).body;
      if (cfg.characters.every((c) => c.ready)) break;
      await sleep(500);
    }
    const ownerCalls = calls('/fal-ai/nano-banana-2/edit').slice(before);
    check('with the owner\'s FAL_KEY, photos are prepared at startup with that key', cfg.characters.every((c) => c.ready) && ownerCalls.length === cfg.characters.length && ownerCalls.every((l) => l.key === OWNER));
  } finally {
    await owned.stop();
    fake.server.close();
    if (t.failures) console.log(`\nSite log with FAL_KEY:\n${owned.logs()}`);
  }
  console.log(t.failures ? `\nFailed checks: ${t.failures}` : '\nAll checks passed');
  process.exit(t.failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
