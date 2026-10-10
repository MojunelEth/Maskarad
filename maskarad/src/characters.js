import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as fal from './fal.js';
import { tintImage, removeQuietly } from './media.js';
import { log } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Passed to the image model as a system instruction: fictional adults only.
export const FICTIONAL_ONLY = [
  'You generate reference photos of original, fictional adults for an AI video service.',
  'Never depict real people, celebrities, politicians, public figures or existing copyrighted characters, even if they are named or described: invent a new original person instead.',
  'The person must clearly be an adult, at least 25 years old.',
  'Show exactly one person, full body, standing and facing the camera, on a plain light-grey studio backdrop.',
  'No nudity, no sexualised clothing, no text, no logos.',
].join(' ');

// A rough filter for custom character descriptions: no children and nothing explicit.
// Russian words are here on purpose: users may write descriptions in Russian too.
const FORBIDDEN = new RegExp([
  'ребён', 'ребен', 'детск', 'девочк', 'мальчик', 'школьник', 'школьниц', 'подрост', 'малолет', 'несовершеннолет', 'младен',
  '\\bchild', '\\bkids?\\b', '\\bteen', 'underage', '\\bminor\\b', '\\bloli', '\\bboy\\b', '\\bgirl\\b', 'schoolgirl', 'schoolboy',
  '\\bbaby\\b(?!\\s*(?:blue|pink))', 'baby-?faced?', 'toddler', 'infant', 'preteen', '\\bjunior high', 'middle school',
  'голая', 'голый', 'обнаж', '\\bnude', 'naked', 'nsfw', 'секс', 'эрот', 'порн', '\\bsex', '\\bporn', 'erotic', 'lingerie', 'underwear',
  'topless', 'seductive', 'fetish',
].join('|'), 'i');

/** "16 years old", "a 12-year-old" and the like: ages under 18 are rejected too. */
function mentionsMinorAge(text) {
  const re = /(\d{1,2})\s*(?:-|\s)?\s*(?:years?|yrs?|y\.?o\.?|year-old|лет|год)/gi;
  for (const m of text.matchAll(re)) if (Number(m[1]) < 18) return true;
  return false;
}

/** The description can't be drawn: a child, a teenager or explicit details. */
export const isForbiddenDescription = (text) => FORBIDDEN.test(text) || mentionsMinorAge(text);

// For ready-made characters with a picture: the same person, only a clean single HD photo for the AI.
export const FROM_SHEET = [
  'You prepare reference photos of an existing fictional character for an AI video service, from the reference image you are given: a character sheet or a photo.',
  'Keep the character exactly as in the reference: the same face, age, hairstyle, facial hair, glasses and outfit. Do not invent a different person.',
  'Never depict real people, celebrities or public figures.',
  'Show exactly one person, three-quarter length from the knees up, standing and facing the camera, on a plain light-grey studio backdrop.',
  'No text, no logos, no brand names, no collage, no split panels.',
].join(' ');

export function buildSheetPrompt(description) {
  return [
    `A new studio photograph of the character from the reference image: ${description}.`,
    'The same face, hairstyle, facial hair, glasses and outfit as in the reference, without any logos or brand names.',
    'Three-quarter length from the knees up, standing upright and facing the camera, arms relaxed at the sides, neutral expression.',
    'Both hands fully visible and relaxed, with natural, anatomically correct five-finger hands.',
    'Plain seamless light grey studio backdrop, soft even lighting, sharp focus, photorealistic, natural skin texture. One person only, no text.',
  ].join(' ');
}

export function buildPhotoPrompt(description) {
  return [
    `Full-body studio photograph of ${description}.`,
    'Standing upright and facing the camera, arms relaxed at the sides, the whole figure visible from head to shoes with a little space above the head.',
    'Both hands fully visible and relaxed, with natural, anatomically correct five-finger hands.',
    'Neutral friendly expression. Plain seamless light grey studio backdrop, soft even lighting, sharp focus, photorealistic, natural skin texture.',
    'This is a fictional adult, not a real individual or celebrity. No text, no logos, no watermark.',
  ].join(' ');
}

