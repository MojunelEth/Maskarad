import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function str(name, fallback) {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function num(name, fallback) {
  const v = str(name, '');
  if (v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got: "${v}"`);
  return n;
}

function bool(name, fallback) {
  const v = str(name, '').toLowerCase();
  if (v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

// fal.ai prices as of early October 2026: used only for the "about how much it will cost" hint.
export const MODELS = {
  wan: {
    endpoint: 'fal-ai/wan/v2.2-14b/animate/replace',
    resolutions: ['480p', '580p', '720p'],
    pricePer16Frames: { '480p': 0.04, '580p': 0.06, '720p': 0.08 },
  },
  pixverse: {
    endpoint: 'fal-ai/pixverse/swap',
    resolutions: ['360p', '540p', '720p', '1080p'],
  },
};
export const IMAGE_PRICE = 0.08;

export const config = {
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  charactersFile: path.join(ROOT, 'characters', 'characters.json'),
  // Finished videos and temporary files. On Render with a persistent disk: /var/data/work
  dataDir: str('DATA_DIR', path.join(ROOT, 'data', 'work')),
  // Character photos, including the ones users drew. On Render: /var/data/characters
  photosDir: str('PHOTOS_DIR', path.join(ROOT, 'data', 'characters')),
  // Database: accounts, encrypted fal.ai keys, video history, support messages. On Render: /var/data/maskarad.db
  dbPath: str('DB_PATH', path.join(ROOT, 'data', 'maskarad.db')),

  port: num('PORT', 3000),
  // fal is the real AI paid with the user's key; mock is a demo without the AI, for trying the site out
  provider: str('PROVIDER', 'fal'),
  // Optional owner key: if set, ready-made characters' photos are drawn at startup at the owner's expense.
  // If not, a ready-made character's photo is drawn once, with the first video using it, by whoever picked it.
  falKey: str('FAL_KEY', ''),
  model: str('MODEL', 'wan'),
  resolution: str('RESOLUTION', '720p'),
  inputFps: num('INPUT_FPS', 24),
  // Denoising steps for the video model: more means cleaner hands and faces and a longer wait, the price is the same
  inferenceSteps: num('INFERENCE_STEPS', 30),
  imageModel: str('IMAGE_MODEL', 'fal-ai/nano-banana-2'),

  maxSeconds: num('MAX_SECONDS', 10),
  maxUploadMb: num('MAX_UPLOAD_MB', 100),
  // How many videos the site handles at once, and how many of them ffmpeg processes at once
  maxActiveJobs: num('MAX_ACTIVE_JOBS', 10),
  maxFfmpeg: num('MAX_FFMPEG', 2),
  keepResultsMinutes: num('KEEP_RESULTS_MINUTES', 1440),
  maxCustomCharacters: num('MAX_CUSTOM_CHARACTERS', 6),
  characterGenerationsPerDay: num('CHARACTER_GENERATIONS_PER_DAY', 10),
  sessionDays: num('SESSION_DAYS', 30),
  jobTimeoutMinutes: num('JOB_TIMEOUT_MINUTES', 30),
  pollSeconds: num('POLL_SECONDS', 4),

  trustProxy: bool('TRUST_PROXY', Boolean(process.env.RENDER)),
  publicUrl: str('PUBLIC_URL', process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),

  keySecret: str('KEY_SECRET', ''),
  adminToken: str('ADMIN_TOKEN', ''),

  // Who runs the site: for the Rules, the Privacy page and the Help tab. Optional.
  ownerName: str('OWNER_NAME', ''),
  ownerEmail: str('OWNER_EMAIL', ''),
};

/** Approximate fal.ai price of a video this long, in dollars. */
export function estimateVideoCost(seconds) {
  const s = Math.min(Math.max(Number(seconds) || 0, 0), config.maxSeconds);
  const model = MODELS[config.model];
  if (model?.pricePer16Frames) {
    const rate = model.pricePer16Frames[config.resolution] || 0.08;
    return Math.round(Math.ceil((s * config.inputFps) / 16) * rate * 100) / 100;
  }
  return s <= 5 ? 0.2 : 0.4;
}

export function validateConfig() {
  const problems = [];
  if (!['fal', 'mock'].includes(config.provider)) problems.push('PROVIDER can only be fal or mock');
  const model = MODELS[config.model];
  if (!model) problems.push(`MODEL can be: ${Object.keys(MODELS).join(', ')}`);
  else if (!model.resolutions.includes(config.resolution)) {
    problems.push(`For MODEL=${config.model}, RESOLUTION can be: ${model.resolutions.join(', ')}`);
  }
  if (config.maxSeconds < 1 || config.maxSeconds > 60) problems.push('MAX_SECONDS must be between 1 and 60');
  if (config.inputFps < 8 || config.inputFps > 60) problems.push('INPUT_FPS must be between 8 and 60');
  if (!Number.isInteger(config.inferenceSteps) || config.inferenceSteps < 4 || config.inferenceSteps > 50) problems.push('INFERENCE_STEPS must be a whole number between 4 and 50');
  if (config.maxUploadMb < 1) problems.push('MAX_UPLOAD_MB must be at least 1');
  if (config.maxFfmpeg < 1) problems.push('MAX_FFMPEG must be at least 1');
  if (problems.length) throw new Error('Settings error:\n- ' + problems.join('\n- '));
}
