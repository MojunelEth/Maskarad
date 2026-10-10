import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export class MediaError extends Error {
  constructor(userMessage, detail) {
    super(userMessage);
    this.userMessage = userMessage;
    this.detail = detail;
  }
}

function run(cmd, args, { timeoutMs = 10 * 60 * 1000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 20000) err = err.slice(-20000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Couldn't start ${cmd}: ${e.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const stdout = binary ? Buffer.concat(out) : Buffer.concat(out).toString();
      if (code === 0) resolve({ stdout, stderr: err });
      else reject(new Error(`${cmd} failed (${signal || code}): ${err.trim().split('\n').slice(-6).join(' | ')}`));
    });
  });
}

export async function checkFfmpeg() {
  await run('ffmpeg', ['-hide_banner', '-version'], { timeoutMs: 10000 });
  await run('ffprobe', ['-hide_banner', '-version'], { timeoutMs: 10000 });
}

export async function probe(file) {
  let json;
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
    ], { timeoutMs: 60000 });
    json = JSON.parse(stdout);
  } catch (e) {
    throw new MediaError('Couldn’t read the file. It doesn’t look like a video, or the file is damaged.', e.message);
  }
  const streams = json.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(json.format?.duration || video?.duration || 0);
  if (!video) throw new MediaError('The file has no video track.');
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    width: video.width,
    height: video.height,
    hasAudio: Boolean(audio),
  };
}

// The AI only makes 9:16 or 16:9 videos and crops any other shape to fit, which cuts off hands near the edges.
// So we place the whole video inside a 9:16 (or 16:9) frame ourselves, extend its edges into the margins,
// and cut the margins off again after the AI. Short side of that frame for each resolution:
const SHORT_SIDE = { '360p': 360, '480p': 480, '540p': 540, '580p': 580, '720p': 720, '1080p': 1080 };
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const evenOffset = (n) => Math.max(0, Math.floor(n / 2) * 2);

/** The frame the AI works in and where the user's video sits inside it. */
export function workFrame(width, height, resolution) {
  const short = SHORT_SIDE[resolution] || 720;
  const long = even((short * 16) / 9);
  const portrait = height >= width;
  const W = portrait ? short : long;
  const H = portrait ? long : short;
  const scale = Math.min(W / width, H / height);
  const w = Math.min(W, even(width * scale));
  const h = Math.min(H, even(height * scale));
  return { W, H, box: { x: evenOffset((W - w) / 2), y: evenOffset((H - h) / 2), w, h } };
}

/** Where the user's video is inside the AI's result, which may come back in a slightly different size. */
export function cropBox(frame, outW, outH) {
  const { W, H, box } = frame;
  if (box.x === 0 && box.y === 0 && box.w === W && box.h === H) return null;
  const sx = outW / W;
  const sy = outH / H;
  const w = Math.min(outW, even(box.w * sx));
  const h = Math.min(outH, even(box.h * sy));
  return { w, h, x: Math.min(outW - w, evenOffset(box.x * sx)), y: Math.min(outH - h, evenOffset(box.y * sy)) };
}

/**
 * Prepares the video for the model: trims it to maxSeconds, sets the fps, strips the sound (it's saved
 * separately and put back into the final video) and places the whole picture inside the AI's frame.
 */
export async function prepareInput(src, { videoOut, audioOut, maxSeconds, fps, resolution }) {
  const info = await probe(src);
  if (info.duration && info.duration < 1) throw new MediaError('The video is too short: it needs to be at least 1 second long.');

  // Step 1: upright, square pixels, the right length and fps
  const raw = path.join(path.dirname(videoOut), 'input-raw.mp4');
  const scale = "scale='trunc(iw*sar/2)*2':ih,setsar=1,scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
  await run('ffmpeg', [
    '-hide_banner', '-y', '-i', src,
    '-t', String(maxSeconds),
    '-vf', `${scale},fps=${fps},format=yuv420p`,
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14',
    raw,
  ]).catch((e) => {
    throw new MediaError('Couldn’t process the video. Try another file (mp4 or mov work best).', e.message);
  });

  // Step 2: the whole picture inside the AI's frame, with the edges smeared into the margins
  const rawInfo = await probe(raw);
  const frame = workFrame(rawInfo.width, rawInfo.height, resolution);
  const { W, H, box } = frame;
  const filters = [`scale=${box.w}:${box.h}:flags=lanczos`, 'setsar=1'];
  if (box.w !== W || box.h !== H) {
    filters.push(`pad=${W}:${H}:${box.x}:${box.y}:black`);
    filters.push(`fillborders=left=${box.x}:right=${W - box.x - box.w}:top=${box.y}:bottom=${H - box.y - box.h}:mode=smear`);
  }
  filters.push('format=yuv420p');
  await run('ffmpeg', [
    '-hide_banner', '-y', '-i', raw,
    '-vf', filters.join(','),
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16',
    '-movflags', '+faststart', videoOut,
  ]).catch((e) => {
    throw new MediaError('Couldn’t process the video. Try another file (mp4 or mov work best).', e.message);
  }).finally(() => removeQuietly(raw));

  let audioPath = null;
  if (info.hasAudio) {
    try {
      await run('ffmpeg', ['-hide_banner', '-y', '-i', src, '-t', String(maxSeconds), '-vn', '-c:a', 'aac', '-b:a', '160k', audioOut]);
      audioPath = audioOut;
    } catch {
      audioPath = null; // we can carry on without sound
    }
  }

  const prepared = await probe(videoOut);
  return {
    videoPath: videoOut,
    audioPath,
    frame,
    width: prepared.width,
    height: prepared.height,
    duration: prepared.duration,
    originalDuration: info.duration,
    trimmed: info.duration > maxSeconds + 0.05,
  };
}

