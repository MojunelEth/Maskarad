import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** An error that can be shown to the user: status, text and form field. */
export class HttpError extends Error {
  constructor(status, message, field) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
};

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "style-src 'self'",
    "font-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

export function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: message, ...extra });
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

export async function readJson(req, limitBytes = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('bad json'), { status: 400 });
  }
}

/** The raw request body. */
export async function readRaw(req, limitBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Writes the request body to a file, cutting the upload off if it exceeds maxBytes. */
export async function saveBody(req, destPath, maxBytes) {
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) cb(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }));
      else cb(null, chunk);
    },
  });
  await pipeline(req, limiter, fs.createWriteStream(destPath));
  return size;
}

/** Serves a file with Range support (needed for video seeking, especially in Safari). */
export async function sendFile(req, res, filePath, { cacheControl = 'no-cache', downloadName = null } = {}) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    sendError(res, 404, 'File not found');
    return;
  }
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
    'Last-Modified': stat.mtime.toUTCString(),
  };
  if (downloadName) headers['Content-Disposition'] = `attachment; filename="${downloadName}"`;

  const range = req.headers.range;
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [a, b] = range.slice(6).split('-');
    if (a === '') {
      start = Math.max(0, stat.size - Number(b));
    } else {
      start = Number(a);
      if (b !== '') end = Math.min(Number(b), stat.size - 1);
    }
    if (start > end || start >= stat.size) {
      res.writeHead(416, { ...SECURITY_HEADERS, 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  try {
    await pipeline(fs.createReadStream(filePath, { start, end }), res);
  } catch {
    /* the client closed the connection, which is fine */
  }
}

/** Static files from the public folder, never outside it. */
export async function serveStatic(req, res, publicDir, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    sendError(res, 400, 'Invalid address');
    return;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const full = path.resolve(publicDir, '.' + rel);
  if (!full.startsWith(publicDir + path.sep)) {
    sendError(res, 403, 'Forbidden');
    return;
  }
  const ext = path.extname(full).toLowerCase();
  let cache = 'no-cache';
  if (['.png', '.svg', '.jpg', '.webp', '.ico'].includes(ext)) cache = 'public, max-age=3600';
  if (['.woff', '.woff2'].includes(ext)) cache = 'public, max-age=604800';
  await sendFile(req, res, full, { cacheControl: cache });
}
