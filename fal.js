// A minimal dependency-free fal.ai client: the request queue and file uploads to fal storage.
// Queue docs: https://fal.ai/docs/documentation/model-apis/inference/queue
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// The addresses can be overridden for tests only (scripts/fal-contract-test.js starts a fake fal).
const QUEUE_URL = (process.env.FAL_QUEUE_URL || 'https://queue.fal.run').replace(/\/+$/, '');
const REST_URL = (process.env.FAL_REST_URL || 'https://rest.fal.ai').replace(/\/+$/, '');

export class FalError extends Error {
  constructor(message, { status, body, userMessage, kind } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.userMessage = userMessage;
    this.kind = kind || null;
  }
}

function describe(body) {
  if (!body) return '';
  if (typeof body === 'string') return body.slice(0, 500);
  if (typeof body.detail === 'string') return body.detail;
  if (Array.isArray(body.detail)) return body.detail.map((d) => d.msg || JSON.stringify(d)).join('; ');
  if (body.error) return typeof body.error === 'string' ? body.error : JSON.stringify(body.error);
  if (body.message) return body.message;
  return JSON.stringify(body).slice(0, 500);
}

/** What happened, in one word: key (key rejected), balance (no credit on fal.ai), safety (safety check). */
export function kindFor(status, text) {
  if (status === 401 || status === 403) return 'key';
  if (status === 402 || /balance|credit|billing|payment|exhausted|insufficient/i.test(text)) return 'balance';
  if (/safety|nsfw|content policy|flagged/i.test(text)) return 'safety';
  return null;
}

export function userMessageFor(status, text) {
  const kind = kindFor(status, text);
  if (kind === 'key') return 'fal.ai rejected your key. Check it on the Account tab or create a new one on fal.ai.';
  if (kind === 'balance') return 'Your fal.ai balance has run out. Top it up on fal.ai and try again.';
  if (kind === 'safety') return 'The video didn’t pass the safety check. Please try a different video.';
  if (status === 422) return 'The AI couldn’t accept this video. Try another one: one person in the frame, face and hands clearly visible.';
  if (status === 429) return 'The AI is overloaded right now. Please try again in a couple of minutes.';
  return 'The AI returned an error. Please try again a little later.';
}

async function falFetch(url, { key, method = 'GET', json, body, headers = {}, timeoutMs = 60000 } = {}) {
  const init = {
    method,
    headers: { Authorization: `Key ${key}`, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers['Content-Type'] = 'application/json';
  } else if (body !== undefined) {
    init.body = body;
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new FalError(`Network: ${e.message}`, { userMessage: 'Couldn’t reach fal.ai. Please try again in a minute.' });
  }
  const text = await res.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep the text */
  }
  if (!res.ok) {
    const detail = describe(parsed);
    throw new FalError(`fal ${method} ${url} → ${res.status}: ${detail}`, {
      status: res.status,
      body: parsed,
      userMessage: userMessageFor(res.status, detail),
      kind: kindFor(res.status, detail),
    });
  }
  return parsed;
}

/**
 * Checks a user's key without spending anything: asks fal storage for an upload slot and uploads nothing.
 * Returns true/false; throws FalError if fal is unreachable.
 */
export async function checkKey(key) {
  try {
    const init = await falFetch(`${REST_URL}/storage/upload/initiate?storage_type=fal-cdn-v3`, {
      key, method: 'POST', json: { content_type: 'text/plain', file_name: 'key-check.txt' }, timeoutMs: 20000,
    });
    return Boolean(init?.upload_url);
  } catch (e) {
    if (e.status === 401 || e.status === 403) return false;
    throw e;
  }
}

/** Queues a request. Returns request_id, status_url and response_url. */
export async function submit(endpoint, input, key) {
  const data = await falFetch(`${QUEUE_URL}/${endpoint}`, { key, method: 'POST', json: input });
  if (!data?.request_id) throw new FalError(`fal returned no request_id: ${describe(data)}`, { userMessage: userMessageFor(0, '') });
  // Take the status and result links from fal's response instead of building them ourselves
  return {
    requestId: data.request_id,
    statusUrl: data.status_url || `${QUEUE_URL}/${endpoint}/requests/${data.request_id}/status`,
    responseUrl: data.response_url || `${QUEUE_URL}/${endpoint}/requests/${data.request_id}`,
  };
}

/** Request status: IN_QUEUE, IN_PROGRESS or COMPLETED (+ error if it failed). */
export async function status(statusUrl, key) {
  return falFetch(statusUrl, { key, timeoutMs: 30000 });
}

export async function result(responseUrl, key) {
  return falFetch(responseUrl, { key, timeoutMs: 120000 });
}

const CONTENT_TYPES = { '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** Uploads a local file to fal storage and returns a public link to it. */
export async function uploadFile(filePath, key) {
  const fileName = path.basename(filePath);
  const contentType = CONTENT_TYPES[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
  const bytes = await fs.readFile(filePath);
  if (bytes.length > 90 * 1024 * 1024) throw new FalError('The file is larger than 90 MB and would need a multipart upload', { userMessage: 'The video is too large to send.' });

  const init = await falFetch(`${REST_URL}/storage/upload/initiate?storage_type=fal-cdn-v3`, {
    key, method: 'POST', json: { content_type: contentType, file_name: fileName },
  });
  if (!init?.upload_url || !init?.file_url) throw new FalError(`fal storage returned no upload link: ${describe(init)}`);

  let res;
  try {
    res = await fetch(init.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: bytes,
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
  } catch (e) {
    throw new FalError(`Uploading the file to fal: ${e.message}`);
  }
  if (!res.ok) throw new FalError(`Uploading the file to fal → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return init.file_url;
}

/** Downloads a file by link (fal results live on a public CDN). */
export async function download(url, destPath) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(5 * 60 * 1000) });
  } catch (e) {
    throw new FalError(`Downloading the result: ${e.message}`, { userMessage: 'Couldn’t download the finished video. Please try again.' });
  }
  if (!res.ok || !res.body) throw new FalError(`Downloading the result → ${res.status}`, { userMessage: 'Couldn’t download the finished video. Please try again.' });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
  return destPath;
}
