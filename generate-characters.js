// Prepares (or re-prepares) the ready-made characters' HD reference photos with fal.ai and saves them to PHOTOS_DIR
// (data/characters by default). Characters with a sheet (public/characters/<id>-sheet.jpg) are made from the sheet.
// Usage:  FAL_KEY=your_key npm run characters                 to prepare the missing ones
//         FAL_KEY=your_key npm run characters -- --force barry to redo Barry Breeze's photo
// Photos are normally prepared automatically: with the first video using a character, or at startup if FAL_KEY is set.
// This script is for redoing a photo you don't like. All users' videos will use the new photo.
process.env.PROVIDER = 'fal';

const { config, validateConfig } = await import('../src/config.js');
const { createCharacterStore } = await import('../src/characters.js');

try {
  validateConfig();
  if (!config.falKey) throw new Error('FAL_KEY is required: photos are paid with this key (about $0.08 per photo).');
} catch (e) {
  console.error(e.message);
  console.error('\nExample: FAL_KEY=your_key npm run characters');
  process.exit(1);
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter((a) => !a.startsWith('--'));
const characters = createCharacterStore(config);
const targets = only.length ? only : characters.list.map((c) => c.id);

let failed = 0;
for (const id of targets) {
  if (!characters.get(id)) {
    console.error(`No character "${id}". Available: ${characters.list.map((c) => c.id).join(', ')}`);
    failed += 1;
    continue;
  }
  try {
    const file = await characters.ensureReference(id, { force, fallback: false });
    console.log(`✓ ${id}: ${file}`);
  } catch (e) {
    console.error(`✗ ${id}: ${e.message}`);
    failed += 1;
  }
}
process.exit(failed ? 1 : 0);
