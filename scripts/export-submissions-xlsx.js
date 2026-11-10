const fs = require('fs');
const path = require('path');

try {
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) return;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  });
} catch {}

const { getPhotos, at, T, F } = require('../api/_lib/airtable');

(async () => {
  const meta = await fetch(
    `https://api.airtable.com/v0/meta/bases/${process.env.AIRTABLE_BASE_ID}/tables`,
    { headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` } },
  ).then((r) => r.json());
  const photosTable = meta.tables.find((t) => t.id === T.photos);
  console.log('PHOTO FIELDS:');
  for (const f of photosTable.fields) console.log(`  ${f.id}  ${f.name}  (${f.type})`);

  const photos = await getPhotos();
  console.log(`\nPhotos: ${photos.length}`);
  const sample = photos.find((p) => p.number === '003') || photos[0];
  console.log('Sample 003:', {
    number: sample.number,
    title: sample.title,
    submitter: sample.submitter,
    blurb: (sample.blurb || '').slice(0, 400),
  });

  // dump JSON for xlsx build
  const out = path.join(__dirname, '..', 'tmp-submissions.json');
  fs.writeFileSync(out, JSON.stringify(photos.map((p) => ({
    number: p.number,
    title: p.title,
    submitter: p.submitter,
    blurb: p.blurb || '',
    imageUrl: p.full || p.thumb || '',
  })), null, 2));
  console.log('Wrote', out);
})().catch((e) => { console.error(e); process.exit(1); });
