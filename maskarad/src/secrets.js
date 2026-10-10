// Encrypts users' fal.ai keys before they are written to the database (AES-256-GCM).
// The encryption secret comes from KEY_SECRET, or is created once and kept next to the database on the persistent disk.
// If the secret is lost, saved keys simply stop decrypting, and users paste them again.
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { log } from './log.js';

function loadSecret(config) {
  if (config.keySecret) return config.keySecret;
  const file = path.join(path.dirname(config.dbPath), 'key-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = randomBytes(32).toString('base64');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
    log.info(`Created the secret for encrypting users' keys: ${file}`);
    return secret;
  }
}

export function createKeyBox(config) {
  const key = createHash('sha256').update(loadSecret(config)).digest();

  return {
    seal(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
    },
    open(sealed) {
      const [v, iv, tag, data] = String(sealed || '').split('.');
      if (v !== 'v1' || !iv || !tag || !data) return null;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
        decipher.setAuthTag(Buffer.from(tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
      } catch {
        return null;
      }
    },
  };
}

/** Cleans up what the user pasted: spaces, quotes, "Key …", "FAL_KEY=…". */
export function normalizeFalKey(raw) {
  let k = String(raw || '').trim();
  k = k.replace(/^FAL_KEY\s*=\s*/i, '').replace(/^Key\s+/i, '').replace(/^["'`]+|["'`]+$/g, '').trim();
  if (k.length < 8 || k.length > 300 || /\s/.test(k) || !/^[\x21-\x7e]+$/.test(k)) return null;
  return k;
}

/** "…a1b2", so people can recognize their key without seeing all of it. */
export const keyHint = (k) => `…${String(k).slice(-4)}`;