class CharacterError extends Error {
  constructor(status, message, field) {
    super(message);
    this.status = status;
    this.userMessage = message;
    this.field = field;
  }
}

const NEED_KEY = 'Connect the AI first: paste your fal.ai key on the Account tab.';

export function createCharacterStore(config, store) {
  const list = JSON.parse(fs.readFileSync(config.charactersFile, 'utf8'));
  const seen = new Set();
  for (const c of list) {
    if (!/^[a-z0-9-]{1,40}$/.test(c.id || '')) throw new Error(`characters.json: id "${c.id}" may only contain lowercase Latin letters, digits and hyphens`);
    if (seen.has(c.id)) throw new Error(`characters.json: id "${c.id}" is repeated`);
    if (!c.name || !c.prompt) throw new Error(`characters.json: "${c.id}" needs a name and a prompt`);
    seen.add(c.id);
  }

  const generating = new Map();
  const customDir = path.join(config.photosDir, 'custom');

  const photoPath = (id) => path.join(config.photosDir, `${id}.png`);
  const customPath = (id) => path.join(customDir, `${id}.png`);

  // Pictures that come with the site, in public/characters: <id>.jpg is the card (also the demo-mode
  // and fallback reference), <id>-alt.jpg is shown on hover, <id>-sheet.jpg is the full character sheet,
  // <id>-source.jpg is a picture only the AI sees when there's no sheet.
  const picture = (id, suffix = '') => path.join(config.publicDir, 'characters', `${id}${suffix}.jpg`);
  const pictures = new Map(list.map((c) => [c.id, {
    card: fs.existsSync(picture(c.id)),
    alt: fs.existsSync(picture(c.id, '-alt')),
    sheet: fs.existsSync(picture(c.id, '-sheet')),
    source: fs.existsSync(picture(c.id, '-source')),
  }]));
  /** What the image model looks at when preparing the HD photo: the sheet, the source picture or the card. */
  function visualOf(id) {
    const pics = pictures.get(id);
    if (pics.sheet) return picture(id, '-sheet');
    if (pics.source) return picture(id, '-source');
    return pics.card ? picture(id) : null;
  }
  const bundled = (id) => (pictures.get(id)?.card ? picture(id) : null);

  function photoVersion(id) {
    try {
      return Math.round(fs.statSync(photoPath(id)).mtimeMs);
    } catch {
      return null;
    }
  }

  const get = (id) => list.find((c) => c.id === id);

  function publicList() {
    return list.map((c) => {
      const v = config.provider === 'fal' ? photoVersion(c.id) : null;
      const pics = pictures.get(c.id);
      const photo = v ? `/characters/${c.id}.png?v=${v}` : null;
      // "preview": the bundled card is only a rough preview, so once the HD photo exists the card shows it instead
      const card = pics.card ? `/characters/${c.id}.jpg` : null;
      return {
        id: c.id,
        name: c.name,
        tagline: c.tagline || '',
        gesture: c.gesture || '',
        scenes: Array.isArray(c.scenes) ? c.scenes : [],
        caption: c.caption || '',
        image: (c.preview && photo) || card || photo,
        imageAlt: pics.alt ? `/characters/${c.id}-alt.jpg` : null,
        sheet: pics.sheet ? `/characters/${c.id}-sheet.jpg` : null,
        // ready: the HD reference photo for the AI already exists. If not, the first video with this character prepares it
        ready: config.provider === 'mock' ? pics.card : Boolean(v),
        preparing: generating.has(c.id),
      };
    });
  }

  /** Generates an image with the fal model and saves it to dest. */
  async function generateImage({ endpoint = config.imageModel, prompt, systemPrompt = FICTIONAL_ONLY, imagePath = null, seed, dest, label, key }) {
    if (!key) throw new CharacterError(402, NEED_KEY, 'falKey');
    log.info(`${label}: drawing the photo (${endpoint})…`);
    const input = {
      prompt,
      system_prompt: systemPrompt,
      safety_tolerance: '2',
      aspect_ratio: '9:16',
      output_format: 'png',
      resolution: '1K',
      num_images: 1,
    };
    if (imagePath) input.image_urls = [await fal.uploadFile(imagePath, key)];
    if (Number.isInteger(seed)) input.seed = seed;
    const sub = await fal.submit(endpoint, input, key);

    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(3000);
      const st = await fal.status(sub.statusUrl, key);
      if (st?.error) {
        throw Object.assign(new Error(`photo generation failed: ${st.error}`), { userMessage: fal.userMessageFor(0, String(st.error)), kind: fal.kindFor(0, String(st.error)) });
      }
      if (st?.status !== 'COMPLETED') continue;
      const out = await fal.result(sub.responseUrl, key);
      const url = out?.images?.[0]?.url;
      if (!url) throw Object.assign(new Error('the model returned no image'), { userMessage: 'The AI couldn’t draw this character. Try changing the description.' });
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.part`;
      await fal.download(url, tmp);
      await fsp.rename(tmp, dest);
      log.info(`${label}: photo ready`);
      return dest;
    }
    throw new Error('photo generation took longer than 5 minutes');
  }

  /**
   * Path to a ready-made character's reference photo for the AI. In fal mode it's prepared once and then shared by everyone:
   * from the character's pictures if there are any (otherwise from the text description), with the owner's key (FAL_KEY)
   * or, if there is none, with the key of the first user who picked this character.
   * If preparing fails for a reason other than the key or the balance, the video still goes ahead with the card picture.
   */
  async function ensureReference(id, { force = false, key = null, fallback = true } = {}) {
    const c = get(id);
    if (!c) throw new Error(`No character ${id}`);
    if (config.provider === 'mock') {
      const p = bundled(id);
      if (!p) throw new Error(`Demo mode needs a picture: public/characters/${id}.jpg`);
      return p;
    }
    if (!force && fs.existsSync(photoPath(id))) return photoPath(id);
    if (generating.has(id)) return generating.get(id);
    const label = `Character "${c.name}"`;
    const common = { seed: c.seed, dest: photoPath(id), label, key: config.falKey || key };
    const visual = visualOf(id);
    const task = visual
      ? generateImage({ ...common, endpoint: `${config.imageModel}/edit`, prompt: buildSheetPrompt(c.prompt), systemPrompt: FROM_SHEET, imagePath: visual })
      : generateImage({ ...common, prompt: buildPhotoPrompt(c.prompt) });
    const p = task
      .catch((e) => {
        const card = bundled(id);
        // A rejected key or an empty balance has to be fixed by the person: the video wouldn't work either
        if (!fallback || !card || e.kind === 'key' || e.kind === 'balance' || e.status === 402) throw e;
        log.warn(`${label}: couldn't prepare the HD reference (${e.message}), using the card picture this time`);
        return card;
      })
      .finally(() => generating.delete(id));
    generating.set(id, p);
    return p;
  }

  async function warmUp() {
    if (config.provider !== 'fal' || !config.falKey) return;
    const missing = list.filter((c) => !fs.existsSync(photoPath(c.id)));
    await Promise.all(missing.map((c) => ensureReference(c.id, { fallback: false }).catch((e) => {
      log.error(`Character "${c.name}": couldn't prepare the reference photo: ${e.message}`);
    })));
  }

  // ---------- Users' custom characters ----------

  const customId = (publicId) => (/^u-[0-9a-f-]{36}$/.test(publicId || '') ? publicId.slice(2) : null);

  function publicCustom(c) {
    return {
      id: `u-${c.id}`,
      name: c.name,
      tagline: c.description.length > 90 ? `${c.description.slice(0, 88)}…` : c.description,
      description: c.description,
      image: `/api/characters/u-${c.id}/image?v=${c.created_at}`,
      ready: true,
      custom: true,
    };
  }

  function customsOf(user) {
    return user ? store.customsOf(user.id).map(publicCustom) : [];
  }

  function ownedCustom(publicId, user) {
    const id = customId(publicId);
    if (!id || !user) return null;
    const c = store.getCustom(id);
    return c && c.user_id === user.id ? c : null;
  }

  async function createCustom({ user, name, description, key }) {
    const cleanName = String(name || '').trim().replace(/\s+/g, ' ');
    const cleanDesc = String(description || '').trim().replace(/\s+/g, ' ');
    if (cleanName.length < 1 || cleanName.length > 40) throw new CharacterError(400, 'The character’s name must be 1 to 40 characters long.');
    if (cleanDesc.length < 15) throw new CharacterError(400, 'Describe the look in more detail: age, hair, outfit and one or two striking details.');
    if (cleanDesc.length > 600) throw new CharacterError(400, 'The description is too long. Please keep it under 600 characters.');
    if (isForbiddenDescription(`${cleanName} ${cleanDesc}`)) {
      throw new CharacterError(400, 'The character must be a fictional adult, with nothing explicit. Please change the description.');
    }
    if (!key) throw new CharacterError(402, NEED_KEY, 'falKey');
    if (store.customsOf(user.id).length >= config.maxCustomCharacters) {
      throw new CharacterError(409, `You can keep up to ${config.maxCustomCharacters} characters. Delete one on the Account tab to create a new one.`);
    }
    if (store.generationsToday(user.id) >= config.characterGenerationsPerDay) {
      throw new CharacterError(429, `You can draw up to ${config.characterGenerationsPerDay} characters a day. Please try again tomorrow.`);
    }

    store.recordGeneration(user.id);
    const id = randomUUID();
    const dest = customPath(id);
    try {
      if (config.provider === 'mock') {
        // Demo mode: take one of the bundled pictures and recolor it so it's clear the character is new
        const bases = list.map((c) => bundled(c.id)).filter(Boolean);
        if (!bases.length) throw new Error('demo mode needs at least one picture in public/characters');
        const digest = createHash('sha256').update(cleanDesc).digest();
        await fsp.mkdir(customDir, { recursive: true });
        await tintImage(bases[digest[0] % bases.length], dest, (digest[1] % 300) + 30);
      } else {
        await generateImage({ prompt: buildPhotoPrompt(cleanDesc), dest, label: `Custom character "${cleanName}"`, key });
      }
    } catch (e) {
      await removeQuietly(dest);
      log.error(`Custom character: ${e.message}`);
      const field = e.kind === 'key' || e.kind === 'balance' ? 'falKey' : undefined;
      throw new CharacterError(e.kind === 'balance' ? 402 : 502, e.userMessage || 'Couldn’t draw the character. Try again or change the description.', field);
    }
    const c = store.createCustom({ id, userId: user.id, name: cleanName, description: cleanDesc, imagePath: dest });
    return publicCustom(c);
  }

  async function deleteCustom(publicId, user) {
    const c = ownedCustom(publicId, user);
    if (!c) return false;
    store.deleteCustom(c.id, user.id);
    await removeQuietly(c.image_path);
    return true;
  }

  /** Name and reference picture for a video: a ready-made character or a custom one (owner only). */
  async function resolve(publicId, user, key = null) {
    const preset = get(publicId);
    if (preset) return { name: preset.name, refPath: () => ensureReference(preset.id, { key }) };
    const c = ownedCustom(publicId, user);
    if (c && c.image_path && fs.existsSync(c.image_path)) return { name: c.name, refPath: async () => c.image_path };
    return null;
  }

  return {
    list, get, publicList, ensureReference, warmUp, photoPath,
    customsOf, ownedCustom, createCustom, deleteCustom, resolve, CharacterError,
  };
}
