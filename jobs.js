import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { prepareInput, fitReference, finalize, removeQuietly } from './media.js';
import { download } from './fal.js';
import { log } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class UserFacingError extends Error {
  constructor(userMessage, detail, kind = null) {
    super(userMessage);
    this.userMessage = userMessage;
    this.detail = detail;
    this.kind = kind;
  }
}

/** At most `limit` heavy tasks (ffmpeg) at once; the rest wait their turn. */
function createLimiter(limit) {
  let active = 0;
  const waiting = [];
  return async (fn) => {
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

/**
 * Job stages (the interface shows the same ones):
 * preparing → sending → queued → generating → finishing → done | error
 * The AI is paid with the user's fal.ai key, which lives only in memory while the job runs.
 * Finished videos are kept in DATA_DIR/jobs/<id>/result.mp4 and deleted after KEEP_RESULTS_MINUTES.
 */
export function createJobManager({ config, provider, store }) {
  const jobs = new Map();
  const published = new Map();
  const jobsDir = path.join(config.dataDir, 'jobs');
  const withFfmpeg = createLimiter(Math.max(1, config.maxFfmpeg || 2));

  async function cleanupOld() {
    let entries = [];
    try {
      entries = await fsp.readdir(jobsDir, { withFileTypes: true });
    } catch {
      return;
    }
    const cutoff = Date.now() - config.keepResultsMinutes * 60 * 1000;
    for (const e of entries) {
      if (!e.isDirectory() || jobs.has(e.name)) continue;
      const dir = path.join(jobsDir, e.name);
      try {
        if ((await fsp.stat(dir)).mtimeMs < cutoff) await removeQuietly(dir);
      } catch {
        /* already deleted */
      }
    }
  }

  async function init() {
    await fsp.mkdir(jobsDir, { recursive: true });
    const interrupted = store.markInterrupted('The server restarted while your video was being made. Please upload it again.');
    if (interrupted) log.warn(`Jobs interrupted by the restart: ${interrupted}`);
    await cleanupOld();
    setInterval(() => cleanupOld().catch(() => {}), 10 * 60 * 1000).unref();
  }

  /** A secret link to a file on our server: the fallback way to hand a video to fal. */
  function publishFile(filePath) {
    const token = randomBytes(24).toString('hex') + path.extname(filePath);
    published.set(token, { file: filePath, expires: Date.now() + 2 * 60 * 60 * 1000 });
    return `${config.publicUrl}/media/${token}`;
  }

  function resolvePublished(token) {
    const entry = published.get(token);
    if (!entry) return null;
    if (entry.expires < Date.now()) {
      published.delete(token);
      return null;
    }
    return entry.file;
  }

  const isActive = (j) => !['done', 'error'].includes(j.stage);

  function activeCount() {
    let n = 0;
    for (const j of jobs.values()) if (isActive(j)) n += 1;
    return n;
  }

  function activeFor(userId) {
    for (const j of jobs.values()) if (j.userId === userId && isActive(j)) return j;
    return null;
  }

  async function createJob({ userId, characterId, characterName, falKey }) {
    const id = randomUUID();
    const dir = path.join(jobsDir, id);
    await fsp.mkdir(dir, { recursive: true });
    const job = {
      id, userId, characterId, characterName, falKey, dir,
      stage: 'uploading',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      queuePosition: null,
      trimmed: false,
      error: null,
      errorKind: null,
      finishedAt: null,
    };
    jobs.set(id, job);
    return job;
  }

  async function discard(job) {
    jobs.delete(job.id);
    job.falKey = null;
    await removeQuietly(job.dir);
  }

  function setStage(job, stage, extra = {}) {
    Object.assign(job, extra, { stage, updatedAt: Date.now() });
  }

  async function run(job, uploadPath, getReference) {
    const started = Date.now();
    store.renderStarted(job.id, job.userId, job.characterId, job.characterName);
    try {
      setStage(job, 'preparing');
      const prepared = await withFfmpeg(() => prepareInput(uploadPath, {
        videoOut: path.join(job.dir, 'input.mp4'),
        audioOut: path.join(job.dir, 'audio.m4a'),
        maxSeconds: config.maxSeconds,
        fps: config.inputFps,
        resolution: config.resolution,
      }));
      job.trimmed = prepared.trimmed;
      await removeQuietly(uploadPath);

      setStage(job, 'sending');
      let refSource;
      try {
        refSource = await getReference();
      } catch (e) {
        throw new UserFacingError(e.userMessage || 'Couldn’t prepare the character. Please try again in a minute.', e.message, e.kind);
      }
      const refPath = await fitReference(refSource, path.join(job.dir, 'reference.png'), prepared.frame.W, prepared.frame.H);

      const handle = await provider.start({ videoPath: prepared.videoPath, refPath, workDir: job.dir, falKey: job.falKey, frame: prepared.frame });
      setStage(job, 'queued', { queuePosition: null });

      const deadline = job.createdAt + config.jobTimeoutMinutes * 60 * 1000;
      let outcome = null;
      let failures = 0;
      while (!outcome || ['queued', 'running'].includes(outcome.state)) {
        if (Date.now() > deadline) throw new UserFacingError('Generation took too long. Please try again later.', 'timeout');
        await sleep(config.pollSeconds * 1000);
        try {
          outcome = await provider.check(handle);
          failures = 0;
        } catch (e) {
          if (e.kind) throw e;
          failures += 1;
          log.warn(`Job ${job.id}: couldn't get the status (${failures}/5): ${e.message}`);
          if (failures >= 5) throw e;
          continue;
        }
        if (outcome.state === 'queued') setStage(job, 'queued', { queuePosition: outcome.queuePosition });
        if (outcome.state === 'running') setStage(job, 'generating', { queuePosition: null });
      }
      if (outcome.state === 'failed') throw new UserFacingError(outcome.userMessage || 'The AI couldn’t process this video.', outcome.error, outcome.kind);

      setStage(job, 'finishing');
      const generated = path.join(job.dir, 'generated.mp4');
      if (outcome.outputUrl) await download(outcome.outputUrl, generated);
      else if (outcome.outputPath && outcome.outputPath !== generated) await fsp.copyFile(outcome.outputPath, generated);

      const resultPath = path.join(job.dir, 'result.mp4');
      await withFfmpeg(() => finalize({ videoPath: generated, audioPath: prepared.audioPath, outPath: resultPath, frame: prepared.frame }));
      for (const f of ['input.mp4', 'audio.m4a', 'reference.png', 'generated.mp4']) await removeQuietly(path.join(job.dir, f));

      store.renderFinished(job.id, { ok: true, resultPath });
      setStage(job, 'done', { finishedAt: Date.now() });
      log.info(`Job ${job.id}: done in ${Math.round((Date.now() - started) / 1000)} s (${job.characterName})`);
    } catch (e) {
      const userMessage = e.userMessage || 'Something went wrong while processing. Please try again.';
      log.error(`Job ${job.id}: ${e.detail || e.message}`);
      store.renderFinished(job.id, { ok: false, error: userMessage });
      setStage(job, 'error', { error: userMessage, errorKind: e.kind || null, finishedAt: Date.now() });
      // After a failure, we don't keep the person's original video
      await removeQuietly(job.dir);
    } finally {
      job.falKey = null;
      await removeQuietly(uploadPath);
      // Remove the job from memory later, so the interface still gets to see the outcome
      setTimeout(() => jobs.delete(job.id), 30 * 60 * 1000).unref();
    }
  }

  function view(job) {
    return {
      id: job.id,
      stage: job.stage,
      characterId: job.characterId,
      queuePosition: job.queuePosition,
      trimmed: job.trimmed,
      maxSeconds: config.maxSeconds,
      error: job.error,
      errorKind: job.errorKind,
      elapsedSec: Math.round(((job.finishedAt || Date.now()) - job.createdAt) / 1000),
      videoUrl: job.stage === 'done' ? `/api/videos/${job.id}/file` : null,
      keepMinutes: config.keepResultsMinutes,
    };
  }

  const fileExists = (p) => Boolean(p) && fs.existsSync(p);

  return {
    init, createJob, discard, run, view, activeCount, activeFor, publishFile, resolvePublished, fileExists,
    get: (id) => jobs.get(id),
  };
}