/** The picture's top-left corner color as RRGGBB, used to fill the margins when fitting the aspect ratio. */
export async function cornerColor(imagePath) {
  try {
    const { stdout } = await run('ffmpeg', [
      '-v', 'error', '-i', imagePath, '-vf', 'crop=8:8:0:0,scale=1:1,format=rgb24',
      '-frames:v', '1', '-f', 'rawvideo', 'pipe:1',
    ], { timeoutMs: 30000, binary: true });
    if (stdout.length >= 3) return [...stdout.subarray(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    /* fall back to a neutral grey below */
  }
  return 'd9d9d9';
}

/**
 * The model crops the reference picture to the video's aspect ratio. So the character doesn't lose their head,
 * we fit the whole picture into the video frame and fill the margins with the background color.
 */
export async function fitReference(imagePath, outPath, width, height) {
  const color = await cornerColor(imagePath);
  await run('ffmpeg', [
    '-hide_banner', '-y', '-i', imagePath,
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x${color}`,
    '-frames:v', '1', outPath,
  ], { timeoutMs: 60000 });
  return outPath;
}

/** Cuts the AI's margins off, puts the original sound back and marks the file as AI-made in its metadata (invisible). */
export async function finalize({ videoPath, audioPath, outPath, frame = null }) {
  const info = await probe(videoPath);
  const crop = frame ? cropBox(frame, info.width, info.height) : null;
  const filters = [];
  if (crop) filters.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
  filters.push('format=yuv420p');

  const args = ['-hide_banner', '-y', '-i', videoPath];
  if (audioPath) args.push('-i', audioPath);
  args.push('-vf', filters.join(','), '-map', '0:v');
  if (audioPath) args.push('-map', '1:a', '-c:a', 'aac', '-b:a', '160k', '-shortest');
  else args.push('-an');
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-movflags', '+faststart',
    '-metadata', 'comment=AI-generated video. All characters are fictional.',
    outPath,
  );
  await run('ffmpeg', args);
  return outPath;
}

/** Demo mode without the AI: the character "in a window" over your video, to test the whole path. */
export async function mockGenerate({ videoPath, refPath, outPath, frame = null }) {
  const info = await probe(videoPath);
  const minSide = Math.min(info.width, info.height);
  const boxW = Math.round(minSide * 0.45) & ~1;
  const pad = Math.round(minSide * 0.04) + (frame ? Math.max(frame.box.x, frame.box.y) : 0);
  await run('ffmpeg', [
    '-hide_banner', '-y', '-i', videoPath, '-i', refPath,
    '-filter_complex',
    `[0:v]hue=s=0.25,eq=contrast=1.05[base];[1:v]scale=${boxW}:-1[ref];[base][ref]overlay=${pad}:${pad}:format=auto,format=yuv420p[v]`,
    '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', outPath,
  ]);
  return outPath;
}

/** Recolors a picture (hue shift), for custom characters in demo mode. */
export async function tintImage(src, dest, hueDegrees) {
  await run('ffmpeg', ['-hide_banner', '-y', '-i', src, '-vf', `hue=h=${hueDegrees}`, '-frames:v', '1', dest], { timeoutMs: 60000 });
  return dest;
}

export async function removeQuietly(p) {
  try {
    await fs.rm(p, { recursive: true, force: true });
  } catch {
    /* no harm done */
  }
}
