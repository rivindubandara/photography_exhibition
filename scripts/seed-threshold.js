/**
 * Push 10 threshold-themed stock images into the Airtable Photos table.
 * Usage: set AIRTABLE_TOKEN (and optional AIRTABLE_BASE_ID) then:
 *   node scripts/seed-threshold.js
 */
const path = require('path');
try {
  require('fs').readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m || process.env[m[1]]) return;
    let v = m[2]; if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  });
} catch {}

const { createPhotoFromUrl, getPhotos } = require('../api/_lib/airtable');

// Theme: threshold — doors, windows, edges, transitions, the in-between.
const PHOTOS = [
  { title: 'Ajar', url: 'https://images.unsplash.com/photo-1479839672679-a46483c0e7c8?auto=format&fit=crop&w=1600&q=80' },
  { title: 'Last Light', url: 'https://images.unsplash.com/photo-1493809842364-78817add7ffb?auto=format&fit=crop&w=1600&q=80' },
  { title: 'Crossing', url: 'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=1600&q=80' },
  { title: 'Fog Line', url: 'https://images.unsplash.com/photo-1501785888041-af3ef285b470?auto=format&fit=crop&w=1600&q=80' },
  { title: 'Half-Open', url: 'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=1600&q=80' },
  { title: 'Shore Break', url: 'https://images.unsplash.com/photo-1505142468610-359e7d316be0?auto=format&fit=crop&w=1600&q=80' },
  { title: 'Between Floors', url: 'https://images.unsplash.com/photo-1554995207-c18c203602cb?auto=format&fit=crop&w=1600&q=80' },
  { title: 'Drawn', url: 'https://images.unsplash.com/photo-1522771739844-6a9f6d5f14af?auto=format&fit=crop&w=1600&q=80' },
  { title: 'Platform Edge', url: 'https://images.unsplash.com/photo-1474487548417-781cb71495f3?auto=format&fit=crop&w=1600&q=80' },
  { title: 'After Rain', url: 'https://images.unsplash.com/photo-1428908728789-d2de25dbd4e2?auto=format&fit=crop&w=1600&q=80' },
];

async function main() {
  if (!process.env.AIRTABLE_TOKEN) {
    console.error('Set AIRTABLE_TOKEN in .env (or the environment), then re-run.');
    process.exit(1);
  }
  const before = await getPhotos();
  let start = 0;
  for (const p of before) {
    const n = parseInt(String(p.number || '').replace(/\D/g, ''), 10);
    if (n > start) start = n;
  }
  console.log(`Seeding ${PHOTOS.length} threshold photos (starting after ${String(start).padStart(3, '0') || '000'})…`);
  for (let i = 0; i < PHOTOS.length; i++) {
    const number = String(start + i + 1).padStart(3, '0');
    const { title, url } = PHOTOS[i];
    process.stdout.write(`  ${number} ${title}… `);
    try {
      const photo = await createPhotoFromUrl({
        title,
        number,
        url,
        filename: `threshold-${number}.jpg`,
      });
      console.log(`ok (${photo.id})`);
    } catch (e) {
      console.log(`FAIL: ${e.message}`);
      process.exitCode = 1;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log('Done. Refresh the gallery to see them as polaroids.');
}

main().catch((e) => { console.error(e); process.exit(1); });
