import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as fal from './fal.js';
import { MODELS } from './config.js';
import { mockGenerate } from './media.js';
import { log } from './log.js';

/**
 * A provider is the "AI" that replaces the person in a video with a character.
 * start({ videoPath, refPath, workDir, falKey }) submits a job paid with the user's key,
 * check(handle) returns its state:
 *   { state: 'queued' | 'running' | 'done' | 'failed', queuePosition?, outputUrl?, outputPath?, error?, userMessage?, kind? }
 */

export function createFalProvider(config, { publishFile } = {}) {
  const model = MODELS[config.model];

  async function toUrl(filePath, key) {
    try {
      return await fal.uploadFile(filePath, key);
    } catch (e) {
      // Rejected key or no credit: the fallback won't help
      if (e.kind) throw e;
      // Fallback: if fal storage is unavailable, serve the file from our own server via a secret link.
      if (config.publicUrl && publishFile) {
        log.warn(`Upload to fal storage failed (${e.message}), serving the file from our own server instead`);
        return publishFile(filePath);
      }
      throw e;
    }
  }

  function buildInput(videoUrl, imageUrl) {
    if (config.model === 'pixverse') {
      return { video_url: videoUrl, image_url: imageUrl, mode: 'person', resolution: config.resolution, original_sound_switch: false };
    }
    return {
      video_url: videoUrl,
      image_url: imageUrl,
      resolution: config.resolution,
      // More denoising steps give cleaner hands and faces; fal.ai charges by frames, not by steps
      num_inference_steps: config.inferenceSteps,
      use_turbo: false,
      video_quality: 'maximum',
      enable_safety_checker: true,
      enable_output_safety_checker: true,
    };
  }

  return {
    name: 'fal',
    async start({ videoPath, refPath, falKey }) {
      const [videoUrl, imageUrl] = await Promise.all([toUrl(videoPath, falKey), toUrl(refPath, falKey)]);
      const submitted = await fal.submit(model.endpoint, buildInput(videoUrl, imageUrl), falKey);
      return { ...submitted, falKey };
    },
    async check(handle) {
      const st = await fal.status(handle.statusUrl, handle.falKey);
      if (st?.error) {
        const text = `${st.error_type || ''} ${typeof st.error === 'string' ? st.error : JSON.stringify(st.error)}`;
        return { state: 'failed', error: text.trim(), userMessage: fal.userMessageFor(0, text), kind: fal.kindFor(0, text) };
      }
      if (st?.status === 'IN_QUEUE') return { state: 'queued', queuePosition: Number.isFinite(st.queue_position) ? st.queue_position : null };
      if (st?.status !== 'COMPLETED') return { state: 'running' };
      const out = await fal.result(handle.responseUrl, handle.falKey);
      const url = out?.video?.url;
      if (!url) return { state: 'failed', error: `no video in the response: ${JSON.stringify(out).slice(0, 300)}`, userMessage: 'The AI didn’t return a video. Please try again.' };
      return { state: 'done', outputUrl: url };
    },
  };
}

export function createMockProvider() {
  const tasks = new Map();
  const QUEUE_MS = 2500;
  const MIN_RUN_MS = 6000;

  return {
    name: 'mock',
    async start({ videoPath, refPath, workDir, frame }) {
      const id = randomUUID();
      const task = { startedAt: Date.now(), done: false, error: null, outPath: path.join(workDir, 'generated.mp4') };
      tasks.set(id, task);
      setTimeout(() => {
        mockGenerate({ videoPath, refPath, outPath: task.outPath, frame })
          .then(() => { task.done = true; })
          .catch((e) => { task.error = e; });
      }, QUEUE_MS);
      return { mockId: id };
    },
    async check(handle) {
      const task = tasks.get(handle.mockId);
      if (!task) return { state: 'failed', error: 'mock task lost', userMessage: 'The job got lost. Please try again.' };
      if (task.error) {
        tasks.delete(handle.mockId);
        return { state: 'failed', error: task.error.message, userMessage: 'Couldn’t process the video. Please try another file.' };
      }
      const elapsed = Date.now() - task.startedAt;
      if (elapsed < QUEUE_MS) return { state: 'queued', queuePosition: 0 };
      if (!task.done || elapsed < MIN_RUN_MS) return { state: 'running' };
      tasks.delete(handle.mockId);
      return { state: 'done', outputPath: task.outPath };
    },
  };
}

export function createProvider(config, deps) {
  return config.provider === 'fal' ? createFalProvider(config, deps) : createMockProvider(config);
}
